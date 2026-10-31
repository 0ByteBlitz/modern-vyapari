/**
 * Anchored, path-dependent accumulators (plan §17.8).
 *
 * Anchored VWAP, VWAP standard-deviation bands, and CVD are the same shape of
 * object: start at an anchor, accumulate forward, one value per bar. Volume
 * profile is the fourth member of the family but produces a histogram rather
 * than a series, so it lives in `volume-profile.ts`.
 *
 * Two properties are deliberate and load-bearing:
 *
 *  1. **Incremental.** Each result is produced in a single pass, carrying state
 *     forward bar to bar. Recomputing from the anchor at every bar would be
 *     O(n) per bar — O(n²) across a dry-run or backtest replay.
 *  2. **Point-in-time.** Element `i` of every returned series depends only on
 *     bars `0..i`. That makes it safe to replay: reading element `i` while
 *     standing on bar `i` cannot see the future.
 *
 * Pure functions, no DB, no IPC.
 */

import type { CandleNumeric } from "./indicator-types";
import { barDelta } from "./indicator-types";

/** Typical price — the VWAP convention, matching `technicalindicators`' VWAP so
 *  the anchored and rolling versions cannot disagree about what "price" means. */
function typicalPrice(c: CandleNumeric): number {
  return (c.high + c.low + c.close) / 3;
}

/* ── Anchored VWAP (+ σ bands) ───────────────────────────────────────── */

export interface AnchoredVwapPoint {
  timestamp: number;
  /** null until the accumulator has seen any volume. */
  vwap: number | null;
  /** Volume-weighted standard deviation of typical price about the VWAP. */
  stdDev: number | null;
}

export interface AnchoredVwapResult {
  points: AnchoredVwapPoint[];
  /** Band multipliers this result was computed for, echoed back. */
  bands: number[];
  /** `bands[i]` → the series of upper/lower values, aligned with `points`. */
  bandValues: Array<{ multiplier: number; upper: (number | null)[]; lower: (number | null)[] }>;
  barsUsed: number;
}

/**
 * Anchored VWAP with optional standard-deviation bands.
 *
 * AVWAP is effectively **non-repainting**: it only ever appends, so a value
 * once printed never changes. That makes it the safest developing reference to
 * plan against — it glides, unlike a profile POC, which teleports between bins.
 *
 * The variance uses West's incremental weighted algorithm rather than the
 * textbook `E[x²] − E[x]²`. The naive form subtracts two large, nearly equal
 * numbers and on crypto price scales can produce a small negative variance,
 * which then becomes `NaN` under the square root — a band that silently
 * disappears mid-chart.
 */
export class AnchoredVwapAccumulator {
  private weightSum = 0;
  private mean = 0;  // volume-weighted mean of typical price
  private sqSum = 0; // weighted sum of squared deviations from the running mean
  private lastTs: number | null = null;
  private bars = 0;

  /** Fold one bar in and return the accumulator's value AS OF that bar. */
  add(c: CandleNumeric): AnchoredVwapPoint {
    const w = c.volume > 0 ? c.volume : 0;
    const x = typicalPrice(c);

    if (w > 0) {
      const nextWeight = this.weightSum + w;
      const delta = x - this.mean;
      const increment = (delta * w) / nextWeight;
      this.mean += increment;
      this.sqSum += this.weightSum * delta * increment;
      this.weightSum = nextWeight;
    }

    this.lastTs = c.timestamp;
    this.bars++;
    return { timestamp: c.timestamp, ...this.current() };
  }

  /** Current VWAP and σ, without advancing. Both null before any volume. */
  current(): { vwap: number | null; stdDev: number | null } {
    if (!(this.weightSum > 0)) return { vwap: null, stdDev: null };
    const variance = this.sqSum / this.weightSum;
    return { vwap: this.mean, stdDev: variance > 0 ? Math.sqrt(variance) : 0 };
  }

  get lastTimestamp(): number | null {
    return this.lastTs;
  }

  get barsUsed(): number {
    return this.bars;
  }
}

export function computeAnchoredVwap(
  candles: CandleNumeric[],
  bands: number[] = []
): AnchoredVwapResult {
  const points: AnchoredVwapPoint[] = [];
  const bandValues = bands.map((multiplier) => ({
    multiplier,
    upper: [] as (number | null)[],
    lower: [] as (number | null)[],
  }));

  const acc = new AnchoredVwapAccumulator();

  for (const c of candles) {
    const point = acc.add(c);
    points.push(point);

    for (const band of bandValues) {
      if (point.vwap === null || point.stdDev === null) {
        band.upper.push(null);
        band.lower.push(null);
      } else {
        band.upper.push(point.vwap + band.multiplier * point.stdDev);
        band.lower.push(point.vwap - band.multiplier * point.stdDev);
      }
    }
  }

  return { points, bands, bandValues, barsUsed: candles.length };
}

/* ── Cumulative Volume Delta ─────────────────────────────────────────── */

export interface CvdPoint {
  timestamp: number;
  /** Per-bar delta (`2×takerBuy − volume`), or null when unknown for that bar. */
  delta: number | null;
  /**
   * Cumulative delta from the anchor.
   *
   * **null once a gap has been crossed.** A cumulative series cannot skip a bar
   * and remain a cumulative series: the sum after a gap is short by exactly the
   * bars that couldn't be read, and it would be indistinguishable from a genuine
   * flattening of aggression. Silence is the honest output.
   */
  cvd: number | null;
}

export interface CvdResult {
  points: CvdPoint[];
  /** Fraction of bars with a known aggressor split, 0..1. */
  coverage: number;
  /** Timestamp of the first bar whose split was unknown, if any. */
  firstUnknownAt: number | null;
  /**
   * The earliest anchor from which CVD is computable with no gaps — i.e. the
   * first bar of the final unbroken known run. The UI offers this as
   * "re-anchor here" instead of just reporting that CVD is unavailable.
   */
  suggestedAnchor: number | null;
  barsUsed: number;
}

/**
 * Cumulative Volume Delta from an anchor.
 *
 * CVD's **absolute value is meaningless** — it accumulates from an arbitrary
 * origin, so only its slope and its divergence against price carry information.
 * That is why it is inherently anchored and can never be a global running total.
 *
 * Sourced from Binance's per-bar taker-buy volume (`k.V` live, kline index 9 on
 * backfill), which makes it exact at bar resolution. Intrabar footprint and
 * delta-at-price would need the `@aggTrade` stream and trade-level storage;
 * that is deliberately not built (plan §17.8).
 *
 * This is Binance **spot** order flow. It says nothing about Revolut X's thin,
 * entirely different book, and must never be read as a claim about the venue
 * orders actually execute on.
 */
export class CvdAccumulator {
  private running = 0;
  private broken = false;
  private known = 0;
  private bars = 0;
  private firstTs: number | null = null;
  private firstUnknown: number | null = null;
  /** Start of the current unbroken run of known bars. */
  private runStart: number | null = null;
  private lastRunStart: number | null = null;
  private lastTs: number | null = null;

  /** Fold one bar in and return the series point AS OF that bar. */
  add(c: CandleNumeric): CvdPoint {
    this.bars++;
    this.lastTs = c.timestamp;
    if (this.firstTs === null) this.firstTs = c.timestamp;

    const delta = barDelta(c);
    if (delta === null) {
      this.broken = true;
      if (this.firstUnknown === null) this.firstUnknown = c.timestamp;
      this.runStart = null;
      return { timestamp: c.timestamp, delta: null, cvd: null };
    }

    this.known++;
    if (this.runStart === null) {
      this.runStart = c.timestamp;
      this.lastRunStart = c.timestamp;
    }
    this.running += delta;
    return { timestamp: c.timestamp, delta, cvd: this.broken ? null : this.running };
  }

  /** Cumulative value now — null once a gap has been crossed. */
  get value(): number | null {
    return this.broken || this.bars === 0 ? null : this.running;
  }

  get lastTimestamp(): number | null {
    return this.lastTs;
  }

  summary(): Omit<CvdResult, "points"> {
    return {
      coverage: this.bars > 0 ? this.known / this.bars : 0,
      firstUnknownAt: this.firstUnknown,
      suggestedAnchor: this.broken ? this.lastRunStart : this.firstTs,
      barsUsed: this.bars,
    };
  }
}

export function computeCvd(candles: CandleNumeric[]): CvdResult {
  const acc = new CvdAccumulator();
  const points = candles.map((c) => acc.add(c));
  return { points, ...acc.summary() };
}

/**
 * CVD re-anchored to a specific timestamp, so a gap in old history doesn't make
 * the indicator permanently unavailable. Every bar cached before schema v11 has
 * an unknown aggressor split, so on an existing install this is the normal path
 * until history is refetched.
 */
export function computeCvdFromAnchor(candles: CandleNumeric[], anchorTs: number): CvdResult {
  return computeCvd(candles.filter((c) => c.timestamp >= anchorTs));
}
