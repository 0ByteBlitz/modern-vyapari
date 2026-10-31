/**
 * Shared types for the insights/indicator layer.
 * Used by indicators.ts, strategy-spec.ts, backtester.ts, and alert-engine.ts.
 */

/* ── Candle shapes ──────────────────────────────────────────────────── */

/** Shape of a candle row from the SQLite `candles` table (all values stored as TEXT). */
export interface CandleRow {
  symbol: string;
  interval_min: number;
  start_ms: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  /** Taker (aggressor) BUY base volume. NULL/absent = **unknown**, not zero. */
  taker_buy_volume?: string | null;
  source: string;
}

/** Numeric candle (after parsing DB strings to floats for computation). */
export interface CandleNumeric {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * Taker (aggressor) BUY base volume for the bar, or `null`/absent when the
   * aggressor split is unknown for this candle (every row cached before schema
   * v11, and any bar Binance sent a nonsensical value for).
   *
   * **Never default this to 0.** Delta is `2 × takerBuy − volume`, so a missing
   * value read as zero becomes `−volume`: a bar of pure aggressive selling that
   * never happened. Consumers must treat `null` as unknown and report a gap.
   */
  takerBuyVolume?: number | null;
}

/** Convert a DB row to a numeric candle. */
export function toNumericCandle(row: CandleRow): CandleNumeric {
  const tb = row.taker_buy_volume;
  const parsedTb = tb === null || tb === undefined || tb === "" ? null : parseFloat(tb);
  return {
    timestamp: row.start_ms,
    open: parseFloat(row.open),
    high: parseFloat(row.high),
    low: parseFloat(row.low),
    close: parseFloat(row.close),
    volume: parseFloat(row.volume),
    takerBuyVolume: parsedTb !== null && Number.isFinite(parsedTb) ? parsedTb : null,
  };
}

/** Signed volume delta for one bar: aggressive buys minus aggressive sells.
 *  `null` when the bar's aggressor split is unknown — the caller decides how to
 *  represent the gap, and inventing a 0 here would fabricate a flat bar. */
export function barDelta(c: CandleNumeric): number | null {
  const tb = c.takerBuyVolume;
  if (tb === null || tb === undefined || !Number.isFinite(tb)) return null;
  return 2 * tb - c.volume;
}

/* ── Indicator config / result ──────────────────────────────────────── */

/** An indicator to compute: name + parameters. */
export interface IndicatorConfig {
  name: string;
  params: Record<string, number | string>;
}

/**
 * Result of computing an indicator over a candle series.
 * `values` is aligned with the END of the candle array — first entries may
 * be `null` during the warmup period where the indicator hasn't accumulated
 * enough data.
 */
export interface IndicatorResult {
  name: string;
  params: Record<string, number | string>;
  /** For single-output indicators: (number | null)[].
   *  For multi-output (MACD, BB): (Record<string, number> | null)[]. */
  values: (number | Record<string, number> | null)[];
  /** Timestamps aligned 1:1 with values (same length as the input candle array). */
  timestamps: number[];
}

/* ── Indicator catalog ──────────────────────────────────────────────── */

export type IndicatorCategory =
  | "momentum"
  | "trend"
  | "volatility"
  | "volume"
  | "oscillator"
  | "pattern"
  | "price";

/** Catalog entry describing an available indicator for the UI and Claude. */
export interface IndicatorCatalogEntry {
  name: string;
  displayName: string;
  category: IndicatorCategory;
  description: string;
  /** Parameter schema: name → meta. */
  params: Record<
    string,
    {
      type: "number" | "string";
      default: number | string;
      description: string;
      min?: number;
      max?: number;
    }
  >;
  /** For multi-output indicators (MACD, BB, etc.), the output field names.
   *  Omit for single-output indicators (RSI, SMA, etc.). */
  outputs?: string[];
  /** Which candle fields this indicator reads. */
  requiredFields: ("open" | "high" | "low" | "close" | "volume")[];
}

/* ── Interval mapping ───────────────────────────────────────────────── */

/** Maps human-readable interval strings to minutes. */
export const INTERVAL_TO_MINUTES: Record<string, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

/** Maps minutes to human-readable interval strings (reverse of above). */
export const MINUTES_TO_INTERVAL: Record<number, string> = {
  1: "1m",
  5: "5m",
  15: "15m",
  30: "30m",
  60: "1h",
  240: "4h",
  1440: "1d",
};

/* ── Key helpers ────────────────────────────────────────────────────── */

/**
 * Deterministic key for an indicator+params+field combination.
 * Used to look up pre-computed indicator values in maps.
 *
 * Examples:
 *   makeIndicatorKey("rsi", { period: 14 })            → "rsi:period=14"
 *   makeIndicatorKey("macd", { fast: 12 }, "histogram") → "macd:fast=12:histogram"
 *   makeIndicatorKey("price", {}, "close")              → "price::close"
 */
export function makeIndicatorKey(
  name: string,
  params: Record<string, number | string>,
  field?: string
): string {
  const sortedEntries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const paramStr = sortedEntries.map(([k, v]) => `${k}=${v}`).join(",");
  const base = `${name}:${paramStr}`;
  return field ? `${base}:${field}` : base;
}
