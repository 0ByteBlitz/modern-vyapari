/**
 * Read layer over `paper_positions` for the UI (plan surface 4/5).
 *
 * Read-only by design: nothing here opens, closes, or mutates a position —
 * the paper engine owns all writes. These are queries for charting, the
 * dashboard, and the review agent.
 */
import { getDb } from "../db/database";
import { getPaperBalance } from "./account";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";
import type { PaperPositionRecord, PaperStats, PaperEquityPoint, PaperVsBacktestComparison } from "../../shared/ipc-types";

// Shapes live in the shared IPC contract so main and renderer cannot drift.
export type { PaperPositionRecord, PaperStats, PaperEquityPoint, PaperVsBacktestComparison };

/* Both owners are joined, because schema v15 makes exactly one of them present
   and the reader needs to know WHICH thing put this position on. A plan-owned
   position with a blank owner column reads as an orphan — and the plan is the
   only thing that explains why the position exists at all. */
const SELECT = `
  SELECT p.id, p.session_id, p.strategy_id, s.name AS strategy_name, p.symbol, p.side,
         p.plan_branch_id, tp.id AS plan_id, tp.slug AS plan_name, b.label AS branch_name,
         p.entry_price, p.quantity, p.entry_fee, p.stop_price, p.target_price, p.status,
         p.exit_price, p.exit_reason, p.realized_pnl, p.fees_total,
         p.opened_at, p.closed_at, p.reviewed
  FROM paper_positions p
  LEFT JOIN strategies s ON s.id = p.strategy_id
  LEFT JOIN plan_branches b ON b.id = p.plan_branch_id
  LEFT JOIN trade_plans tp ON tp.id = b.plan_id
`;

/** Positions for a session, newest first. Optionally narrowed to one strategy. */
export function listPaperPositions(
  sessionId: number,
  opts: { strategyId?: number; limit?: number } = {}
): PaperPositionRecord[] {
  const limit = opts.limit ?? 200;

  if (opts.strategyId !== undefined) {
    return getDb()
      .prepare(`${SELECT} WHERE p.session_id = ? AND p.strategy_id = ? ORDER BY p.opened_at DESC LIMIT ?`)
      .all(sessionId, opts.strategyId, limit) as unknown as PaperPositionRecord[];
  }

  return getDb()
    .prepare(`${SELECT} WHERE p.session_id = ? ORDER BY p.opened_at DESC LIMIT ?`)
    .all(sessionId, limit) as unknown as PaperPositionRecord[];
}


/** Aggregate paper performance for a session. */
export function getPaperStats(sessionId: number): PaperStats {
  const db = getDb();

  const agg = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
         SUM(CASE WHEN status = 'closed' AND CAST(realized_pnl AS REAL) > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN status = 'closed' AND CAST(realized_pnl AS REAL) <= 0 THEN 1 ELSE 0 END) AS losses,
         COALESCE(SUM(CASE WHEN status = 'closed' THEN CAST(realized_pnl AS REAL) ELSE 0 END), 0) AS pnl,
         COALESCE(SUM(CAST(COALESCE(fees_total, entry_fee) AS REAL)), 0) AS fees
       FROM paper_positions WHERE session_id = ?`
    )
    .get(sessionId) as any;

  const closed = agg?.closed_count || 0;
  const wins = agg?.wins || 0;

  return {
    openCount: agg?.open_count || 0,
    closedCount: closed,
    wins,
    losses: agg?.losses || 0,
    winRate: closed > 0 ? (wins / closed) * 100 : 0,
    realizedPnl: agg?.pnl || 0,
    totalFees: agg?.fees || 0,
    cashBalance: getPaperBalance(),
  };
}

/**
 * The session's P&L over time, marked to market.
 *
 * ## Two things changed here, and both were the same defect
 *
 * It plotted **cash at each close**, so the line only moved when a position
 * closed — an open position that had doubled looked identical to no position at
 * all. And it anchored each session's curve at the account's starting balance,
 * so with three sessions every chart began at 10,000 and they summed to 30,000:
 * the minted-money bug reappearing in the chart after being removed from the
 * table.
 *
 * So the curve is **cumulative P&L from zero**, not equity from a balance. A
 * session is a workspace, not an account — its honest curve is what its trading
 * did, and those compose by addition. Account value lives on the portfolio,
 * where there is exactly one of it.
 *
 * ## Marks
 *
 * From the **analysis feed**, the same source the engine fills against. Bars
 * are the clock: at each bar, realised is every position closed by then and
 * unrealised is every position still open, valued at that bar's close. A
 * position with no bar simply does not contribute an unrealised figure at that
 * instant rather than contributing a fabricated one.
 */
export function getPaperEquityCurve(sessionId: number): PaperEquityPoint[] {
  const db = getDb();
  const session = db.prepare("SELECT created_at, pair FROM sessions WHERE id = ?").get(sessionId) as
    | { created_at: number; pair: string }
    | undefined;
  if (!session) return [];

  const positions = db
    .prepare(
      `SELECT opened_at, closed_at, entry_price, quantity, realized_pnl, status
       FROM paper_positions WHERE session_id = ? ORDER BY opened_at ASC`
    )
    .all(sessionId) as Array<{
    opened_at: number;
    closed_at: number | null;
    entry_price: string;
    quantity: string;
    realized_pnl: string | null;
    status: string;
  }>;

  const zero: PaperEquityPoint = {
    timestamp: session.created_at,
    cashBalance: 0,
    realizedPnl: 0,
    unrealisedPnl: 0,
    pnl: 0,
  };
  if (positions.length === 0) return [zero];

  /* The finest cached interval that actually covers the window. Preferring a
     fine one makes the line breathe; falling back keeps it drawable on a pair
     that has only daily history rather than returning nothing. */
  const from = positions[0]!.opened_at;
  let bars: Array<{ t: number; close: number }> = [];
  for (const interval of [60, 240, 1440]) {
    const rows = db
      .prepare(
        `SELECT start_ms AS t, CAST(close AS REAL) AS close FROM candles
         WHERE symbol = ? AND ${FEED_SCOPE_SQL} AND interval_min = ? AND start_ms >= ?
         ORDER BY start_ms ASC`
      )
      .all(session.pair, interval, from) as Array<{ t: number; close: number }>;
    if (rows.length >= 2) {
      bars = rows;
      break;
    }
  }

  /* No feed for this pair (a non-USD quote, say). Fall back to a step at each
     close — less informative, and honest about what it is rather than empty. */
  if (bars.length === 0) {
    const out: PaperEquityPoint[] = [zero];
    let realised = 0;
    for (const p of positions) {
      if (p.closed_at === null) continue;
      realised += parseFloat(p.realized_pnl || "0");
      out.push({ timestamp: p.closed_at, cashBalance: 0, realizedPnl: realised, unrealisedPnl: 0, pnl: realised });
    }
    return out;
  }

  /* Bounded: a year of hourly bars is 8,760 points for a 400px sparkline. */
  const MAX_POINTS = 240;
  const step = Math.max(1, Math.ceil(bars.length / MAX_POINTS));

  const out: PaperEquityPoint[] = [zero];
  for (let i = 0; i < bars.length; i += step) {
    const bar = bars[i]!;
    let realised = 0;
    let unrealised = 0;
    for (const p of positions) {
      const qty = parseFloat(p.quantity);
      const entry = parseFloat(p.entry_price);
      if (!Number.isFinite(qty) || !Number.isFinite(entry)) continue;
      if (p.closed_at !== null && p.closed_at <= bar.t) {
        realised += parseFloat(p.realized_pnl || "0");
      } else if (p.opened_at <= bar.t) {
        unrealised += (bar.close - entry) * qty;
      }
    }
    out.push({
      timestamp: bar.t,
      cashBalance: 0,
      realizedPnl: realised,
      unrealisedPnl: unrealised,
      pnl: realised + unrealised,
    });
  }
  return out;
}

/** Strategy paper vs backtest comparison and overfitting divergence detector. */
export function getStrategyComparisons(sessionId: number): PaperVsBacktestComparison[] {
  const db = getDb();

  const strategies = db
    .prepare(`SELECT id, name, state, backtest_count, spec_json FROM strategies WHERE session_id = ? AND state != 'retired'`)
    .all(sessionId) as { id: number; name: string; state: string; backtest_count: number; spec_json: string }[];

  const result: PaperVsBacktestComparison[] = [];

  for (const s of strategies) {
    /* The expectation comes from the strategy's own most recent completed
       backtest.

       It used to be regex-scraped out of a `backtest_review` journal entry —
       and nothing in the codebase ever writes that kind (only the chat agent
       could, in free prose, via `write_journal`). So `expectedWinRate` was
       null in every real installation: the card rendered "—" for the backtest
       column and `overfittingWarning` was unreachable code. The whole
       early-warning feature was dead, and dead in the quiet way — it rendered
       a tidy panel that simply never had anything to say.

       Out-of-sample is the honest expectation where walk-forward ran: the
       in-sample figure is the number the spec was shaped against, so comparing
       paper to it would flatter or damn the strategy for the wrong reason. */
    let expectedWinRate: number | null = null;
    let expectedPnl: number | null = null;

    const latestBacktest = db
      .prepare(
        `SELECT result_json FROM backtests
         WHERE strategy_id = ? AND status = 'completed' AND result_json IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(s.id) as { result_json: string } | undefined;

    if (latestBacktest) {
      try {
        const result = JSON.parse(latestBacktest.result_json) as {
          inSample?: { winRate?: number; netPnl?: number };
          outOfSample?: { winRate?: number; netPnl?: number; totalTrades?: number } | null;
        };
        const oos = result.outOfSample;
        const reference = oos && (oos.totalTrades ?? 0) > 0 ? oos : result.inSample;
        if (reference && typeof reference.winRate === "number") expectedWinRate = reference.winRate;
        if (reference && typeof reference.netPnl === "number") expectedPnl = reference.netPnl;
      } catch {
        // A malformed result row is not a reason to fail the whole panel.
      }
    }

    /* Operator exits (`manual`, `session_archived`) are excluded from the trade
       count and win rate: this comparison is evidence about the strategy's
       edge, and an administrative wind-down says nothing about the setup.
       Realised PnL still counts every exit — the money moved either way. */
    const paperAgg = db
      .prepare(
        `SELECT
           SUM(CASE WHEN exit_reason NOT IN ('manual','session_archived') THEN 1 ELSE 0 END) AS total,
           SUM(CASE WHEN exit_reason NOT IN ('manual','session_archived')
                     AND CAST(realized_pnl AS REAL) > 0 THEN 1 ELSE 0 END) AS wins,
           COALESCE(SUM(CAST(realized_pnl AS REAL)), 0) AS pnl
         FROM paper_positions WHERE session_id = ? AND strategy_id = ? AND status = 'closed'`
      )
      .get(sessionId, s.id) as { total: number; wins: number; pnl: number };

    const paperTrades = paperAgg?.total || 0;
    const wins = paperAgg?.wins || 0;
    const paperWinRate = paperTrades > 0 ? (wins / paperTrades) * 100 : 0;
    const paperRealizedPnl = paperAgg?.pnl || 0;

    let divergenceWinRate: number | null = null;
    let overfittingWarning = false;

    if (expectedWinRate !== null && paperTrades >= 3) {
      divergenceWinRate = paperWinRate - expectedWinRate;
      if (divergenceWinRate <= -20) {
        overfittingWarning = true;
      }
    }

    result.push({
      strategyId: s.id,
      strategyName: s.name,
      state: s.state,
      backtestCount: s.backtest_count,
      expectedWinRate,
      expectedPnl,
      paperTrades,
      paperWinRate,
      paperRealizedPnl,
      divergenceWinRate,
      overfittingWarning,
    });
  }

  return result;
}
