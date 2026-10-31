/**
 * Volume profile — fixed-range and anchored (plan §17.8).
 *
 * Pure functions over `CandleNumeric[]`, no DB and no IPC, so they are testable
 * in isolation and there is exactly ONE implementation of POC/VAH/VAL in the
 * codebase. The Research chart renders these values; it must never compute its
 * own profile client-side. Two implementations of VAH is the bug class this
 * project has already paid for three times (paper-vs-backtest fill model,
 * FX-contaminated candles, the two-charting-library precision split).
 *
 * ── The honest caveat ───────────────────────────────────────────────────
 * A profile built from OHLCV is an **approximation, not a measurement**. A true
 * profile needs trade-level data to place volume at the price it actually
 * traded at. From candles, each bar's volume has to be spread across its
 * high→low range by a rule, and the choice of rule materially moves the POC.
 * So the rule and the bin width are part of the result's identity, are returned
 * with it, and every display must say the profile is candle-derived. A trader
 * who believes they are looking at a real profile will size differently from
 * one who knows it is an estimate.
 *
 * ── Where the bins start (changed 2026-07-30) ───────────────────────────
 * With an explicit `binWidth` the grid is now **absolute**: bin `i` is
 * `[i·w, (i+1)·w)`, independent of what the window contains. It used to be
 * anchored to the window's lowest low, which meant a developing profile's
 * entire grid shifted the moment a new low printed — every bin edge moved, and
 * the POC could jump to a different price with no volume having changed. That
 * is the same failure the "never an automatic bin width" rule exists to
 * prevent, just arriving through the origin instead of the width.
 *
 * It also makes the profile **accumulable**: absolute bin indices are stable as
 * bars are appended, so `VolumeProfileAccumulator` can fold bars in one at a
 * time instead of the resolver re-profiling the whole window per bar (O(n²)
 * across a replay). `binCount` mode stays window-anchored — it is only valid on
 * a CLOSED window, where the range is fixed and cannot shift underneath it.
 */

import type { CandleNumeric } from "./indicator-types";
import { barDelta } from "./indicator-types";
import type { ProfileDistribution, VolumeProfileParams } from "../../shared/levels";

export interface ProfileBin {
  /** Inclusive lower edge. */
  low: number;
  /** Exclusive upper edge (except the topmost bin, which includes its edge). */
  high: number;
  /** Mid price — what a level derived from this bin resolves to. */
  mid: number;
  volume: number;
  /**
   * Aggressive-buy share of this bin's volume, or null when the aggressor split
   * is unknown for any bar contributing to the profile. Never 0-as-unknown.
   */
  buyVolume: number | null;
}

export interface VolumeProfileResult {
  bins: ProfileBin[];
  /** Point of control — mid price of the highest-volume bin. */
  poc: number;
  /** Index of the POC bin. The unit a POC drift guard should watch: POC moves
   *  discontinuously between bins rather than gliding. */
  pocBinIndex: number;
  /** Value-area high / low — edges of the contiguous band around the POC that
   *  encloses `valueAreaPct` of total volume. */
  vah: number;
  val: number;
  totalVolume: number;
  barsUsed: number;
  /** Effective bin height in price units (derived from binCount when given). */
  binWidth: number;
  distribution: ProfileDistribution;
  valueAreaPct: number;
  window: { from: number; to: number };
  /** True when every contributing bar had a known aggressor split, so the
   *  per-bin buy/sell breakdown can be trusted. */
  deltaKnown: boolean;
  /** Always true: candle-derived, never tick-derived. Callers must surface it. */
  approximate: true;
}

export class VolumeProfileError extends Error {}

/* ── Distribution ───────────────────────────────────────────────────── */

/**
 * Spread one bar's volume across the bins it spans.
 *
 * `addTo(binIndex, volumeShare, buyShare)` receives each contribution. Bars
 * whose range is narrower than a bin land entirely in one bin, which is the
 * common case on high timeframes and the reason bin width matters so much.
 */
function distributeBar(
  candle: CandleNumeric,
  distribution: ProfileDistribution,
  binOf: (price: number) => number,
  addTo: (binIndex: number, volume: number, buyVolume: number | null) => void
): void {
  const vol = candle.volume;
  if (!(vol > 0)) return;

  const tb = candle.takerBuyVolume;
  const buyFraction = tb !== null && tb !== undefined && Number.isFinite(tb) && vol > 0 ? tb / vol : null;
  const share = (v: number) => (buyFraction === null ? null : v * buyFraction);

  if (distribution === "ohlc") {
    // Four equal quarters at the four recorded prices. Crude, but it makes no
    // claim about the path between them.
    const q = vol / 4;
    for (const p of [candle.open, candle.high, candle.low, candle.close]) {
      addTo(binOf(p), q, share(q));
    }
    return;
  }

  const lowBin = binOf(candle.low);
  const highBin = binOf(candle.high);
  const spanned = highBin - lowBin + 1;

  if (spanned <= 1) {
    addTo(lowBin, vol, share(vol));
    return;
  }

  if (distribution === "uniform") {
    const per = vol / spanned;
    const perBuy = share(per);
    for (let b = lowBin; b <= highBin; b++) addTo(b, per, perBuy);
    return;
  }

  // close_weighted: triangular, peaking at the bar's close.
  const closeBin = binOf(candle.close);
  const weights: number[] = [];
  let totalWeight = 0;
  for (let b = lowBin; b <= highBin; b++) {
    // Linear falloff with distance from the close bin, floored so no bin the
    // bar actually traded through gets zero volume.
    const w = 1 / (1 + Math.abs(b - closeBin));
    weights.push(w);
    totalWeight += w;
  }
  for (let i = 0; i < weights.length; i++) {
    const v = (vol * weights[i]!) / totalWeight;
    addTo(lowBin + i, v, share(v));
  }
}

/* ── Value area ─────────────────────────────────────────────────────── */

/**
 * Expand outward from the POC, at each step taking whichever adjacent side
 * holds more volume, until the enclosed volume reaches the target share. This
 * is the standard construction; it produces a CONTIGUOUS band, which is the
 * whole point — a value area with holes in it would not be a range you can plan
 * against.
 */
function valueAreaBounds(
  bins: ProfileBin[],
  pocIndex: number,
  totalVolume: number,
  valueAreaPct: number
): { vahIndex: number; valIndex: number } {
  const target = totalVolume * (valueAreaPct / 100);
  let lower = pocIndex;
  let upper = pocIndex;
  let acc = bins[pocIndex]?.volume ?? 0;

  while (acc < target && (lower > 0 || upper < bins.length - 1)) {
    const belowVol = lower > 0 ? bins[lower - 1]!.volume : -1;
    const aboveVol = upper < bins.length - 1 ? bins[upper + 1]!.volume : -1;

    if (aboveVol < 0 && belowVol < 0) break;

    if (aboveVol >= belowVol) {
      upper++;
      acc += bins[upper]!.volume;
    } else {
      lower--;
      acc += bins[lower]!.volume;
    }
  }

  return { vahIndex: upper, valIndex: lower };
}

/* ── The bin grid ───────────────────────────────────────────────────── */

/**
 * Maps price → bin index and back. Two flavours, and the difference is the
 * whole reason this abstraction exists:
 *
 *  • **absolute** (explicit `binWidth`) — `floor(price / w)`. Indices never move
 *    as the window grows, so a developing profile is stable and accumulable.
 *  • **window** (`binCount`) — divides an observed range into N. Only legal on a
 *    closed window; on a developing one the range grows and every edge shifts.
 */
interface BinGrid {
  width: number;
  binOf(price: number): number;
  lowOf(index: number): number;
  /** Topmost bin's upper edge, so a window grid can include its own high. */
  highOf(index: number): number;
}

function absoluteGrid(width: number): BinGrid {
  return {
    width,
    binOf: (p) => Math.floor(p / width),
    lowOf: (i) => i * width,
    highOf: (i) => (i + 1) * width,
  };
}

function windowGrid(lo: number, hi: number, count: number): BinGrid {
  const range = hi - lo;
  const width = range > 0 ? range / count : 1;
  return {
    width,
    binOf: (p) => {
      if (range <= 0) return 0;
      const idx = Math.floor((p - lo) / width);
      return idx < 0 ? 0 : idx >= count ? count - 1 : idx;
    },
    lowOf: (i) => lo + i * width,
    highOf: (i) => (i === count - 1 ? Math.max(hi, lo + (i + 1) * width) : lo + (i + 1) * width),
  };
}

/** Sparse accumulation state, keyed by grid index. */
interface Tallies {
  byBin: Map<number, { volume: number; buyVolume: number }>;
  totalVolume: number;
  /** False once ANY contributing bar had an unknown aggressor split. */
  deltaKnown: boolean;
  barsUsed: number;
  firstTs: number | null;
  lastTs: number | null;
}

function emptyTallies(): Tallies {
  return { byBin: new Map(), totalVolume: 0, deltaKnown: true, barsUsed: 0, firstTs: null, lastTs: null };
}

function tallyBar(t: Tallies, c: CandleNumeric, grid: BinGrid, distribution: ProfileDistribution): void {
  if (barDelta(c) === null) t.deltaKnown = false;
  t.totalVolume += c.volume > 0 ? c.volume : 0;
  t.barsUsed++;
  if (t.firstTs === null) t.firstTs = c.timestamp;
  t.lastTs = c.timestamp;

  distributeBar(c, distribution, grid.binOf, (binIndex, volume, buyVolume) => {
    let bin = t.byBin.get(binIndex);
    if (!bin) {
      bin = { volume: 0, buyVolume: 0 };
      t.byBin.set(binIndex, bin);
    }
    bin.volume += volume;
    if (buyVolume !== null) bin.buyVolume += buyVolume;
  });
}

/**
 * Turn tallies into a result. The single place POC and the value area are
 * computed, shared by the one-shot and incremental paths — two implementations
 * of VAH is the bug class this project has already paid for three times.
 */
function finaliseProfile(
  t: Tallies,
  grid: BinGrid,
  params: VolumeProfileParams
): VolumeProfileResult {
  if (t.totalVolume <= 0 || t.byBin.size === 0) {
    throw new VolumeProfileError("Profile window contains no volume.");
  }

  let minIdx = Infinity;
  let maxIdx = -Infinity;
  for (const idx of t.byBin.keys()) {
    if (idx < minIdx) minIdx = idx;
    if (idx > maxIdx) maxIdx = idx;
  }

  // Densify: the value area must be contiguous, so empty bins between two
  // traded ones are real bins with zero volume, not gaps to be skipped.
  const bins: ProfileBin[] = [];
  for (let i = minIdx; i <= maxIdx; i++) {
    const tally = t.byBin.get(i);
    const low = grid.lowOf(i);
    const high = grid.highOf(i);
    bins.push({
      low,
      high,
      mid: (low + high) / 2,
      volume: tally?.volume ?? 0,
      // One unknown aggressor split poisons the whole buy/sell breakdown: a
      // partial sum reported as the bin's buy volume understates it by exactly
      // the bars we couldn't read. Null the field rather than be quietly wrong.
      buyVolume: t.deltaKnown ? (tally?.buyVolume ?? 0) : null,
    });
  }

  let pocBinIndex = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i]!.volume > bins[pocBinIndex]!.volume) pocBinIndex = i;
  }

  const { vahIndex, valIndex } = valueAreaBounds(bins, pocBinIndex, t.totalVolume, params.valueAreaPct);

  return {
    bins,
    poc: bins[pocBinIndex]!.mid,
    pocBinIndex,
    vah: bins[vahIndex]!.high,
    val: bins[valIndex]!.low,
    totalVolume: t.totalVolume,
    barsUsed: t.barsUsed,
    binWidth: grid.width,
    distribution: params.distribution,
    valueAreaPct: params.valueAreaPct,
    window: { from: t.firstTs ?? 0, to: t.lastTs ?? 0 },
    deltaKnown: t.deltaKnown,
    approximate: true,
  };
}

function validateParams(params: VolumeProfileParams): void {
  if (!(params.valueAreaPct > 0 && params.valueAreaPct <= 100)) {
    throw new VolumeProfileError(`valueAreaPct must be in (0, 100], got ${params.valueAreaPct}.`);
  }
  if (params.binWidth !== undefined && !(params.binWidth > 0)) {
    throw new VolumeProfileError("binWidth must be positive.");
  }
  if (params.binCount !== undefined && (!Number.isInteger(params.binCount) || params.binCount < 1)) {
    throw new VolumeProfileError("binCount must be a positive integer.");
  }
  if (params.binWidth === undefined && params.binCount === undefined) {
    throw new VolumeProfileError(
      "A volume profile needs an explicit binWidth or binCount — never an automatic one, " +
        "because an auto width changes as history grows and moves the level for a non-market reason."
    );
  }
}

/* ── Main entry ─────────────────────────────────────────────────────── */

/**
 * Build a volume profile from the candles in a window.
 *
 * **Point-in-time by construction:** it profiles exactly the candles handed to
 * it. A replay must therefore pass only bars at or before the bar being
 * evaluated — profiling the full range and then replaying it is look-ahead
 * bias, and an anchored-profile strategy would backtest beautifully on levels
 * that did not yet exist.
 */
export function computeVolumeProfile(
  candles: CandleNumeric[],
  params: VolumeProfileParams
): VolumeProfileResult {
  if (candles.length === 0) throw new VolumeProfileError("No candles in the profile window.");
  validateParams(params);

  const grid = params.binWidth !== undefined
    ? absoluteGrid(params.binWidth)
    : rangeGridFor(candles, params.binCount!);

  const tallies = emptyTallies();
  for (const c of candles) tallyBar(tallies, c, grid, params.distribution);
  return finaliseProfile(tallies, grid, params);
}

function rangeGridFor(candles: CandleNumeric[], binCount: number): BinGrid {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new VolumeProfileError("Profile window has no usable price range.");
  }
  return windowGrid(lo, hi, binCount);
}

/* ── Incremental accumulation ───────────────────────────────────────── */

/**
 * A developing profile that bars are folded into one at a time.
 *
 * Requires an explicit `binWidth` — with `binCount` the grid is derived from
 * the observed range, so appending a bar that extends the range would move
 * every boundary and silently rewrite the history already accumulated. A
 * developing profile must be pinned to an absolute grid or it isn't one.
 *
 * Feed bars in ascending timestamp order and never twice: the accumulator sums
 * contributions and cannot un-see a bar. `lastTimestamp` is what a caller uses
 * to know where to resume from.
 */
export class VolumeProfileAccumulator {
  private readonly grid: BinGrid;
  private readonly tallies = emptyTallies();

  constructor(private readonly params: VolumeProfileParams) {
    validateParams(params);
    if (params.binWidth === undefined) {
      throw new VolumeProfileError(
        "A developing profile needs an explicit binWidth. binCount derives the grid from the " +
          "observed range, so a new high or low would move every bin edge and rewrite the level."
      );
    }
    this.grid = absoluteGrid(params.binWidth);
  }

  add(candle: CandleNumeric): void {
    tallyBar(this.tallies, candle, this.grid, this.params.distribution);
  }

  /** Timestamp of the last bar folded in, or null if none yet. */
  get lastTimestamp(): number | null {
    return this.tallies.lastTs;
  }

  get barsUsed(): number {
    return this.tallies.barsUsed;
  }

  /** Absolute grid index a price falls in — how a POC drift guard asks
   *  "has the mode moved to a different bin?" without re-deriving the grid. */
  binIndexOf(price: number): number {
    return this.grid.binOf(price);
  }

  /** Throws `VolumeProfileError` while no volume has been accumulated. */
  result(): VolumeProfileResult {
    return finaliseProfile(this.tallies, this.grid, this.params);
  }
}

/**
 * A bin width that suits a pair's price scale, for the authoring UI to propose.
 *
 * Deliberately a **suggestion that gets snapped and stored**, not a runtime
 * default: once a reference exists its bin width must never change again, or the
 * level moves without the market moving. Roughly `range / targetBins`, rounded
 * to a clean power-of-ten step so the number a trader sees is memorable.
 */
export function suggestBinWidth(candles: CandleNumeric[], targetBins = 60): number {
  if (candles.length === 0) return 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  const range = hi - lo;
  if (!(range > 0)) return Math.max(hi * 0.0001, Number.EPSILON);

  const raw = range / Math.max(1, targetBins);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  const snapped = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return snapped * magnitude;
}
