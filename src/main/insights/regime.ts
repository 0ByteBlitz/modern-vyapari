/**
 * What kind of market is this? — measured, never guessed.
 *
 * ## Why this exists
 *
 * A lesson without its conditions is either overgeneralised or wrong. "Exits
 * fire while the move is still extending" can be true in a trend and false in a
 * range, and a memory that states it unconditionally teaches the agent to trade
 * the market it happened to see rather than the one in front of it.
 *
 * So a lesson carries the regime its evidence came from, and retrieval prefers
 * lessons whose regime matches now. That is the whole idea; this module is the
 * part that has to be honest for it to work.
 *
 * ## Deterministic, and never the model's opinion
 *
 * Same rule as everywhere else in this codebase: **code measures, AI reasons
 * about the measurement.** A model asked "is this a trending market?" will
 * always answer, fluently, with no way to check it — and that answer would then
 * be stamped onto a memory injected into every future prompt. ADX and ATR are
 * boring and reproducible, which is exactly what is wanted.
 *
 * ## Two dimensions, deliberately not crossed
 *
 * **Trend** (from ADX and the directional indicators) is what lessons match on.
 * **Volatility** (from ATR relative to its own recent distribution) is reported
 * as context but does not gate a match: crossing the two would give nine
 * buckets, and with the sample sizes this app will realistically have, that
 * fragments the evidence into nothing. One dimension that matches is worth more
 * than two that never do.
 *
 * Volatility is a *percentile of the pair's own ATR history*, never an absolute
 * threshold. "ATR above 2%" means something completely different on BTC and on
 * a small alt; comparing a pair to itself is the only version that transfers.
 *
 * ## Unknown is a value
 *
 * With too little history the answer is `unknown`, not `ranging`. ADX needs
 * roughly `2 × period` bars before it means anything, and returning a default
 * bucket would put a fabricated condition on a lesson — the same defect as a
 * missing `taker_buy_volume` read as zero.
 */

import { computeFromCandles } from "./indicators";
import type { CandleNumeric } from "./indicator-types";

/**
 * The matching dimension.
 *
 * `mixed` is not a measurement — it is what a *lesson* is tagged when its
 * evidence spans several regimes. Those are the strongest lessons there are
 * (they held regardless of conditions), so they always apply.
 */
export type TrendRegime = "trending_up" | "trending_down" | "ranging" | "transitional" | "unknown" | "mixed";

export type VolatilityBand = "quiet" | "normal" | "volatile" | "unknown";

export interface MarketRegime {
  trend: TrendRegime;
  volatility: VolatilityBand;
  /** ADX at the measured bar, for the reader who wants the number. */
  adx: number | null;
  /** ATR as a percentage of price. */
  atrPct: number | null;
  /** Where that ATR sits in the pair's own recent history, 0–1. */
  atrPercentile: number | null;
  /** Bars the answer rests on. Below the minimum, everything is `unknown`. */
  bars: number;
}

/** Conventional ADX reading. Above this is a trend. */
export const ADX_TRENDING = 25;
/** Below this is a range. Between the two is genuinely neither. */
export const ADX_RANGING = 20;

const ADX_PERIOD = 14;
const ATR_PERIOD = 14;
/** ADX needs about two periods of warm-up before the value means anything. */
const MIN_BARS = ADX_PERIOD * 2 + 5;
/** Window the ATR percentile is measured against — the pair's own recent past. */
const VOL_LOOKBACK = 100;

const UNKNOWN: MarketRegime = {
  trend: "unknown",
  volatility: "unknown",
  adx: null,
  atrPct: null,
  atrPercentile: null,
  bars: 0,
};

function lastFinite(values: unknown[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Classify the market as of the **last bar in `bars`**.
 *
 * Point-in-time by construction: pass only the bars up to the moment being
 * classified. Handing in the whole series and asking about a past bar would be
 * look-ahead — the same bias the level resolver is careful about — and it
 * matters here because regimes are computed retrospectively, at the timestamp
 * of a trade that closed weeks ago.
 */
export function classifyRegime(bars: CandleNumeric[]): MarketRegime {
  if (bars.length < MIN_BARS) return { ...UNKNOWN, bars: bars.length };

  /* `.values`, not the result object — and note what that array contains:
     the warm-up is null-padded, but for MULTI-OUTPUT indicators a NaN field is
     cleaned to **0**, not to null. An ADX of 0 would classify as "ranging"
     with total confidence, which is the unknown-read-as-zero defect this
     codebase keeps paying for. Hence the `adx > 0` guard below. */
  const adxSeries = computeFromCandles(bars, "adx", { period: ADX_PERIOD }).values as Array<
    Record<string, number> | null
  >;
  const atrSeries = computeFromCandles(bars, "atr", { period: ATR_PERIOD }).values as Array<
    number | null
  >;

  /* Read the last bar that actually produced a value. The indicator library
     pads the warm-up with nulls, and taking `series[series.length - 1]` blindly
     is how a null becomes a zero becomes a confident "ranging". */
  let latest: Record<string, number> | null = null;
  for (let i = adxSeries.length - 1; i >= 0; i--) {
    const v = adxSeries[i];
    /* `> 0` rather than `Number.isFinite`: a cleaned NaN arrives as 0, and a
       genuine zero ADX does not occur in a real series. */
    if (v && typeof v.adx === "number" && Number.isFinite(v.adx) && v.adx > 0) {
      latest = v;
      break;
    }
  }
  if (!latest || typeof latest.adx !== "number") return { ...UNKNOWN, bars: bars.length };

  const adx = latest.adx;
  const pdi = typeof latest.pdi === "number" && Number.isFinite(latest.pdi) ? latest.pdi : null;
  const mdi = typeof latest.mdi === "number" && Number.isFinite(latest.mdi) ? latest.mdi : null;

  let trend: TrendRegime;
  if (adx >= ADX_TRENDING) {
    /* A trend with no readable direction is still a trend, but calling it "up"
       on a coin flip would be worse than admitting it is transitional. */
    if (pdi === null || mdi === null) trend = "transitional";
    else trend = pdi >= mdi ? "trending_up" : "trending_down";
  } else if (adx <= ADX_RANGING) {
    trend = "ranging";
  } else {
    trend = "transitional";
  }

  /* Volatility relative to the pair's OWN recent history. An absolute ATR%
     threshold would classify a quiet week on a small alt as a storm. */
  const atr = lastFinite(atrSeries);
  const close = bars[bars.length - 1]!.close;
  const atrPct = atr !== null && close > 0 ? (atr / close) * 100 : null;

  let volatility: VolatilityBand = "unknown";
  let atrPercentile: number | null = null;
  if (atr !== null) {
    const window = atrSeries
      .slice(-VOL_LOOKBACK)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (window.length >= 20) {
      const below = window.filter((v) => v < atr).length;
      atrPercentile = below / window.length;
      volatility = atrPercentile >= 0.7 ? "volatile" : atrPercentile <= 0.3 ? "quiet" : "normal";
    }
  }

  return { trend, volatility, adx, atrPct, atrPercentile, bars: bars.length };
}

/**
 * Does a lesson learned in `learned` apply to a market that is `now`?
 *
 * Conservative on purpose. The failure that matters is applying a trend lesson
 * in a range and losing money on it — not withholding a lesson that might have
 * helped. So an unknown on either side is **not** a match: the lesson is still
 * shown, but labelled, and the labelling is what stops the agent treating it as
 * established fact.
 */
export function regimeApplies(learned: TrendRegime, now: TrendRegime): boolean {
  /* Evidence that spanned several regimes held regardless of conditions, which
     makes it the most transferable kind there is. */
  if (learned === "mixed") return true;
  if (learned === "unknown" || now === "unknown") return false;
  if (learned === now) return true;
  /* Transitional sits between the two named states rather than beside them, so
     it is treated as compatible with either — but never as a trend match. */
  if (learned === "transitional" || now === "transitional") return true;
  return false;
}

/** Plain-language form, for a prompt or a screen. */
export function describeRegime(r: MarketRegime): string {
  const trend =
    r.trend === "trending_up"
      ? "trending up"
      : r.trend === "trending_down"
        ? "trending down"
        : r.trend === "ranging"
          ? "ranging"
          : r.trend === "transitional"
            ? "neither trending nor ranging cleanly"
            : "not yet measurable";
  if (r.trend === "unknown") return `${trend} (only ${r.bars} bars)`;
  const vol = r.volatility === "unknown" ? "" : `, ${r.volatility} volatility`;
  return `${trend}${vol}`;
}

/**
 * The single regime a body of evidence came from, or `mixed`.
 *
 * `mixed` requires a genuine spread rather than one stray bar: a lesson drawn
 * from nine ranging trades and one trending one is a ranging lesson, and
 * calling it mixed would grant it a transferability it has not earned.
 */
export function dominantRegime(regimes: TrendRegime[]): TrendRegime {
  const known = regimes.filter((r) => r !== "unknown" && r !== "mixed");
  if (known.length === 0) return "unknown";
  const counts = new Map<TrendRegime, number>();
  for (const r of known) counts.set(r, (counts.get(r) ?? 0) + 1);
  let best: TrendRegime = "unknown";
  let bestN = 0;
  for (const [r, n] of counts) if (n > bestN) [best, bestN] = [r, n];
  return bestN / known.length >= 0.7 ? best : "mixed";
}
