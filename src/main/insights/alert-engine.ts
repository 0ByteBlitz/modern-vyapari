/**
 * Local alert engine — evaluates conditions against the live Binance stream.
 *
 * Alerts use the same Condition type as strategy specs, so they're replayable
 * in backtests (identical evaluation path). Persists to the `alerts` table
 * and emits events to the renderer for the Bot Working Area UI.
 */

import { getDb, auditLog, withTransaction } from "../db/database";
import type { CandleNumeric } from "./indicator-types";
import { makeIndicatorKey } from "./indicator-types";
import { computeFromCandles } from "./indicators";
import type { Condition } from "../strategy/strategy-spec";
import { evaluateConditionGroup } from "../strategy/strategy-spec";
import { binanceWS, STREAM_SILENT_MS } from "../data/binance-ws";
import { describeThreshold } from "../../shared/levels";
import { createLogger } from "../logger";
import { ListenerRegistry } from "../events/listener-registry";
import { announceAlert } from "../notify/announce";
import { enqueueWithin } from "../notify/outbox";

const log = createLogger("alerts");

/* ── Types ──────────────────────────────────────────────────────────── */

export interface AlertRecord {
  id: number;
  session_id: number | null;
  label: string;
  /** Trading pair this alert evaluates against, e.g. "BTC-USD". */
  symbol: string;
  /** Candle interval (minutes) the condition is evaluated on. */
  intervalMin: number;
  condition: Condition;
  status: "active" | "triggered" | "dismissed";
  triggered_at: number | null;
  created_at: number;
}

export interface AlertEvent {
  alertId: number;
  label: string;
  symbol: string;
  intervalMin: number;
  condition: Condition;
  triggeredAt: number;
  currentValue: number | null;
}

/** Shape persisted in the `alerts.condition` TEXT column — bundles the
 *  scoping (symbol/interval) alongside the raw Condition so no schema
 *  migration is needed to add pair-scoping to alerts. */
interface StoredAlertCondition {
  symbol: string;
  intervalMin: number;
  condition: Condition;
}

/* ── Alert Engine ───────────────────────────────────────────────────── */

/** Callback invoked when an alert triggers. */
type AlertCallback = (event: AlertEvent) => void;

class AlertEngine {
  private listeners = new ListenerRegistry<[AlertEvent]>("alert");
  /** In-memory cache of active alerts, keyed by ID. */
  private activeAlerts = new Map<number, AlertRecord>();
  /** Recent candle buffer per symbol:interval for indicator computation. */
  private candleBuffers = new Map<string, CandleNumeric[]>();
  private readonly BUFFER_SIZE = 200;

  /** Register a callback for alert triggers. */
  onAlert(callback: AlertCallback): () => void {
    return this.listeners.add(callback);
  }

  /** Load active alerts from the DB on startup. Also (re-)establishes the
   *  live Binance subscriptions each alert needs, since those subscriptions
   *  are in-memory only and don't survive an app restart. */
  loadFromDb(): void {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, session_id, label, condition, status, triggered_at, created_at
         FROM alerts WHERE status = 'active'`
      )
      .all() as unknown as {
        id: number;
        session_id: number | null;
        label: string;
        condition: string;
        status: "active";
        triggered_at: number | null;
        created_at: number;
      }[];

    this.activeAlerts.clear();
    for (const row of rows) {
      try {
        const stored: StoredAlertCondition = JSON.parse(row.condition);
        this.activeAlerts.set(row.id, {
          id: row.id,
          session_id: row.session_id,
          label: row.label,
          symbol: stored.symbol,
          intervalMin: stored.intervalMin,
          condition: stored.condition,
          status: row.status,
          triggered_at: row.triggered_at,
          created_at: row.created_at,
        });
        binanceWS.subscribeInternal(stored.symbol, stored.intervalMin);
      } catch {
        log.error(`Failed to parse condition for alert ${row.id}`);
      }
    }
  }

  /** Add a new alert. Persists to DB, caches in memory, and keeps the
   *  relevant Binance stream alive regardless of what the UI has open. */
  addAlert(condition: Condition, label: string, symbol: string, intervalMin: number, sessionId?: number): AlertRecord {
    const db = getDb();
    const now = Date.now();
    const stored: StoredAlertCondition = { symbol, intervalMin, condition };

    const result = db
      .prepare(
        `INSERT INTO alerts (session_id, label, condition, status, created_at)
         VALUES (?, ?, ?, 'active', ?)`
      )
      .run(sessionId ?? null, label, JSON.stringify(stored), now);

    const record: AlertRecord = {
      id: Number(result.lastInsertRowid),
      session_id: sessionId ?? null,
      label,
      symbol,
      intervalMin,
      condition,
      status: "active",
      triggered_at: null,
      created_at: now,
    };

    this.activeAlerts.set(record.id, record);
    binanceWS.subscribeInternal(symbol, intervalMin);

    auditLog("alert_created", { alertId: record.id, label, symbol, intervalMin, condition });
    return record;
  }

  /** Remove (dismiss) an alert. */
  removeAlert(alertId: number): void {
    const db = getDb();
    const alert = this.activeAlerts.get(alertId);
    db.prepare("UPDATE alerts SET status = 'dismissed' WHERE id = ?").run(alertId);
    this.activeAlerts.delete(alertId);
    if (alert) binanceWS.unsubscribeInternal(alert.symbol, alert.intervalMin);
  }

  /** Get all non-dismissed alerts from database (active and triggered). */
  getSessionAlerts(sessionId?: number): AlertRecord[] {
    const db = getDb();
    const sql = sessionId
      ? `SELECT id, session_id, label, condition, status, triggered_at, created_at FROM alerts WHERE session_id = ? AND status != 'dismissed' ORDER BY created_at DESC`
      : `SELECT id, session_id, label, condition, status, triggered_at, created_at FROM alerts WHERE status != 'dismissed' ORDER BY created_at DESC`;

    const rows = (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as any[];

    return rows.map((r) => {
      let stored: any = {};
      try {
        stored = JSON.parse(r.condition);
      } catch {}
      return {
        id: r.id,
        session_id: r.session_id,
        label: r.label,
        symbol: stored.symbol || "BTC-USD",
        intervalMin: stored.intervalMin || 60,
        condition: stored.condition || stored,
        status: r.status,
        triggered_at: r.triggered_at,
        created_at: r.created_at,
      };
    });
  }

  /**
   * Evaluate active alerts against closed bars, oldest first, stopping at each
   * alert's first hit. Catches what the live check didn't see: the app closed,
   * the machine asleep, the stream down. Returns the alerts that fired.
   */
  evaluateHistoricalCandles(
    symbol: string,
    intervalMin: number,
    candles: CandleNumeric[],
    /** Per alert, the first bar start to check. Without one, bars from the
     *  alert's creation on are checked. */
    fromByAlert?: Map<number, number>
  ): Map<number, number> {
    /** Alert id → start of the bar it fired on. */
    const fired = new Map<number, number>();
    if (candles.length < 2) return fired;
    const barMs = intervalMin * 60_000;

    for (const [alertId, alert] of Array.from(this.activeAlerts.entries())) {
      if (alert.symbol !== symbol || alert.intervalMin !== intervalMin) continue;
      const from = fromByAlert?.get(alertId) ?? alert.created_at - 60_000;

      /* Replay the history bar by bar, handing each evaluation the candles that
         PRECEDE the bar as well as the bar itself.

         This used to pass `[c, c]` — the same candle as both current and
         previous. That made offline catch-up structurally incapable of doing
         its job: every `crosses_above`/`crosses_below` alert compares current
         against previous, and with the two identical no cross can ever be
         detected. Indicator alerts were worse than useless — an RSI computed
         from two copies of one bar isn't RSI, so the alert could fire on a
         number that never existed. */
      for (let i = 1; i < candles.length; i++) {
        const c = candles[i]!;
        if (c.timestamp < from || c.timestamp < alert.created_at - 60_000) continue;

        const window = candles.slice(0, i + 1);
        const triggered = this.evaluateAlert(alert.condition, symbol, window);
        if (triggered.hit) {
          const watched = this.wasLive(`${symbol}:${intervalMin}`, c.timestamp, c.timestamp + barMs);
          log.info(`[alert-engine] Closed-bar trigger for alert #${alertId} "${alert.label}" on ${symbol} @ $${c.close} (stream ${watched ? "live" : "not live"})`);
          this.triggerAlert(alertId, alert, triggered.currentValue ?? c.close, { barStart: c.timestamp, watched });
          fired.set(alertId, c.timestamp);
          break;
        }
      }
    }
    return fired;
  }

  /* When the live stream was delivering each symbol:interval, as [from, to]
     spans. A closed-bar check also runs while the stream is up, and what it
     finds there was not missed — the app was watching, the live check just
     didn't fire (indicator alerts read stream updates, not bars; the first
     update after a start or reconnect has nothing to compare with). The
     wording of the alert depends on which it was, so it is recorded rather
     than assumed. In memory: a previous run's coverage is unknown, and
     unknown reads as "not watching". */
  private liveSpans = new Map<string, Array<[number, number]>>();
  /** Silence longer than this ends a span — the feed watchdog's dead-link line. */
  private readonly LIVE_GAP_MS = STREAM_SILENT_MS;

  private noteLive(key: string, at: number): void {
    let spans = this.liveSpans.get(key);
    if (!spans) {
      spans = [];
      this.liveSpans.set(key, spans);
    }
    const last = spans[spans.length - 1];
    if (last && at - last[1] <= this.LIVE_GAP_MS) last[1] = at;
    else spans.push([at, at]);
    if (spans.length > 500) spans.splice(0, spans.length - 500);
  }

  /** Whether the live stream covered the whole of [from, to]. */
  private wasLive(key: string, from: number, to: number): boolean {
    const spans = this.liveSpans.get(key) ?? [];
    return spans.some(([a, b]) => a <= from && b >= Math.min(to, Date.now()) - this.LIVE_GAP_MS);
  }

  /**
   * Called on each new candle from the Binance WS stream.
   * Evaluates all active alerts against the updated data.
   */
  onCandle(symbol: string, intervalMin: number, candle: CandleNumeric): void {
    // Update the candle buffer
    const bufferKey = `${symbol}:${intervalMin}`;
    this.noteLive(bufferKey, Date.now());
    let buffer = this.candleBuffers.get(bufferKey);
    if (!buffer) {
      buffer = [];
      this.candleBuffers.set(bufferKey, buffer);
    }
    buffer.push(candle);
    if (buffer.length > this.BUFFER_SIZE) {
      buffer.splice(0, buffer.length - this.BUFFER_SIZE);
    }

    // Evaluate only alerts scoped to this exact symbol/interval — otherwise
    // an alert meant for BTC-USD would also fire off an unrelated ETH-USD tick.
    for (const [alertId, alert] of this.activeAlerts) {
      if (alert.symbol !== symbol || alert.intervalMin !== intervalMin) continue;
      try {
        const triggered = this.evaluateAlert(alert.condition, symbol, buffer);
        if (triggered.hit) {
          this.triggerAlert(alertId, alert, triggered.currentValue);
        }
      } catch {
        // Silently skip — indicator might need more warmup data
      }
    }
  }

  /**
   * Evaluate a single alert condition against the candle buffer.
   * Returns whether the condition is met and the current indicator value.
   */
  private evaluateAlert(
    condition: Condition,
    _symbol: string,
    candles: CandleNumeric[]
  ): { hit: boolean; currentValue: number | null } {
    if (candles.length < 2) {
      return { hit: false, currentValue: null };
    }

    /* A price condition without a field means the close. Values below are
       keyed `price::close` etc., so a field-less `price` looked up `price:`,
       found nothing, and the alert could never fire — while the agent's tool
       told it to write exactly that ("use {} for price"). Plans hit the same
       trap and set `field: "close"` explicitly (condition-intent.ts); alerts,
       including ones already saved, get it here. (2026-11-02) */
    if (condition.indicator === "price" && !condition.field) {
      condition = { ...condition, field: "close" };
    }

    const current = new Map<string, number | null>();
    const previous = new Map<string, number | null>();

    // Price/volume pseudo-indicators
    const lastCandle = candles[candles.length - 1]!;
    const prevCandle = candles[candles.length - 2]!;
    for (const field of ["open", "high", "low", "close"] as const) {
      const key = makeIndicatorKey("price", {}, field);
      current.set(key, lastCandle[field]);
      previous.set(key, prevCandle[field]);
    }
    current.set(makeIndicatorKey("volume", {}), lastCandle.volume);
    previous.set(makeIndicatorKey("volume", {}), prevCandle.volume);

    // If the condition references a real indicator, compute it
    if (condition.indicator !== "price" && condition.indicator !== "volume") {
      try {
        const result = computeFromCandles(candles, condition.indicator, condition.params || {});
        const vals = result.values;

        if (vals.length >= 2) {
          const curVal = vals[vals.length - 1];
          const prevVal = vals[vals.length - 2];

          if (curVal !== null && typeof curVal === "object" && condition.field) {
            const curObj = curVal as Record<string, number>;
            const prevObj = prevVal != null && typeof prevVal === "object" ? (prevVal as Record<string, number>) : null;
            const key = makeIndicatorKey(condition.indicator, condition.params || {}, condition.field);
            current.set(key, curObj[condition.field] ?? null);
            previous.set(key, prevObj?.[condition.field] ?? null);
          } else {
            const key = makeIndicatorKey(condition.indicator, condition.params || {}, condition.field);
            current.set(key, typeof curVal === "number" ? curVal : null);
            previous.set(key, typeof prevVal === "number" ? (prevVal as number) : null);
          }
        }
      } catch {
        return { hit: false, currentValue: null };
      }
    }

    // Wrap as a single-condition group for evaluation
    const group = { logic: "and" as const, conditions: [condition] };
    const hit = evaluateConditionGroup(group, current, previous);

    // Get the current value for display
    const key = makeIndicatorKey(
      condition.indicator,
      condition.params || {},
      condition.field
    );
    const currentValue = current.get(key) ?? null;

    return { hit, currentValue };
  }

  /** Mark an alert as triggered and notify listeners. `bar` is set when a
   *  closed bar fired it rather than the live price: its value is historical,
   *  and `watched` says whether the live stream was up for that bar. */
  private triggerAlert(
    alertId: number,
    alert: AlertRecord,
    currentValue: number | null,
    bar?: { barStart: number; watched: boolean }
  ): void {
    const now = bar?.barStart ?? Date.now();

    const cond = alert.condition;
    const measured = currentValue !== null ? (bar ? ` at ${currentValue}` : ` — now ${currentValue}`) : "";
    const barEnd = new Date(now + alert.intervalMin * 60_000).toLocaleString();
    const when = !bar
      ? ""
      : bar.watched
        ? `\nOn the ${intervalLabel(alert.intervalMin)} bar that closed at ${barEnd}.`
        : `\nOn the ${intervalLabel(alert.intervalMin)} bar that closed at ${barEnd}, while the app wasn't watching.`;
    const notification = {
      kind: "alert_triggered",
      title: `${alert.symbol} — ${bar && !bar.watched ? "missed alert" : "alert"}: ${alert.label}`,
      body:
        `${(cond?.indicator || "price").toUpperCase()} ${(cond?.operator || "").replace(/_/g, " ")} ` +
        `${describeThreshold(cond?.value)}${measured}${when}`,
      dedupeKey: `alert:${alertId}:${now}`,
    };

    /* The alert state and its durable Telegram obligation are one fact. If
       either write fails, leave it active so the next evaluation can retry. */
    try {
      const changed = withTransaction((db) => {
        const result = db
          .prepare("UPDATE alerts SET status = 'triggered', triggered_at = ? WHERE id = ?")
          .run(now, alertId);
        if (result.changes === 0) return false;
        enqueueWithin(db, notification);
        return true;
      });
      if (!changed) return;
    } catch (err) {
      log.error("Failed to commit alert trigger and notification", err);
      return;
    }

    // If attached to a session, log to journal as an observation so the AI context receives it
    if (alert.session_id) {
      try {
        const cond = alert.condition;
        const indName = (cond?.indicator || "price").toUpperCase();
        const opText = (cond?.operator || "").replace(/_/g, " ");
        const valText = describeThreshold(cond?.value);
        const valSnap = currentValue !== null ? ` (measured: ${currentValue})` : "";
        const offlineTag = !bar ? "" : bar.watched ? " (closed bar)" : " (closed bar, app not watching)";
        const text = `Alert Triggered${offlineTag}: "${alert.label}" — ${alert.symbol} ${indName} ${opText} ${valText}${valSnap}`;

        getDb()
          .prepare(
            `INSERT INTO journal (session_id, kind, content, tags, created_at)
             VALUES (?, 'observation', ?, 'alert,triggered', ?)`
          )
          .run(alert.session_id, text, now);
      } catch (err) {
        log.error("Failed to insert alert trigger journal entry:", err);
      }
    }

    // Remove from active set and release the stream if nothing else needs it
    this.activeAlerts.delete(alertId);
    binanceWS.unsubscribeInternal(alert.symbol, alert.intervalMin);

    // Notify listeners
    const event: AlertEvent = {
      alertId,
      label: alert.label,
      symbol: alert.symbol,
      intervalMin: alert.intervalMin,
      condition: alert.condition,
      triggeredAt: now,
      currentValue,
    };

    this.listeners.emit(event);

    /* Telegram and a Windows notification. Alerts reached neither until
       2026-11-02 — only the in-app toast, so an alert that fired while the
       window was minimised or the phone was elsewhere told no one. The
       dedupe key is the alert and the bar it fired on, so a replay after a
       restart can't send it twice. */
    announceAlert(notification);

    auditLog("alert_triggered", { alertId, label: alert.label, currentValue });
  }
}

/** "15m", "4h", "1d" — how the owner names a bar. */
export function intervalLabel(intervalMin: number): string {
  if (intervalMin % 1440 === 0) return `${intervalMin / 1440}d`;
  if (intervalMin % 60 === 0) return `${intervalMin / 60}h`;
  return `${intervalMin}m`;
}

/** Singleton alert engine instance. */
export const alertEngine = new AlertEngine();
