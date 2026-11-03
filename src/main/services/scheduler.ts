import { alertEngine, intervalLabel, type AlertRecord } from "../insights/alert-engine";
import { getPaperBalance } from "../paper/account";
import { getAnalysisCandles, MAX_LIMIT, type CandleDto } from "../data/analysis-candles";
import { syncRecentFromBinance } from "../insights/indicators";
import { lastBeatBeforeThisRun } from "../paper/monitor-heartbeat";
import { enqueue } from "../notify/outbox";
import { announce } from "../notify/announce";
import { binanceWS } from "../data/binance-ws";
import { getDb } from "../db/database";
import { createLogger } from "../logger";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

const log = createLogger("scheduler");

/** Bars fetched before an alert's window, so indicators have history to start from. */
const WARMUP_BARS = 100;

/* Alert id → the bar start the next closed-bar check begins at. */
const CHECKED_KEY = "alert_checked_through";

function readCheckedThrough(): Record<number, number> {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(CHECKED_KEY) as
    | { value: string }
    | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    const out: Record<number, number> = {};
    for (const [id, ms] of Object.entries(parsed)) if (typeof ms === "number" && Number.isFinite(ms)) out[Number(id)] = ms;
    return out;
  } catch {
    return {};
  }
}

function writeCheckedThrough(map: Record<number, number>): void {
  getDb()
    .prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(CHECKED_KEY, JSON.stringify(map));
}

/** The [start, end) spans of bars between `from` and `until` (bar starts,
 *  inclusive) that are missing from `starts` (ascending). */
function uncheckedSpans(starts: number[], from: number, until: number, barMs: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let expect = from;
  for (const t of starts) {
    if (t < expect) continue;
    if (t > until) break;
    if (t > expect) spans.push([expect, t]);
    expect = t + barMs;
  }
  if (expect <= until) spans.push([expect, until + barMs]);
  return spans;
}

/** Start of the first bar missing between `from` and the newest bar, or null. */
function firstHole(candles: CandleDto[], from: number, barMs: number): number | null {
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.start;
    if (candles[i]!.start - prev > barMs && candles[i]!.start > from) return Math.max(prev + barMs, from);
  }
  return null;
}

/** Tell the owner, on every channel, that an alert was not checked for a while. */
function reportUnchecked(alert: AlertRecord, spans: Array<[number, number]>): void {
  const at = (ms: number) => new Date(ms).toLocaleString();
  const listed = spans.slice(0, 3).map(([a, b]) => `${at(a)} to ${at(b)}`);
  const more = spans.length > 3 ? ` and ${spans.length - 3} more gaps` : "";
  const draft = {
    kind: "alert_unchecked",
    title: `${alert.symbol} — alert not checked: ${alert.label}`,
    body:
      `Not checked from ${listed.join(", ")}${more} (${intervalLabel(alert.intervalMin)} bars). ` +
      `If price reached the level then, this alert did not see it; look at the chart for that time.`,
    dedupeKey: `alert_unchecked:${alert.id}:${spans[0]![0]}:${spans[spans.length - 1]![1]}`,
  };
  log.warn(`[scheduler] Alert #${alert.id} not checked: ${listed.join(", ")}${more}`);
  enqueue(draft);
  announce(draft);
}

export class BackgroundSchedulerService {
  private alertCheckTimer: NodeJS.Timeout | null = null;
  private equitySnapshotTimer: NodeJS.Timeout | null = null;
  private feedWatchdogTimer: NodeJS.Timeout | null = null;
  /** The one-shot startup catch-up. `stop()` used to leave this running, so it
   *  fired ~5s after a "stopped" scheduler and queried a database that had
   *  already gone away. A stop that doesn't stop everything is worse than no
   *  stop, because the caller believes teardown is complete. */
  private startupCatchUpTimer: NodeJS.Timeout | null = null;
  private dailyReviewCatchUpTimer: NodeJS.Timeout | null = null;
  private reviewCatchUpInFlight = false;
  private active = false;

  public start(): void {
    if (this.active) return;
    this.active = true;
    log.info("Background Job Scheduler STARTED.");

    // Job 1: Missed Event & Alert Watchdog (every 3 minutes)
    this.alertCheckTimer = setInterval(() => void this.runMissedAlertCheck(), 3 * 60 * 1000);

    // Job 2: Portfolio Equity Snapshot (every 1 hour)
    this.equitySnapshotTimer = setInterval(() => void this.takeEquitySnapshot(), 60 * 60 * 1000);

    // Job 3: Feed Health & Reconnect Watchdog (every 30 seconds)
    this.feedWatchdogTimer = setInterval(() => void this.checkFeedHealth(), 30 * 1000);

    // Run initial catch-up check on startup after a 5s delay
    this.startupCatchUpTimer = setTimeout(() => {
      this.startupCatchUpTimer = null;
      void this.runMissedAlertCheck();
    }, 5000);

    this.scheduleDailyReviewCatchUp();
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;

    if (this.alertCheckTimer) clearInterval(this.alertCheckTimer);
    if (this.equitySnapshotTimer) clearInterval(this.equitySnapshotTimer);
    if (this.feedWatchdogTimer) clearInterval(this.feedWatchdogTimer);
    if (this.startupCatchUpTimer) clearTimeout(this.startupCatchUpTimer);
    if (this.dailyReviewCatchUpTimer) clearTimeout(this.dailyReviewCatchUpTimer);

    this.alertCheckTimer = null;
    this.equitySnapshotTimer = null;
    this.feedWatchdogTimer = null;
    this.startupCatchUpTimer = null;
    this.dailyReviewCatchUpTimer = null;

    log.info("Background Job Scheduler STOPPED.");
  }

  /** Retry deferred AI reviews when the local-day spending window resets. */
  private scheduleDailyReviewCatchUp(): void {
    const nextReset = new Date();
    nextReset.setHours(24, 0, 0, 25);
    this.dailyReviewCatchUpTimer = setTimeout(() => {
      this.dailyReviewCatchUpTimer = null;
      if (!this.active) return;
      void this.retryPendingReviews().finally(() => {
        if (this.active) this.scheduleDailyReviewCatchUp();
      });
    }, Math.max(1, nextReset.getTime() - Date.now()));
  }

  /** Run the existing sequential catch-up after the owner changes the limit. */
  public async retryPendingReviews(): Promise<void> {
    if (this.reviewCatchUpInFlight) return;
    this.reviewCatchUpInFlight = true;
    try {
      const { reviewPendingPositions, reviewPendingPlans } = require("../agent/review") as typeof import("../agent/review");
      await reviewPendingPositions();
      await reviewPendingPlans();
    } catch (err) {
      log.error("Deferred AI review catch-up failed", err);
    } finally {
      this.reviewCatchUpInFlight = false;
    }
  }

  /**
   * Job 1: check every closed bar each active alert has not been checked on.
   *
   * Each alert's window runs from where the last check ended — persisted, so it
   * survives a restart — up to the last closed bar. An alert with no record
   * yet starts from when the previous run was last alive, or from its
   * creation. This used to be a fixed 100 bars: 100 minutes for a 1m alert,
   * so a crossing earlier in a night's closure was missed without a word.
   *
   * What the feed cannot serve (more than `MAX_LIMIT` bars back) or did not
   * return (holes in the series) is reported to the owner as unchecked, with
   * its times — never left to read as "price never came".
   */
  public async runMissedAlertCheck(): Promise<number> {
    const activeAlerts = alertEngine.getSessionAlerts();
    const activeRules = activeAlerts.filter((a) => a.status === "active");

    if (activeRules.length === 0) return 0;

    log.info(`[scheduler] Checking closed bars for ${activeRules.length} active alert rules...`);
    let checkedCount = 0;
    const checkedThrough = readCheckedThrough();
    const lastAlive = lastBeatBeforeThisRun();
    const now = Date.now();

    // Group rules by symbol & interval
    const targets = new Map<string, { symbol: string; intervalMin: number; alerts: AlertRecord[] }>();
    for (const rule of activeRules) {
      const key = `${rule.symbol}:${rule.intervalMin}`;
      let target = targets.get(key);
      if (!target) {
        target = { symbol: rule.symbol, intervalMin: rule.intervalMin, alerts: [] };
        targets.set(key, target);
      }
      target.alerts.push(rule);
    }

    for (const { symbol, intervalMin, alerts } of targets.values()) {
      const barMs = intervalMin * 60_000;
      // Start of the newest bar that has closed.
      const lastClosed = Math.floor(now / barMs) * barMs - barMs;

      const fromByAlert = new Map<number, number>();
      for (const a of alerts) {
        /* A bar the previous run was in the middle of is checked again: its
           close came after the app stopped watching. */
        const fromRun = lastAlive !== null ? Math.floor(lastAlive / barMs) * barMs : -Infinity;
        const fromCreated = Math.ceil((a.created_at - 60_000) / barMs) * barMs;
        const from = checkedThrough[a.id] ?? Math.max(fromRun, fromCreated);
        fromByAlert.set(a.id, from);
        /* Saved before anything can fail: the previous run's end is readable
           only in this run, so a failed first check must not lose it. */
        checkedThrough[a.id] = from;
      }
      const earliest = Math.min(...fromByAlert.values());

      try {
        if (earliest <= lastClosed) {
          // The window, the bars before it the indicators need, and the forming bar.
          const wanted = Math.min((lastClosed - earliest) / barMs + 1 + WARMUP_BARS + 1, MAX_LIMIT);
          let candlesDto = await getAnalysisCandles(symbol, intervalMin, wanted);
          /* The cache is written by the stream while the app runs, so a stream
             outage leaves holes the feed can still fill. Fill them once before
             any is reported as unchecked. */
          const hole = firstHole(candlesDto, earliest, barMs);
          if (hole !== null) {
            await syncRecentFromBinance(symbol, intervalMin, hole);
            candlesDto = await getAnalysisCandles(symbol, intervalMin, wanted);
          }
          const closed = candlesDto
            .filter((c) => c.start <= lastClosed)
            .map((c) => ({
              timestamp: c.start,
              open: parseFloat(c.open),
              high: parseFloat(c.high),
              low: parseFloat(c.low),
              close: parseFloat(c.close),
              volume: parseFloat(c.volume),
            }));

          const fired = alertEngine.evaluateHistoricalCandles(symbol, intervalMin, closed, fromByAlert);

          /* Checked up to the newest bar the feed returned. Bars after it are
             not reported: the feed has not caught up (offline, slow sync) and
             the next run checks them. Bars before the oldest one returned, or
             missing between two, will not come back — those are reported. */
          const newest = closed.length > 1 ? closed[closed.length - 1]!.timestamp : null;
          for (const a of alerts) {
            const from = fromByAlert.get(a.id)!;
            if (newest === null || from > newest) continue;
            const until = fired.get(a.id) ?? newest;
            // The first bar has nothing before it to compare with, so it is not checked.
            const holes = uncheckedSpans(closed.slice(1).map((c) => c.timestamp), from, until, barMs);
            if (holes.length > 0) reportUnchecked(a, holes);
            checkedThrough[a.id] = newest + barMs;
          }
        }
        checkedCount++;
      } catch (err) {
        /* Nothing recorded as checked, so the next run covers this window too —
           and reports it if it has grown past what the feed can serve. */
        log.error(`Failed missed alert check for ${symbol} ${intervalMin}m`, err);
      }
    }

    const active = new Set(activeRules.map((a) => a.id));
    for (const id of Object.keys(checkedThrough)) if (!active.has(Number(id))) delete checkedThrough[Number(id)];
    writeCheckedThrough(checkedThrough);

    return checkedCount;
  }

  /**
   * Job 2: Periodic portfolio equity snapshot into SQLite journal for continuous performance tracking.
   */
  public takeEquitySnapshot(): void {
    const db = getDb();
    const now = Date.now();

    try {
      const activeSessions = db
        .prepare(`SELECT id, pair, paper_balance FROM sessions WHERE status = 'active'`)
        .all() as any[];

      for (const sess of activeSessions) {
        const cash = getPaperBalance();

        const openPositions = db
          .prepare(`SELECT symbol, quantity, entry_price FROM paper_positions WHERE session_id = ? AND status = 'open'`)
          .all(sess.id) as any[];

        /* Mark open positions to the LAST CACHED PRICE, not the entry price.
           Marking at entry made the number a lie in the one situation the
           snapshot exists for: a position moving. Equity stayed pinned at the
           value it had when the trade opened, so an hour of drawdown recorded
           as a flat line — and this series is meant to be the record you check
           after being away. Where no cached price exists the position is marked
           at entry and the entry says so, rather than silently pretending. */
        let openVal = 0;
        let unpriced = 0;
        for (const pos of openPositions) {
          const mark = this.lastKnownPrice(pos.symbol);
          if (mark === null) unpriced++;
          openVal += parseFloat(pos.quantity) * (mark ?? parseFloat(pos.entry_price));
        }

        const totalEquity = cash + openVal;
        const openNote = openPositions.length
          ? ` · ${openPositions.length} open marked to last price` +
            (unpriced > 0 ? `, ${unpriced} at entry (no recent price)` : "")
          : "";

        db.prepare(
          `INSERT INTO journal (session_id, kind, content, tags, created_at)
           VALUES (?, 'observation', ?, 'equity,snapshot,automated', ?)`
        ).run(
          sess.id,
          `Hourly Equity Snapshot (${sess.pair}): Total $${totalEquity.toFixed(2)} (cash $${cash.toFixed(2)})${openNote}`,
          now
        );
      }
      log.info(`[scheduler] Equity snapshots recorded for ${activeSessions.length} active sessions.`);
    } catch (err) {
      log.error("Failed to record hourly equity snapshot", err);
    }
  }

  /** Latest cached analysis-feed close for a symbol, or null if there is none.
   *  Any interval's close is a real traded price, so the newest bar across
   *  intervals is the best available mark. */
  private lastKnownPrice(symbol: string): number | null {
    const row = getDb()
      .prepare(
        `SELECT close FROM candles
         WHERE symbol = ? AND ${FEED_SCOPE_SQL}
         ORDER BY start_ms DESC LIMIT 1`
      )
      .get(symbol) as { close: string } | undefined;

    if (!row) return null;
    const n = parseFloat(row.close);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Job 3: Connection health check.
   */
  public checkFeedHealth(): void {
    /* Only step in when the feed is genuinely down AND something needs it.
       The old check was `if (!isConnected()) reconnect()` every 30s, which was
       wrong three ways:

         • With nothing subscribed there is no socket by design, so an idle app
           dialled Binance every 30 seconds to hold a stream carrying nothing.
         • `readyState === CONNECTING` also reads as "not connected", and
           `reconnect()` force-closes first — so on a slow link every handshake
           was killed at the 30s mark and restarted, potentially never
           completing.
         • Each forced close fires `onclose`, which schedules the socket's own
           5s backoff reconnect — so the watchdog raced the retry it triggered.

       The socket already reconnects itself on close. The watchdog's job is only
       to catch the case where it somehow has no socket and no pending retry. */
    if (!this.active) return;
    if (!binanceWS.hasSubscribers()) return;
    /* Open but silent: a half-open connection reports itself connected and
       never closes, so the socket's own reconnect never runs. Binance pushes
       updates every couple of seconds, so a minute of nothing is a dead link. */
    const silentMs = binanceWS.msSinceLastMessage();
    if (silentMs !== null && silentMs > 60_000) {
      log.warn(`[scheduler] Binance WS open but silent for ${Math.round(silentMs / 1000)}s — reconnecting...`);
      binanceWS.reconnect();
      return;
    }
    if (binanceWS.isConnected() || binanceWS.isConnecting()) return;
    if (binanceWS.isReconnectPending()) return;

    log.warn("[scheduler] Binance WS feed down with no retry pending — reconnecting...");
    binanceWS.reconnect();
  }
}

export const backgroundScheduler = new BackgroundSchedulerService();
