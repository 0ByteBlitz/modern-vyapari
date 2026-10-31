/**
 * Indicator library — computes 100+ TA indicators from cached candle data
 * via the `technicalindicators` library (pure JS, zero native builds).
 *
 * This is the foundational computation layer. Everything below reads from it:
 * strategy specs (entry/exit conditions reference indicators), the backtester
 * (needs historical indicator values), and the alert engine.
 *
 * Two calling conventions:
 *   1. `computeIndicator()` / `computeIndicatorBatch()` — reads candles from
 *      the SQLite cache (with Binance REST backfill if needed), returns results.
 *      Used by agent tools and the alert engine.
 *   2. `computeFromCandles()` — pure function, operates on supplied candle arrays.
 *      Used by the backtester (no DB dependency).
 */

import {
  RSI,
  SMA,
  EMA,
  WMA,
  WEMA,
  MACD,
  BollingerBands,
  Stochastic,
  StochasticRSI,
  WilliamsR,
  CCI,
  ROC,
  MFI,
  ADX,
  TRIX,
  ATR,
  PSAR,
  IchimokuCloud,
  VWAP,
  OBV,
  ForceIndex,
  AwesomeOscillator,
  KeltnerChannels,
} from "technicalindicators";
import { getDb } from "../db/database";
import type {
  CandleRow,
  CandleNumeric,
  IndicatorConfig,
  IndicatorResult,
  IndicatorCatalogEntry,
  IndicatorCategory,
} from "./indicator-types";
import { toNumericCandle, makeIndicatorKey } from "./indicator-types";
import { isNetworkDisabled } from "../net-guard";
import { createLogger } from "../logger";
import { toFeedSymbol } from "../integrations/feed/symbols";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

const log = createLogger("indicators");

/* ── Indicator catalog ──────────────────────────────────────────────── */

/** Full catalog of supported indicators. Used by the `list_indicators` tool
 *  and the Bot Working Area UI so Claude and the user can browse what's available. */
export const INDICATOR_CATALOG: IndicatorCatalogEntry[] = [
  // ─── Trend ───────────────────────────────────────────────────────────
  {
    name: "sma",
    displayName: "Simple Moving Average",
    category: "trend",
    description: "Arithmetic mean of the last N closing prices.",
    params: { period: { type: "number", default: 20, description: "Lookback period", min: 2, max: 500 } },
    requiredFields: ["close"],
  },
  {
    name: "ema",
    displayName: "Exponential Moving Average",
    category: "trend",
    description: "Exponentially weighted moving average — more weight to recent prices.",
    params: { period: { type: "number", default: 20, description: "Lookback period", min: 2, max: 500 } },
    requiredFields: ["close"],
  },
  {
    name: "wma",
    displayName: "Weighted Moving Average",
    category: "trend",
    description: "Linearly weighted moving average.",
    params: { period: { type: "number", default: 20, description: "Lookback period", min: 2, max: 500 } },
    requiredFields: ["close"],
  },
  {
    name: "wema",
    displayName: "Wilder's Smoothed Moving Average",
    category: "trend",
    description: "Wilder's smoothing method (used internally by RSI/ATR).",
    params: { period: { type: "number", default: 14, description: "Lookback period", min: 2, max: 500 } },
    requiredFields: ["close"],
  },
  {
    name: "macd",
    displayName: "MACD",
    category: "trend",
    description: "Moving Average Convergence Divergence — trend-following momentum indicator.",
    params: {
      fastPeriod: { type: "number", default: 12, description: "Fast EMA period", min: 2, max: 200 },
      slowPeriod: { type: "number", default: 26, description: "Slow EMA period", min: 2, max: 200 },
      signalPeriod: { type: "number", default: 9, description: "Signal EMA period", min: 2, max: 200 },
    },
    outputs: ["MACD", "signal", "histogram"],
    requiredFields: ["close"],
  },
  {
    name: "bbands",
    displayName: "Bollinger Bands",
    category: "trend",
    description: "Volatility bands placed above and below a moving average.",
    params: {
      period: { type: "number", default: 20, description: "SMA period", min: 2, max: 500 },
      stdDev: { type: "number", default: 2, description: "Standard deviation multiplier", min: 0.5, max: 5 },
    },
    outputs: ["upper", "middle", "lower", "pb"],
    requiredFields: ["close"],
  },
  {
    name: "psar",
    displayName: "Parabolic SAR",
    category: "trend",
    description: "Parabolic Stop and Reverse — trend reversal indicator.",
    params: {
      step: { type: "number", default: 0.02, description: "Acceleration factor step", min: 0.001, max: 0.5 },
      max: { type: "number", default: 0.2, description: "Maximum acceleration factor", min: 0.01, max: 1 },
    },
    requiredFields: ["high", "low"],
  },
  {
    name: "ichimoku",
    displayName: "Ichimoku Cloud",
    category: "trend",
    description: "Ichimoku Kinko Hyo — comprehensive trend/support/resistance indicator.",
    params: {
      conversionPeriod: { type: "number", default: 9, description: "Tenkan-sen period", min: 2, max: 100 },
      basePeriod: { type: "number", default: 26, description: "Kijun-sen period", min: 2, max: 200 },
      spanPeriod: { type: "number", default: 52, description: "Senkou Span B period", min: 2, max: 500 },
      displacement: { type: "number", default: 26, description: "Cloud displacement", min: 1, max: 200 },
    },
    outputs: ["conversion", "base", "spanA", "spanB"],
    requiredFields: ["high", "low"],
  },
  {
    name: "vwap",
    displayName: "VWAP",
    category: "trend",
    description: "Volume-Weighted Average Price — institutional benchmark.",
    params: {},
    requiredFields: ["high", "low", "close", "volume"],
  },
  // ─── Momentum ────────────────────────────────────────────────────────
  {
    name: "rsi",
    displayName: "RSI",
    category: "momentum",
    description: "Relative Strength Index — momentum oscillator (0–100). <30 = oversold, >70 = overbought.",
    params: { period: { type: "number", default: 14, description: "Lookback period", min: 2, max: 200 } },
    requiredFields: ["close"],
  },
  {
    name: "stochastic",
    displayName: "Stochastic Oscillator",
    category: "momentum",
    description: "Compares closing price to the high-low range over a period.",
    params: {
      period: { type: "number", default: 14, description: "%K lookback", min: 2, max: 200 },
      signalPeriod: { type: "number", default: 3, description: "%D smoothing", min: 1, max: 50 },
    },
    outputs: ["k", "d"],
    requiredFields: ["high", "low", "close"],
  },
  {
    name: "stochrsi",
    displayName: "Stochastic RSI",
    category: "momentum",
    description: "Stochastic oscillator applied to RSI values.",
    params: {
      rsiPeriod: { type: "number", default: 14, description: "RSI period", min: 2, max: 200 },
      stochasticPeriod: { type: "number", default: 14, description: "Stochastic period", min: 2, max: 200 },
      kPeriod: { type: "number", default: 3, description: "%K smoothing", min: 1, max: 50 },
      dPeriod: { type: "number", default: 3, description: "%D smoothing", min: 1, max: 50 },
    },
    outputs: ["stochRSI", "k", "d"],
    requiredFields: ["close"],
  },
  {
    name: "williamsr",
    displayName: "Williams %R",
    category: "momentum",
    description: "Measures overbought/oversold levels (-100 to 0).",
    params: { period: { type: "number", default: 14, description: "Lookback period", min: 2, max: 200 } },
    requiredFields: ["high", "low", "close"],
  },
  {
    name: "cci",
    displayName: "CCI",
    category: "momentum",
    description: "Commodity Channel Index — measures deviation from the mean.",
    params: { period: { type: "number", default: 20, description: "Lookback period", min: 2, max: 200 } },
    requiredFields: ["high", "low", "close"],
  },
  {
    name: "roc",
    displayName: "Rate of Change",
    category: "momentum",
    description: "Percentage change over N periods.",
    params: { period: { type: "number", default: 12, description: "Lookback period", min: 1, max: 200 } },
    requiredFields: ["close"],
  },
  {
    name: "mfi",
    displayName: "MFI",
    category: "momentum",
    description: "Money Flow Index — volume-weighted RSI (0–100).",
    params: { period: { type: "number", default: 14, description: "Lookback period", min: 2, max: 200 } },
    requiredFields: ["high", "low", "close", "volume"],
  },
  {
    name: "adx",
    displayName: "ADX",
    category: "momentum",
    description: "Average Directional Index — trend strength (not direction).",
    params: { period: { type: "number", default: 14, description: "Lookback period", min: 2, max: 200 } },
    outputs: ["adx", "pdi", "mdi"],
    requiredFields: ["high", "low", "close"],
  },
  {
    name: "trix",
    displayName: "TRIX",
    category: "momentum",
    description: "Triple Exponential Moving Average oscillator.",
    params: { period: { type: "number", default: 15, description: "Lookback period", min: 2, max: 200 } },
    requiredFields: ["close"],
  },
  {
    name: "ao",
    displayName: "Awesome Oscillator",
    category: "oscillator",
    description: "Difference between 5- and 34-period SMAs of midpoints.",
    params: {
      fastPeriod: { type: "number", default: 5, description: "Fast SMA period", min: 2, max: 100 },
      slowPeriod: { type: "number", default: 34, description: "Slow SMA period", min: 2, max: 200 },
    },
    requiredFields: ["high", "low"],
  },
  // ─── Volatility ──────────────────────────────────────────────────────
  {
    name: "atr",
    displayName: "ATR",
    category: "volatility",
    description: "Average True Range — measures market volatility.",
    params: { period: { type: "number", default: 14, description: "Lookback period", min: 2, max: 200 } },
    requiredFields: ["high", "low", "close"],
  },
  {
    name: "keltner",
    displayName: "Keltner Channels",
    category: "volatility",
    description: "Volatility-based channels using ATR around an EMA.",
    params: {
      period: { type: "number", default: 20, description: "EMA period", min: 2, max: 200 },
      atrPeriod: { type: "number", default: 10, description: "ATR period", min: 2, max: 200 },
      useSMA: { type: "number", default: 0, description: "Use SMA instead of EMA (1=yes)", min: 0, max: 1 },
    },
    outputs: ["upper", "middle", "lower"],
    requiredFields: ["high", "low", "close"],
  },
  // ─── Volume ──────────────────────────────────────────────────────────
  {
    name: "obv",
    displayName: "OBV",
    category: "volume",
    description: "On-Balance Volume — cumulative volume added on up-days, subtracted on down-days.",
    params: {},
    requiredFields: ["close", "volume"],
  },
  {
    name: "fi",
    displayName: "Force Index",
    category: "volume",
    description: "Combines price change and volume to measure buying/selling pressure.",
    params: { period: { type: "number", default: 13, description: "EMA period for smoothing", min: 1, max: 200 } },
    requiredFields: ["high", "low", "close", "volume"],
  },
];

const CATALOG_BY_NAME = new Map<string, IndicatorCatalogEntry>();
for (const entry of INDICATOR_CATALOG) {
  CATALOG_BY_NAME.set(entry.name, entry);
}

/* ── Candle helpers ─────────────────────────────────────────────────── */

function num(val: number | string | undefined): number {
  return typeof val === "string" ? parseFloat(val) : (val ?? 0);
}

/**
 * Estimate how many candles are needed for a given indicator's warmup.
 * This is the minimum input length before the indicator produces its first value.
 */
function estimateWarmupBars(name: string, params: Record<string, number | string>): number {
  const p = (key: string, def: number) => {
    const v = params[key];
    return typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) || def : def;
  };

  switch (name) {
    case "sma":
    case "ema":
    case "wma":
    case "wema":
    case "rsi":
    case "roc":
    case "atr":
    case "trix":
      return p("period", 14) + 5; // small buffer

    case "macd":
      return Math.max(p("fastPeriod", 12), p("slowPeriod", 26)) + p("signalPeriod", 9) + 5;

    case "bbands":
      return p("period", 20) + 5;

    case "stochastic":
    case "williamsr":
    case "cci":
    case "mfi":
      return p("period", 14) + p("signalPeriod", 3) + 5;

    case "stochrsi":
      return p("rsiPeriod", 14) + p("stochasticPeriod", 14) + p("kPeriod", 3) + 5;

    case "adx":
      return p("period", 14) * 2 + 5;

    case "psar":
      return 5;

    case "ichimoku":
      return Math.max(p("conversionPeriod", 9), p("basePeriod", 26), p("spanPeriod", 52)) + p("displacement", 26) + 5;

    case "keltner":
      return Math.max(p("period", 20), p("atrPeriod", 10)) + 5;

    case "ao":
      return p("slowPeriod", 34) + 5;

    case "fi":
      return p("period", 13) + 5;

    case "vwap":
    case "obv":
      return 2;

    default:
      return 50; // safe fallback
  }
}

/* ── Binance REST backfill ──────────────────────────────────────────── */

/** Binance interval strings (matches binance-ws.ts INTERVAL_STRINGS). */
const MINUTES_TO_BINANCE: Record<number, string> = {
  1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "1d",
};

/**
 * Binance REST kline tuple. Only indices 0–5 were ever read; **index 9 is
 * taker buy base asset volume**, the aggressor split that CVD needs, and it
 * was being discarded on every backfill.
 */
type BinanceKline = [
  number,  // 0 open time
  string,  // 1 open
  string,  // 2 high
  string,  // 3 low
  string,  // 4 close
  string,  // 5 base volume
  number,  // 6 close time
  string,  // 7 quote volume
  number,  // 8 trade count
  string,  // 9 taker buy base volume  ← delta = 2×this − volume
  string,  // 10 taker buy quote volume
  string   // 11 unused
];

/** One upsert shape for both backfill directions, so the two paths cannot
 *  disagree about which columns they write (they already had two copies of
 *  this SQL, and only one would have been updated for a new column). */
const KLINE_UPSERT_SQL = `
  INSERT INTO candles (symbol, interval_min, start_ms, open, high, low, close, volume, taker_buy_volume, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'binance')
  ON CONFLICT(source, symbol, interval_min, start_ms)
  DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low,
                close=excluded.close, volume=excluded.volume,
                -- Never overwrite a known aggressor split with NULL.
                taker_buy_volume=COALESCE(excluded.taker_buy_volume, candles.taker_buy_volume)`;

/** Taker-buy volume from a kline, or null when absent/nonsensical.
 *  It must be within [0, volume] to be believable — outside that range the
 *  field is wrong, and a wrong delta is worse than a missing one. */
function takerBuyOf(k: BinanceKline): string | null {
  const raw = k[9];
  if (typeof raw !== "string" || raw === "") return null;
  const tb = parseFloat(raw);
  const vol = parseFloat(k[5]);
  if (!Number.isFinite(tb) || tb < 0) return null;
  if (Number.isFinite(vol) && tb > vol * 1.000001) return null;
  return raw;
}

/** Progress callback for a long forward fetch, so a repair can report where it
 *  is instead of appearing frozen. Return `false` to stop early. */
export type KlineRangeProgress = (info: {
  cursorMs: number;
  barsWritten: number;
  batches: number;
}) => boolean | void;

/**
 * Fetch klines FORWARD over `[fromMs, toMs)` and upsert them.
 *
 * The single forward-fetch implementation. Both the "we were closed for a
 * week" catch-up and the S1-3 history repair go through it, so they cannot
 * drift on which columns they write, how they page, or how they decide the
 * server stopped making progress.
 *
 * Because the upsert is `COALESCE(excluded.taker_buy_volume, candles.…)`,
 * refetching a range **heals** an unknown aggressor split and can never erase
 * a known one — which is what makes repairing old history safe to re-run.
 */
export async function fetchKlineRange(
  symbol: string,
  intervalMin: number,
  fromMs: number,
  toMs: number,
  onProgress?: KlineRangeProgress
): Promise<number> {
  if (isNetworkDisabled()) return 0;
  const binanceInterval = MINUTES_TO_BINANCE[intervalMin];
  if (!binanceInterval) return 0;

  const binanceSymbol = toFeedSymbol(symbol);
  if (!binanceSymbol) return 0;

  const db = getDb();
  const barMs = intervalMin * 60_000;
  let cursor = fromMs;
  let written = 0;
  let batches = 0;

  const insert = db.prepare(KLINE_UPSERT_SQL);

  while (cursor < toMs) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${binanceInterval}` +
      `&startTime=${cursor}&endTime=${toMs}&limit=1000`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.error(`Kline range fetch failed: ${res.status} ${res.statusText}`);
        break;
      }

      const klines = (await res.json()) as BinanceKline[];
      if (klines.length === 0) break;

      for (const k of klines) {
        insert.run(symbol, intervalMin, k[0], k[1], k[2], k[3], k[4], k[5], takerBuyOf(k));
        written++;
      }
      batches++;

      const lastStart = klines[klines.length - 1]?.[0] ?? cursor;
      if (lastStart + barMs <= cursor) break; // no progress — bail rather than spin
      cursor = lastStart + barMs;

      if (onProgress?.({ cursorMs: cursor, barsWritten: written, batches }) === false) break;
    } catch (err) {
      log.error("Kline range fetch error:", err);
      break;
    }
  }

  return written;
}

/**
 * Fetch candles FORWARD from a timestamp up to now, and cache them.
 *
 * `backfillFromBinance` only ever fills history *older* than what's cached —
 * it walks backwards from the oldest known bar. That left a hole nothing
 * filled: close the app for a week, reopen it, and the cache still has plenty
 * of rows (so the count check passes) but the newest is a week old. The chart
 * then renders stale candles as if they were current.
 *
 * This is the other direction: from the last known bar to the present.
 */
export async function syncRecentFromBinance(
  symbol: string,
  intervalMin: number,
  fromMs: number
): Promise<number> {
  return fetchKlineRange(symbol, intervalMin, fromMs, Date.now());
}

/**
 * Fetch candles from Binance REST API and cache them in SQLite.
 * Used for backfill when the local WS cache doesn't have enough history.
 *
 * Exported because Binance is the single analysis feed (charts, indicators,
 * backtests, paper fills) — every consumer must go through this one
 * implementation so cached history can never differ by caller.
 *
 * NOTE: this fills BACKWARDS (older than `existingOldestMs`). To close a gap
 * at the recent end, use `syncRecentFromBinance`.
 */
export async function backfillFromBinance(
  symbol: string,
  intervalMin: number,
  neededCount: number,
  existingOldestMs: number | null
): Promise<void> {
  /* Serve whatever is cached rather than reaching the network. Tests must never
     hit Binance — a suite whose result depends on a third party's uptime is not
     a test — and this is the same behaviour an offline mode needs. */
  if (isNetworkDisabled()) return;
  const binanceInterval = MINUTES_TO_BINANCE[intervalMin];
  if (!binanceInterval) return;

  // Convert "BTC-USD" → "BTCUSDT" (Binance uses USDT pairs)
  const binanceSymbol = toFeedSymbol(symbol);
  if (!binanceSymbol) return;

  const db = getDb();
  const barMs = intervalMin * 60_000;

  // Calculate how far back we need
  const endMs = existingOldestMs ?? Date.now();
  const startMs = endMs - neededCount * barMs;

  // Binance klines API: max 1000 per request
  const batchSize = 1000;
  let cursor = startMs;

  while (cursor < endMs) {
    const limit = Math.min(batchSize, Math.ceil((endMs - cursor) / barMs));
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${binanceInterval}` +
      `&startTime=${cursor}&limit=${limit}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.error(`Binance REST backfill failed: ${res.status} ${res.statusText}`);
        break;
      }

      const klines = (await res.json()) as BinanceKline[];

      if (klines.length === 0) break;

      const insert = db.prepare(KLINE_UPSERT_SQL);

      for (const k of klines) {
        // NOTE: USDT ≈ USD at this stage — the same approximation the WS layer
        // uses for USD-quoted pairs (non-USD quotes are refused outright).
        insert.run(symbol, intervalMin, k[0], k[1], k[2], k[3], k[4], k[5], takerBuyOf(k));
      }

      const lastStart = klines[klines.length - 1]?.[0] ?? cursor;
      cursor = lastStart + barMs;
    } catch (err) {
      log.error("Binance REST backfill error:", err);
      break;
    }
  }
}

/* ── Core computation (pure function — no DB) ──────────────────────── */

/**
 * Compute an indicator over supplied candles. Pure function — used by the
 * backtester and by `computeIndicator()` after candle fetching.
 *
 * Returns an IndicatorResult with `values` aligned 1:1 with the input candle
 * array (null-padded at the start for the warmup period).
 */
export function computeFromCandles(
  candles: CandleNumeric[],
  indicatorName: string,
  params: Record<string, number | string>
): IndicatorResult {
  const timestamps = candles.map((c) => c.timestamp);
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const opens = candles.map((c) => c.open);

  const p = (key: string, def: number) => {
    const v = params[key];
    return typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) || def : def;
  };

  let raw: unknown[];
  let isMultiOutput = false;

  switch (indicatorName) {
    // ─── Trend ─────────────────────────────────────────────────────
    case "sma":
      raw = SMA.calculate({ values: closes, period: p("period", 20) });
      break;
    case "ema":
      raw = EMA.calculate({ values: closes, period: p("period", 20) });
      break;
    case "wma":
      raw = WMA.calculate({ values: closes, period: p("period", 20) });
      break;
    case "wema":
      raw = WEMA.calculate({ values: closes, period: p("period", 14) });
      break;
    case "macd": {
      const result = MACD.calculate({
        values: closes,
        fastPeriod: p("fastPeriod", 12),
        slowPeriod: p("slowPeriod", 26),
        signalPeriod: p("signalPeriod", 9),
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      raw = result.map((r) => ({
        MACD: r.MACD ?? null,
        signal: r.signal ?? null,
        histogram: r.histogram ?? null,
      }));
      isMultiOutput = true;
      break;
    }
    case "bbands": {
      const result = BollingerBands.calculate({
        period: p("period", 20),
        values: closes,
        stdDev: p("stdDev", 2),
      });
      raw = result.map((r) => ({
        upper: r.upper,
        middle: r.middle,
        lower: r.lower,
        pb: r.pb,
      }));
      isMultiOutput = true;
      break;
    }
    case "psar":
      raw = PSAR.calculate({
        high: highs,
        low: lows,
        step: p("step", 0.02),
        max: p("max", 0.2),
      });
      break;
    case "ichimoku": {
      const result = IchimokuCloud.calculate({
        high: highs,
        low: lows,
        conversionPeriod: p("conversionPeriod", 9),
        basePeriod: p("basePeriod", 26),
        spanPeriod: p("spanPeriod", 52),
        displacement: p("displacement", 26),
      });
      raw = result.map((r) => ({
        conversion: r.conversion,
        base: r.base,
        spanA: r.spanA,
        spanB: r.spanB,
      }));
      isMultiOutput = true;
      break;
    }
    case "vwap":
      raw = VWAP.calculate({ high: highs, low: lows, close: closes, volume: volumes });
      break;

    // ─── Momentum ──────────────────────────────────────────────────
    case "rsi":
      raw = RSI.calculate({ values: closes, period: p("period", 14) });
      break;
    case "stochastic": {
      const result = Stochastic.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: p("period", 14),
        signalPeriod: p("signalPeriod", 3),
      });
      raw = result.map((r) => ({ k: r.k, d: r.d }));
      isMultiOutput = true;
      break;
    }
    case "stochrsi": {
      const result = StochasticRSI.calculate({
        values: closes,
        rsiPeriod: p("rsiPeriod", 14),
        stochasticPeriod: p("stochasticPeriod", 14),
        kPeriod: p("kPeriod", 3),
        dPeriod: p("dPeriod", 3),
      });
      raw = result.map((r) => ({
        stochRSI: r.stochRSI,
        k: r.k,
        d: r.d,
      }));
      isMultiOutput = true;
      break;
    }
    case "williamsr":
      raw = WilliamsR.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: p("period", 14),
      });
      break;
    case "cci":
      raw = CCI.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: p("period", 20),
      });
      break;
    case "roc":
      raw = ROC.calculate({ values: closes, period: p("period", 12) });
      break;
    case "mfi":
      raw = MFI.calculate({
        high: highs,
        low: lows,
        close: closes,
        volume: volumes,
        period: p("period", 14),
      });
      break;
    case "adx": {
      const result = ADX.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: p("period", 14),
      });
      raw = result.map((r) => ({ adx: r.adx, pdi: r.pdi, mdi: r.mdi }));
      isMultiOutput = true;
      break;
    }
    case "trix":
      raw = TRIX.calculate({ values: closes, period: p("period", 15) });
      break;
    case "ao":
      raw = AwesomeOscillator.calculate({
        high: highs,
        low: lows,
        fastPeriod: p("fastPeriod", 5),
        slowPeriod: p("slowPeriod", 34),
      });
      break;

    // ─── Volatility ────────────────────────────────────────────────
    case "atr":
      raw = ATR.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: p("period", 14),
      });
      break;
    case "keltner": {
      const result = KeltnerChannels.calculate({
        high: highs,
        low: lows,
        close: closes,
        maPeriod: p("period", 20),
        atrPeriod: p("atrPeriod", 10),
        useSMA: p("useSMA", 0) === 1,
        multiplier: p("multiplier", 1.5),
      });
      raw = result.map((r) => ({
        upper: r.upper,
        middle: r.middle,
        lower: r.lower,
      }));
      isMultiOutput = true;
      break;
    }

    // ─── Volume ────────────────────────────────────────────────────
    case "obv":
      raw = OBV.calculate({ close: closes, volume: volumes });
      break;
    case "fi":
      raw = ForceIndex.calculate({
        close: closes,
        volume: volumes,
        period: p("period", 13),
      });
      break;
    case "cvd": {
      let cumDelta = 0;
      raw = candles.map((c) => {
        const delta = c.close >= c.open ? c.volume : -c.volume;
        cumDelta += delta;
        return cumDelta;
      });
      break;
    }

    default:
      throw new Error(`Unknown indicator: ${indicatorName}`);
  }

  // Align raw output with candle array — null-pad the warmup period
  const offset = candles.length - raw.length;
  const alignedValues: IndicatorResult["values"] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i < offset) {
      alignedValues.push(null);
    } else {
      const v = raw[i - offset];
      if (v === undefined || v === null) {
        alignedValues.push(null);
      } else if (typeof v === "number") {
        alignedValues.push(isNaN(v) ? null : v);
      } else if (typeof v === "object") {
        // Multi-output: clean up any NaN/undefined fields
        const cleaned: Record<string, number> = {};
        for (const [field, val] of Object.entries(v as Record<string, unknown>)) {
          const n = num(val as number | undefined);
          cleaned[field] = isNaN(n) ? 0 : n;
        }
        alignedValues.push(cleaned);
      } else {
        alignedValues.push(null);
      }
    }
  }

  return {
    name: indicatorName,
    params,
    values: alignedValues,
    timestamps,
  };
}

/* ── DB-backed computation (with backfill) ──────────────────────────── */

/**
 * Compute a single indicator for a symbol/interval, reading candles from the
 * SQLite cache. If the cache doesn't have enough history, auto-fetches from
 * the Binance REST API and caches the result.
 */
export async function computeIndicator(
  symbol: string,
  intervalMin: number,
  indicatorName: string,
  params: Record<string, number | string>,
  options?: { limit?: number }
): Promise<IndicatorResult> {
  const warmup = estimateWarmupBars(indicatorName, params);
  const desiredBars = (options?.limit ?? 100) + warmup;

  const db = getDb();

  // Check how many cached candles we have
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS c, MIN(start_ms) AS oldest FROM candles
       WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL}`
    )
    .get(symbol, intervalMin) as { c: number; oldest: number | null } | undefined;

  const cachedCount = countRow?.c ?? 0;

  if (cachedCount < desiredBars) {
    // Auto-fetch from Binance REST
    const shortfall = desiredBars - cachedCount + 50; // fetch a bit extra
    await backfillFromBinance(symbol, intervalMin, shortfall, countRow?.oldest ?? null);
  }

  // Read candles from cache
  const rows = db
    .prepare(
      `SELECT start_ms, open, high, low, close, volume FROM candles
       WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL}
       ORDER BY start_ms ASC
       LIMIT ?`
    )
    .all(symbol, intervalMin, desiredBars) as unknown as Omit<CandleRow, "symbol" | "interval_min" | "source">[];

  const candles: CandleNumeric[] = rows.map((r) => ({
    timestamp: r.start_ms,
    open: parseFloat(r.open),
    high: parseFloat(r.high),
    low: parseFloat(r.low),
    close: parseFloat(r.close),
    volume: parseFloat(r.volume),
  }));

  if (candles.length === 0) {
    return {
      name: indicatorName,
      params,
      values: [],
      timestamps: [],
    };
  }

  return computeFromCandles(candles, indicatorName, params);
}

/**
 * Compute multiple indicators in one call (single candle fetch, multiple computations).
 */
export async function computeIndicatorBatch(
  symbol: string,
  intervalMin: number,
  indicators: IndicatorConfig[],
  options?: { limit?: number }
): Promise<IndicatorResult[]> {
  if (indicators.length === 0) return [];

  // Determine the maximum warmup needed across all indicators
  const maxWarmup = Math.max(...indicators.map((i) => estimateWarmupBars(i.name, i.params)));
  const desiredBars = (options?.limit ?? 100) + maxWarmup;

  const db = getDb();

  // Check cache + backfill
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS c, MIN(start_ms) AS oldest FROM candles
       WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL}`
    )
    .get(symbol, intervalMin) as { c: number; oldest: number | null } | undefined;

  if ((countRow?.c ?? 0) < desiredBars) {
    const shortfall = desiredBars - (countRow?.c ?? 0) + 50;
    await backfillFromBinance(symbol, intervalMin, shortfall, countRow?.oldest ?? null);
  }

  const rows = db
    .prepare(
      `SELECT start_ms, open, high, low, close, volume FROM candles
       WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL}
       ORDER BY start_ms ASC
       LIMIT ?`
    )
    .all(symbol, intervalMin, desiredBars) as unknown as Omit<CandleRow, "symbol" | "interval_min" | "source">[];

  const candles: CandleNumeric[] = rows.map((r) => ({
    timestamp: r.start_ms,
    open: parseFloat(r.open),
    high: parseFloat(r.high),
    low: parseFloat(r.low),
    close: parseFloat(r.close),
    volume: parseFloat(r.volume),
  }));

  if (candles.length === 0) {
    return indicators.map((i) => ({ name: i.name, params: i.params, values: [], timestamps: [] }));
  }

  return indicators.map((i) => computeFromCandles(candles, i.name, i.params));
}

/* ── Catalog query ──────────────────────────────────────────────────── */

/** Returns the full indicator catalog (for Claude's list_indicators tool and the UI). */
export function listIndicators(): IndicatorCatalogEntry[] {
  return INDICATOR_CATALOG;
}

/** Look up a catalog entry by name. */
export function getCatalogEntry(name: string): IndicatorCatalogEntry | undefined {
  return CATALOG_BY_NAME.get(name);
}
