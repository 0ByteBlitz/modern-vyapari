/**
 * CVD coverage reporting and history repair (roadmap S1-3).
 *
 * `taker_buy_volume` arrived with schema v11. Every bar cached before it is
 * `NULL`, which is *correct* — it means the aggressor split is genuinely
 * unknown — but it also means CVD and the volume profile's buy/sell breakdown
 * are unavailable over most existing history, and they stay that way until the
 * bars are refetched. Binance has been sending the field all along (kline index
 * 9, `k.V` on the socket); this project was discarding it.
 *
 * Two things live here, and the order matters:
 *
 *  1. **Measure.** `listCandleCoverage()` says, per symbol and interval, how
 *     many cached bars have a known split. A repair that cannot be measured
 *     before and after is a belief, not a repair.
 *  2. **Heal.** `repairCandleHistory()` refetches the span containing unknown
 *     bars. The kline upsert is
 *     `COALESCE(excluded.taker_buy_volume, candles.taker_buy_volume)`, so a
 *     refetch can only ever *add* knowledge — it is safe to re-run, and it
 *     cannot erase a split that is already known.
 *
 * Nothing here purges. The FX-contamination fix needed a purge because the
 * stored values were *wrong*; these are merely absent, and absent heals.
 */

import { getDb } from "../db/database";
import { createLogger } from "../logger";
import { fetchKlineRange } from "../insights/indicators";
import { AppError } from "../../shared/errors";
import type {
  CandleCoverage,
  CandleRepairProgress,
  CandleRepairResult,
} from "../../shared/ipc-types";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

const log = createLogger("candle-repair");

/** Intervals Binance serves through the backfill path. Anything else cached
 *  cannot be repaired from REST and is reported as such rather than skipped
 *  silently. */
const REPAIRABLE_INTERVALS = new Set([1, 5, 15, 30, 60, 240, 1440]);

// Shapes live once in the shared IPC contract; re-exported so importers here
// are unchanged and main/renderer cannot drift.
export type { CandleCoverage, CandleRepairResult, CandleRepairProgress };

/* ── Measuring ──────────────────────────────────────────────────────── */

interface CoverageRow {
  symbol: string;
  interval_min: number;
  total: number;
  known: number;
  oldest: number | null;
  newest: number | null;
  first_unknown: number | null;
  last_unknown: number | null;
}

/* An empty-string `taker_buy_volume` is treated as unknown alongside NULL:
   `toNumericCandle` already reads "" as null, and a coverage report that
   disagreed with the consumer about what counts as known would be worse than
   no report — it would say CVD should work while CVD said it doesn't. */
const KNOWN = "taker_buy_volume IS NOT NULL AND taker_buy_volume != ''";
const UNKNOWN = "(taker_buy_volume IS NULL OR taker_buy_volume = '')";

const COVERAGE_SELECT = `
  SELECT symbol, interval_min,
         COUNT(*) AS total,
         SUM(CASE WHEN ${KNOWN} THEN 1 ELSE 0 END) AS known,
         MIN(start_ms) AS oldest,
         MAX(start_ms) AS newest,
         MIN(CASE WHEN ${UNKNOWN} THEN start_ms END) AS first_unknown,
         MAX(CASE WHEN ${UNKNOWN} THEN start_ms END) AS last_unknown
  FROM candles
  WHERE ${FEED_SCOPE_SQL}`;

function why(symbol: string, intervalMin: number): string | undefined {
  /* Binance quotes USDT, so analysis is USD-quote only. Fetching BASEUSDT and
     storing it under a GBP symbol is exactly the FX contamination schema v8
     had to purge — refuse rather than repeat it. */
  const quote = symbol.split("-")[1];
  if (quote !== "USD" && quote !== "USDT") {
    return `${symbol} has a non-USD quote. Analysis history is Binance/USDT-only; use the USD pair.`;
  }
  if (!REPAIRABLE_INTERVALS.has(intervalMin)) {
    return `${intervalMin}m is not one of the intervals Binance REST backfill supports.`;
  }
  return undefined;
}

function toCoverage(r: CoverageRow): CandleCoverage {
  const blockedReason = why(r.symbol, r.interval_min);
  return {
    symbol: r.symbol,
    intervalMin: r.interval_min,
    totalBars: r.total,
    knownBars: r.known ?? 0,
    coverage: r.total > 0 ? (r.known ?? 0) / r.total : 0,
    oldestMs: r.oldest,
    newestMs: r.newest,
    firstUnknownMs: r.first_unknown,
    lastUnknownMs: r.last_unknown,
    repairable: blockedReason === undefined,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

/** Coverage for every cached symbol/interval, worst first — the list is a
 *  work queue, so the thing most in need of repair belongs at the top. */
export function listCandleCoverage(): CandleCoverage[] {
  const rows = getDb()
    .prepare(`${COVERAGE_SELECT} GROUP BY symbol, interval_min`)
    .all() as unknown as CoverageRow[];

  return rows
    .map(toCoverage)
    .sort((a, b) => a.coverage - b.coverage || b.totalBars - a.totalBars);
}

export function getCandleCoverage(symbol: string, intervalMin: number): CandleCoverage | null {
  const row = getDb()
    .prepare(`${COVERAGE_SELECT} AND symbol = ? AND interval_min = ? GROUP BY symbol, interval_min`)
    .get(symbol, intervalMin) as unknown as CoverageRow | undefined;

  // GROUP BY yields no row at all when nothing matches, so `!row` is the real
  // case; the `!row.total` arm is belt-and-braces.
  if (!row || !row.total) return null;
  return toCoverage(row);
}

/* ── Repairing ──────────────────────────────────────────────────────── */

/**
 * Refetch the span of history containing unknown aggressor splits.
 *
 * Only the span that needs it: repairing a year of 1m bars to fix a hole in
 * one afternoon would be thousands of needless requests. The unknown bars are
 * contiguous in practice (everything before schema v11), but the query takes
 * min and max rather than assuming that, so a scattered hole is still covered.
 *
 * Reports measured coverage before and after. It does not claim success — it
 * says what changed, including when nothing did.
 */
export async function repairCandleHistory(
  symbol: string,
  intervalMin: number,
  onProgress?: (p: CandleRepairProgress) => void
): Promise<CandleRepairResult> {
  const before = getCandleCoverage(symbol, intervalMin);
  if (!before) {
    throw new AppError("VALIDATION", `No cached ${symbol} ${intervalMin}m history to repair.`, {
      hint: "Open the pair on Research or Markets first so history is fetched.",
    });
  }
  if (!before.repairable) {
    throw new AppError("VALIDATION", before.blockedReason ?? "This history can't be repaired.");
  }

  if (before.firstUnknownMs === null || before.lastUnknownMs === null) {
    return { symbol, intervalMin, before, after: before, barsFetched: 0, stillUnknown: 0, healed: 0 };
  }

  const barMs = intervalMin * 60_000;
  log.info(
    `Repairing ${symbol} ${intervalMin}m: ${before.totalBars - before.knownBars} of ${before.totalBars} ` +
      `bars have an unknown aggressor split.`
  );

  const barsFetched = await fetchKlineRange(
    symbol,
    intervalMin,
    before.firstUnknownMs,
    // Inclusive of the last unknown bar: the fetch range is half-open.
    before.lastUnknownMs + barMs,
    (info) => {
      onProgress?.({ symbol, intervalMin, ...info });
    }
  );

  const after = getCandleCoverage(symbol, intervalMin) ?? before;
  const stillUnknown = after.totalBars - after.knownBars;
  const healed = after.knownBars - before.knownBars;

  log.info(
    `Repaired ${symbol} ${intervalMin}m: fetched ${barsFetched} bars, healed ${healed}, ` +
      `${stillUnknown} still unknown (coverage ${(after.coverage * 100).toFixed(1)}%).`
  );

  return { symbol, intervalMin, before, after, barsFetched, stillUnknown, healed };
}

/**
 * Repair everything repairable that isn't already complete.
 *
 * Sequential on purpose: Binance rate-limits by weight, and a burst of
 * parallel 1000-bar requests across every cached pair is the shape that earns
 * a temporary IP ban. A repair that gets the app blocked from its analysis
 * feed has made things worse.
 */
export async function repairAllCandleHistory(
  onProgress?: (p: CandleRepairProgress) => void
): Promise<CandleRepairResult[]> {
  const targets = listCandleCoverage().filter((c) => c.repairable && c.coverage < 1);
  const results: CandleRepairResult[] = [];

  for (const target of targets) {
    try {
      results.push(await repairCandleHistory(target.symbol, target.intervalMin, onProgress));
    } catch (err) {
      log.error(`Repair failed for ${target.symbol} ${target.intervalMin}m`, err);
    }
  }

  return results;
}
