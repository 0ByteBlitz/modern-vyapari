import { alertEngine } from "../insights/alert-engine";
import { getPaperBalance } from "../paper/account";
import { getAnalysisCandles } from "../data/analysis-candles";
import { binanceWS } from "../data/binance-ws";
import { getDb } from "../db/database";
import { createLogger } from "../logger";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

const log = createLogger("scheduler");

export class BackgroundSchedulerService {
  private alertCheckTimer: NodeJS.Timeout | null = null;
  private equitySnapshotTimer: NodeJS.Timeout | null = null;
  private feedWatchdogTimer: NodeJS.Timeout | null = null;
  /** The one-shot startup catch-up. `stop()` used to leave this running, so it
   *  fired ~5s after a "stopped" scheduler and queried a database that had
   *  already gone away. A stop that doesn't stop everything is worse than no
   *  stop, because the caller believes teardown is complete. */
  private startupCatchUpTimer: NodeJS.Timeout | null = null;
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
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;

    if (this.alertCheckTimer) clearInterval(this.alertCheckTimer);
    if (this.equitySnapshotTimer) clearInterval(this.equitySnapshotTimer);
    if (this.feedWatchdogTimer) clearInterval(this.feedWatchdogTimer);
    if (this.startupCatchUpTimer) clearTimeout(this.startupCatchUpTimer);

    this.alertCheckTimer = null;
    this.equitySnapshotTimer = null;
    this.feedWatchdogTimer = null;
    this.startupCatchUpTimer = null;

    log.info("Background Job Scheduler STOPPED.");
  }

  /**
   * Job 1: Periodic check for missed price alerts across all active alert pairs.
   */
  public async runMissedAlertCheck(): Promise<number> {
    const activeAlerts = alertEngine.getSessionAlerts();
    const activeRules = activeAlerts.filter((a) => a.status === "active");

    if (activeRules.length === 0) return 0;

    log.info(`[scheduler] Checking for missed offline events across ${activeRules.length} active alert rules...`);
    let checkedCount = 0;

    // Group rules by symbol & interval
    const targets = new Map<string, { symbol: string; intervalMin: number }>();
    for (const rule of activeRules) {
      const key = `${rule.symbol}:${rule.intervalMin}`;
      if (!targets.has(key)) {
        targets.set(key, { symbol: rule.symbol, intervalMin: rule.intervalMin });
      }
    }

    for (const { symbol, intervalMin } of targets.values()) {
      try {
        const candlesDto = await getAnalysisCandles(symbol, intervalMin, 100);
        const numericCandles = candlesDto.map((c) => ({
          timestamp: c.start,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
          volume: parseFloat(c.volume),
        }));

        alertEngine.evaluateHistoricalCandles(symbol, intervalMin, numericCandles);
        checkedCount++;
      } catch (err) {
        log.error(`Failed missed alert check for ${symbol} ${intervalMin}m`, err);
      }
    }

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
    if (binanceWS.isConnected() || binanceWS.isConnecting()) return;
    if (binanceWS.isReconnectPending()) return;

    log.warn("[scheduler] Binance WS feed down with no retry pending — reconnecting...");
    binanceWS.reconnect();
  }
}

export const backgroundScheduler = new BackgroundSchedulerService();
