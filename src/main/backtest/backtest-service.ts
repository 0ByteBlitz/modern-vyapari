/**
 * Backtest service — orchestration layer connecting the pure backtester engine
 * to the DB and IPC. Fetches candles, runs the backtest, persists results,
 * and manages strategy state transitions.
 */

import { getDb, auditLog } from "../db/database";
import type { CandleNumeric, CandleRow } from "../insights/indicator-types";
import type { StrategySpec } from "../strategy/strategy-spec";
import { getStrategy, incrementBacktestCount, setStrategyState } from "../strategy/strategy-service";
import { runBacktest } from "./backtester";
import type { BacktestConfig, BacktestResult } from "./backtest-types";
import { DEFAULT_BACKTEST_CONFIG } from "./backtest-types";
import { createLogger } from "../logger";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

const log = createLogger("backtest");

/* ── Row shape ──────────────────────────────────────────────────────── */

export interface BacktestRow {
  id: number;
  session_id: number;
  strategy_id: number | null;
  params_json: string;
  result_json: string | null;
  data_from: number | null;
  data_until: number | null;
  status: string;
  created_at: number;
}

/* ── Run a backtest ─────────────────────────────────────────────────── */

/**
 * Run a backtest for a strategy. Fetches candles from the SQLite cache,
 * runs the backtester engine, persists the result, and optionally
 * transitions the strategy to BACKTESTED state.
 *
 * @param sessionId   The session owning the strategy.
 * @param strategyId  DB id of the strategy to backtest.
 * @param config      Partial backtest config (merged with defaults).
 * @returns           The full BacktestResult.
 */
export async function startBacktest(
  sessionId: number,
  strategyId: number,
  config?: Partial<BacktestConfig>
): Promise<BacktestResult> {
  const db = getDb();
  const strategy = getStrategy(strategyId);
  if (!strategy) throw new Error(`Strategy ${strategyId} not found`);
  if (strategy.session_id !== sessionId) {
    throw new Error(`Strategy ${strategyId} does not belong to session ${sessionId}`);
  }

  const spec: StrategySpec = JSON.parse(strategy.spec_json);

  // Slippage: prefer the MEASURED Revolut X spread over the default guess.
  // Candles come from Binance but fills happen on Revolut X, so a backtest
  // using Binance-implied costs understates what a trade actually pays. The
  // basis monitor's median spread (halved — you cross half of it per side) is
  // the honest number. Explicit caller config always wins.
  const { measuredSlippageBps } = require("../data/basis-monitor") as typeof import("../data/basis-monitor");
  const measured = measuredSlippageBps(spec.pair);
  const cfg: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...(measured !== null ? { slippageBps: measured } : {}),
    ...config,
  };

  if (measured !== null && config?.slippageBps === undefined) {
    log.info(`Using measured Revolut X slippage for ${spec.pair}: ${measured.toFixed(1)}bps ` +
        `(default was ${DEFAULT_BACKTEST_CONFIG.slippageBps}bps)`
    );
  }

  // Create pending backtest record
  const now = Date.now();
  const insertResult = db
    .prepare(
      `INSERT INTO backtests (session_id, strategy_id, params_json, status, created_at)
       VALUES (?, ?, ?, 'running', ?)`
    )
    .run(sessionId, strategyId, JSON.stringify(cfg), now);
  const backtestId = Number(insertResult.lastInsertRowid);

  try {
    // Fetch all cached candles for this pair
    // Use the eval_interval from the spec to determine which interval to use
    const intervalMap: Record<string, number> = {
      "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440,
    };
    const intervalMin = intervalMap[spec.schedule.eval_interval] ?? 60;

    const rows = db
      .prepare(
        `SELECT start_ms, open, high, low, close, volume FROM candles
         WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL}
         ORDER BY start_ms ASC`
      )
      .all(spec.pair, intervalMin) as unknown as Omit<CandleRow, "symbol" | "interval_min" | "source">[];

    const candles: CandleNumeric[] = rows.map((r) => ({
      timestamp: r.start_ms,
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume),
    }));

    const configDays = cfg.daysToTest ?? 30;
    const requiredCandles = Math.ceil((configDays * 24 * 60) / intervalMin);

    // If insufficient data, try to backfill from Binance REST
    if (candles.length < requiredCandles) {
      // Import dynamically to avoid circular dependency issues
      const { computeIndicatorBatch } = require("../insights/indicators") as typeof import("../insights/indicators");
      // Trigger a batch compute which internally calls backfillFromBinance
      await computeIndicatorBatch(spec.pair, intervalMin, [{ name: "sma", params: { period: 20 } }], { limit: requiredCandles });

      // Re-read candles after backfill
      const refetchedRows = db
        .prepare(
          `SELECT start_ms, open, high, low, close, volume FROM candles
           WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL}
           ORDER BY start_ms ASC`
        )
        .all(spec.pair, intervalMin) as unknown as Omit<CandleRow, "symbol" | "interval_min" | "source">[];

      candles.length = 0;
      for (const r of refetchedRows) {
        candles.push({
          timestamp: r.start_ms,
          open: parseFloat(r.open),
          high: parseFloat(r.high),
          low: parseFloat(r.low),
          close: parseFloat(r.close),
          volume: parseFloat(r.volume),
        });
      }
    }

    // Run the backtester
    const result = runBacktest(spec, candles, cfg);

    // Persist result
    db.prepare(
      `UPDATE backtests
       SET result_json = ?, data_from = ?, data_until = ?, status = 'completed'
       WHERE id = ?`
    ).run(
      JSON.stringify(result),
      result.dataRange.from,
      result.dataRange.to,
      backtestId
    );

    // Update strategy
    incrementBacktestCount(strategyId);

    // Auto-transition to BACKTESTED if currently DRAFT and backtest succeeded
    if (strategy.state === "draft" && result.tradeLog.length > 0) {
      try {
        setStrategyState(strategyId, "backtested");
      } catch (_e) {
        // Transition might not be valid — that's ok
      }
    }

    auditLog("backtest_completed", {
      backtestId,
      strategyId,
      sessionId,
      trades: result.tradeLog.length,
      netPnl: result.inSample.netPnl,
      maxDrawdown: result.inSample.maxDrawdown,
    });

    return result;
  } catch (err) {
    // Mark backtest as failed
    db.prepare("UPDATE backtests SET status = 'failed' WHERE id = ?").run(backtestId);

    auditLog("backtest_failed", {
      backtestId,
      strategyId,
      error: err instanceof Error ? err.message : String(err),
    });

    throw err;
  }
}

/* ── Queries ────────────────────────────────────────────────────────── */

/** Get a backtest result by ID. */
export function getBacktestResult(backtestId: number): BacktestResult | null {
  const row = getDb()
    .prepare("SELECT result_json FROM backtests WHERE id = ?")
    .get(backtestId) as { result_json: string | null } | undefined;

  if (!row?.result_json) return null;
  return JSON.parse(row.result_json) as BacktestResult;
}

/** List backtests for a session, newest first. */
export function listBacktests(sessionId: number): BacktestRow[] {
  return getDb()
    .prepare(
      `SELECT id, session_id, strategy_id, params_json, result_json,
              data_from, data_until, status, created_at
       FROM backtests
       WHERE session_id = ?
       ORDER BY created_at DESC`
    )
    .all(sessionId) as unknown as BacktestRow[];
}

/** List backtests for a specific strategy. */
export function listBacktestsForStrategy(strategyId: number): BacktestRow[] {
  return getDb()
    .prepare(
      `SELECT id, session_id, strategy_id, params_json, result_json,
              data_from, data_until, status, created_at
       FROM backtests
       WHERE strategy_id = ?
       ORDER BY created_at DESC`
    )
    .all(strategyId) as unknown as BacktestRow[];
}
