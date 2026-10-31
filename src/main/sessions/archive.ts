/**
 * Archiving a session, as a wind-down rather than a status flip.
 *
 * A session isn't just a row — it owns open paper positions, armed strategies
 * that are consuming live candle streams, and alerts that are still evaluating.
 * Flipping `status` alone leaves all of that in an incoherent state: the
 * positions never close (so realised PnL stays wrong forever), the strategies read as
 * "armed" while being unable to trade, and the alert subscriptions leak.
 *
 * So archive is an ordered sequence of real operations, each of which is
 * reported to the UI as it happens. The order matters:
 *
 *   1. close positions   — must happen while the session is still active, so
 *                          the engine's own close path (fees, PnL, review
 *                          listener) runs exactly as it would normally
 *   2. retire strategies — nothing can arm afterwards
 *   3. clear alerts      — releases their stream subscriptions
 *   4. release streams   — engine reload drops what's no longer wanted
 *   5. archive           — the status flip, last, once nothing is live
 *
 * If a step fails the sequence STOPS and the session stays as it was. A
 * half-archived session is worse than an un-archived one: you'd believe it was
 * wound down when something is still running.
 */

import { getDb, auditLog } from "../db/database";
import { AppError } from "../../shared/errors";
import { createLogger } from "../logger";
import type { ArchivePlan, ArchiveStepId, ArchiveSummary } from "../../shared/ipc-types";
import { getSessionById, setSessionStatus } from "./service";
import { listStrategies, setStrategyState } from "../strategy/strategy-service";
import { DEFAULT_BACKTEST_CONFIG } from "../backtest/backtest-types";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

/** Same taker fee the paper engine and backtester use — never a local copy. */
const FEE_RATE = DEFAULT_BACKTEST_CONFIG.feeRateTakerBps / 10_000;

const log = createLogger("archive");

export type StepReporter = (step: ArchiveStepId, status: "running" | "done" | "failed", detail?: string) => void;

/* ── Preflight ──────────────────────────────────────────────────────── */

/**
 * What archiving this session would actually do, computed from the DB so the
 * confirmation screen states facts rather than a generic warning. Unrealised
 * PnL is included because closing a position turns it into realised PnL — the
 * one genuinely irreversible consequence of the whole operation.
 */
export function planArchive(sessionId: number): ArchivePlan {
  const db = getDb();
  const session = getSessionById(sessionId);
  if (!session) throw new AppError("NOT_FOUND", "That session no longer exists.");

  const openRows = db
    .prepare(
      `SELECT p.id, p.symbol, p.quantity, p.entry_price, p.stop_price, p.target_price, p.opened_at,
              s.name AS strategy_name
       FROM paper_positions p
       LEFT JOIN strategies s ON s.id = p.strategy_id
       WHERE p.session_id = ? AND p.status = 'open'
       ORDER BY p.opened_at ASC`
    )
    .all(sessionId) as unknown as {
    id: number;
    symbol: string;
    quantity: string;
    entry_price: string;
    stop_price: string | null;
    target_price: string | null;
    opened_at: number;
    strategy_name: string | null;
  }[];

  const openPositions = openRows.map((r) => {
    const last = lastKnownPrice(r.symbol);
    const qty = parseFloat(r.quantity);
    const entry = parseFloat(r.entry_price);
    return {
      id: r.id,
      symbol: r.symbol,
      strategyName: r.strategy_name ?? "(deleted strategy)",
      quantity: r.quantity,
      entryPrice: r.entry_price,
      lastPrice: last !== null ? String(last) : null,
      /* Marked to the last analysis-feed price and net of the exit fee it will
         pay — a gross figure would overstate what you actually keep. */
      unrealizedPnl: last !== null ? (last - entry) * qty - last * qty * FEE_RATE : null,
      openedAt: r.opened_at,
    };
  });

  const strategies = listStrategies(sessionId);
  const alerts = db
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE session_id = ? AND status = 'active'")
    .get(sessionId) as { n: number } | undefined;
  const journal = db
    .prepare("SELECT COUNT(*) AS n FROM journal WHERE session_id = ?")
    .get(sessionId) as { n: number } | undefined;
  const closed = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(realized_pnl AS REAL)), 0) AS pnl
       FROM paper_positions WHERE session_id = ? AND status = 'closed'`
    )
    .get(sessionId) as { n: number; pnl: number } | undefined;

  return {
    sessionId,
    pair: session.pair,
    status: session.status,
    openPositions,
    armedStrategies: strategies.filter((s) => s.state === "paper").length,
    retirableStrategies: strategies.filter((s) => s.state !== "retired").length,
    totalStrategies: strategies.length,
    activeAlerts: alerts?.n ?? 0,
    journalEntries: journal?.n ?? 0,
    closedTrades: closed?.n ?? 0,
    realizedPnl: closed?.pnl ?? 0,
  };
}

/** Latest cached analysis-feed close for a symbol, or null if we have none. */
function lastKnownPrice(symbol: string): number | null {
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

/* ── Execute ────────────────────────────────────────────────────────── */

export async function archiveSession(sessionId: number, report: StepReporter): Promise<ArchiveSummary> {
  const db = getDb();
  const session = getSessionById(sessionId);
  if (!session) throw new AppError("NOT_FOUND", "That session no longer exists.");
  if (session.status === "archived") {
    throw new AppError("VALIDATION", "That session is already archived.");
  }

  const { paperEngine } = require("../paper/paper-exchange") as typeof import("../paper/paper-exchange");
  const { alertEngine } = require("../insights/alert-engine") as typeof import("../insights/alert-engine");

  const summary: ArchiveSummary = { sessionId, pair: session.pair, closed: 0, retired: 0, alertsCleared: 0, realizedOnClose: 0 };

  /* ── 1. Close open positions ── */
  report("close_positions", "running");
  try {
    const open = db
      .prepare("SELECT id, symbol FROM paper_positions WHERE session_id = ? AND status = 'open'")
      .all(sessionId) as unknown as { id: number; symbol: string }[];

    for (const pos of open) {
      const price = lastKnownPrice(pos.symbol);
      if (price === null) {
        /* Never invent a fill price. Closing at the entry price would fabricate
           a flat trade and quietly corrupt the performance record this whole
           app exists to produce. */
        throw new AppError(
          "MARKET_DATA",
          `No recent price for ${pos.symbol}, so its open position can't be closed.`,
          { hint: "Open Research for that pair to refresh its candles, then try again." }
        );
      }
      /* `session_archived`, not `manual`: the review agent and the promotion
         gate both need to know this exit was an operator wind-down rather than
         anything the strategy chose. */
      const result = paperEngine.closePositionForShutdown(pos.id, price, "session_archived");
      if (!result) throw new AppError("INTERNAL", `Couldn't close position #${pos.id}.`);
      summary.closed += 1;
      summary.realizedOnClose += result.realizedPnl;
    }
    report("close_positions", "done", summary.closed === 0 ? "none open" : `${summary.closed} closed`);
  } catch (err) {
    log.error("archive: closing positions failed", err);
    report("close_positions", "failed", err instanceof AppError ? err.userMessage : "Couldn't close the open positions.");
    throw err;
  }

  /* ── 2. Retire strategies ── */
  report("retire_strategies", "running");
  try {
    for (const strat of listStrategies(sessionId)) {
      if (strat.state === "retired") continue;
      setStrategyState(strat.id, "retired");
      summary.retired += 1;
    }
    report("retire_strategies", "done", summary.retired === 0 ? "none to retire" : `${summary.retired} retired`);
  } catch (err) {
    log.error("archive: retiring strategies failed", err);
    report("retire_strategies", "failed", "Couldn't retire the strategies.");
    throw err;
  }

  /* ── 3. Clear alerts ── */
  report("clear_alerts", "running");
  try {
    // In-memory first so the engine releases each alert's stream subscription…
    for (const alert of alertEngine.getSessionAlerts(sessionId)) {
      alertEngine.removeAlert(alert.id);
      summary.alertsCleared += 1;
    }
    // …then a DB sweep, in case rows exist that the engine never loaded.
    const swept = db
      .prepare("UPDATE alerts SET status = 'dismissed' WHERE session_id = ? AND status = 'active'")
      .run(sessionId);
    summary.alertsCleared += Number(swept.changes ?? 0);
    report("clear_alerts", "done", summary.alertsCleared === 0 ? "none active" : `${summary.alertsCleared} cleared`);
  } catch (err) {
    log.error("archive: clearing alerts failed", err);
    report("clear_alerts", "failed", "Couldn't clear the alerts.");
    throw err;
  }

  /* ── 4. Release the live data streams ── */
  report("release_streams", "running");
  try {
    paperEngine.reloadStrategies();
    report("release_streams", "done");
  } catch (err) {
    log.error("archive: releasing streams failed", err);
    report("release_streams", "failed", "Couldn't stop the live data subscriptions.");
    throw err;
  }

  /* ── 5. Flip the status, last ── */
  report("archive_session", "running");
  try {
    setSessionStatus(sessionId, "archived");
    report("archive_session", "done");
  } catch (err) {
    log.error("archive: status change failed", err);
    report("archive_session", "failed", err instanceof AppError ? err.userMessage : "Couldn't archive the session.");
    throw err;
  }

  auditLog("session_archived", {
    sessionId,
    pair: session.pair,
    positionsClosed: summary.closed,
    strategiesRetired: summary.retired,
    alertsCleared: summary.alertsCleared,
    realizedOnClose: summary.realizedOnClose,
  });
  log.info(
    `Archived ${session.pair}: ${summary.closed} positions closed, ${summary.retired} strategies retired, ` +
      `${summary.alertsCleared} alerts cleared.`
  );

  return summary;
}
