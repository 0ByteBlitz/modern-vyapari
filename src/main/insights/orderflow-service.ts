/**
 * Order-flow series for the UI (roadmap S1-4).
 *
 * **Main computes, the chart renders.** Research must never build its own CVD
 * or volume profile: two implementations of POC/VAH is the bug class this
 * project has already paid for three times (the paper-vs-backtest fill model,
 * the FX-contaminated candles, the two-charting-library precision split). The
 * chart draws exactly the numbers the engine would decide on.
 *
 * That rule was already being broken. The registered `CVD` chart indicator
 * computed `delta = close >= open ? +volume : −volume` — "the bar closed
 * green, so call all of it buying". That is not volume delta and has nothing
 * to do with which side was the aggressor; it is a plausible-looking line
 * wearing CVD's name, and a trader would read divergences off it. It is
 * replaced by these values.
 *
 * Reads the analysis feed only (`${FEED_SCOPE_SQL}`, via the level resolver's
 * `dbCandleSource`), so a profile drawn here and a level resolved by the paper
 * engine come from one cached history.
 */

import { createLogger } from "../logger";
import { dbCandleSource } from "./level-resolver";
import { computeCvd } from "./anchored";
import { computeVolumeProfile, suggestBinWidth, VolumeProfileError } from "./volume-profile";
import type { CandleNumeric } from "./indicator-types";
import { AppError } from "../../shared/errors";
import type { CvdSeries, VolumeProfileView } from "../../shared/ipc-types";
import type { ProfileDistribution } from "../../shared/levels";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

const log = createLogger("orderflow");

/** Cap on how many bars a single request will read, so a 1m series over a year
 *  can't be pulled into memory by a UI toggle. */
const MAX_BARS = 5000;

function loadBars(symbol: string, intervalMin: number, fromMs?: number, toMs?: number, limit?: number): CandleNumeric[] {
  const end = toMs ?? Date.now();
  const capped = Math.min(limit ?? MAX_BARS, MAX_BARS);
  // When no explicit start is given, walk back `capped` bars from the end.
  const start = fromMs ?? end - capped * intervalMin * 60_000;
  const bars = dbCandleSource(symbol, intervalMin, start, end);
  return bars.length > capped ? bars.slice(bars.length - capped) : bars;
}

/* ── CVD ────────────────────────────────────────────────────────────── */

/**
 * Cumulative volume delta over the requested window.
 *
 * CVD's absolute value is meaningless — it accumulates from an arbitrary
 * origin — so only slope and divergence against price carry information. That
 * is why `anchorMs` matters and why `coverage` is returned alongside: a series
 * that goes `null` partway is reporting a gap in the aggressor split, not a
 * flattening of aggression, and the UI must be able to tell the difference.
 *
 * This is Binance **spot** flow. It says nothing about Revolut X's much
 * thinner book and must never be read as a claim about the venue orders
 * actually execute on.
 */
export function getCvdSeries(
  symbol: string,
  intervalMin: number,
  opts: { anchorMs?: number; limit?: number } = {}
): CvdSeries {
  const bars = loadBars(symbol, intervalMin, opts.anchorMs, undefined, opts.limit);

  if (bars.length === 0) {
    return {
      symbol,
      intervalMin,
      anchorMs: opts.anchorMs ?? null,
      points: [],
      coverage: 0,
      firstUnknownAt: null,
      suggestedAnchor: null,
      barsUsed: 0,
    };
  }

  const result = computeCvd(bars);

  return {
    symbol,
    intervalMin,
    anchorMs: opts.anchorMs ?? bars[0]!.timestamp,
    points: result.points.map((p) => ({ timestamp: p.timestamp, delta: p.delta, cvd: p.cvd })),
    coverage: result.coverage,
    firstUnknownAt: result.firstUnknownAt,
    suggestedAnchor: result.suggestedAnchor,
    barsUsed: result.barsUsed,
  };
}

/* ── Volume profile ─────────────────────────────────────────────────── */

export interface VolumeProfileRequest {
  symbol: string;
  intervalMin: number;
  /** Anchor. Omit for "the visible window", which the caller passes explicitly. */
  fromMs?: number;
  /** Window end. Omit for developing (up to the latest cached bar). */
  toMs?: number;
  /** Price-unit bin height. Omit to use `suggestBinWidth`, which is then
   *  returned so the caller can persist it — see the note below. */
  binWidth?: number;
  valueAreaPct?: number;
  distribution?: ProfileDistribution;
}

/**
 * Volume profile for a window, as bins plus POC/VAH/VAL.
 *
 * **`binWidth` is suggested once, then belongs to the caller.** If it is
 * omitted the service proposes one and returns it; a UI that keeps asking for
 * "auto" would get a different width as history grows, so the level would move
 * for a reason that has nothing to do with the market. Anything that outlives
 * the moment — a saved reference, a plan — must send back the width it was
 * given.
 *
 * The result is explicitly `approximate`: a profile from OHLCV spreads each
 * bar's volume across its range by a rule rather than placing it where it
 * actually traded, and the rule materially moves the POC. Every display must
 * say so.
 */
export function getVolumeProfile(req: VolumeProfileRequest): VolumeProfileView {
  const { symbol, intervalMin } = req;
  const bars = loadBars(symbol, intervalMin, req.fromMs, req.toMs);

  if (bars.length === 0) {
    throw new AppError("VALIDATION", `No cached ${symbol} ${intervalMin}m history in that window.`, {
      hint: "Load the pair on the chart first, or widen the window.",
    });
  }

  const binWidth = req.binWidth ?? suggestBinWidth(bars);
  const valueAreaPct = req.valueAreaPct ?? 70;
  const distribution = req.distribution ?? "uniform";

  try {
    const p = computeVolumeProfile(bars, { binWidth, valueAreaPct, distribution });
    return {
      symbol,
      intervalMin,
      bins: p.bins.map((b) => ({ low: b.low, high: b.high, mid: b.mid, volume: b.volume, buyVolume: b.buyVolume })),
      poc: p.poc,
      pocBinIndex: p.pocBinIndex,
      vah: p.vah,
      val: p.val,
      totalVolume: p.totalVolume,
      barsUsed: p.barsUsed,
      binWidth: p.binWidth,
      valueAreaPct: p.valueAreaPct,
      distribution: p.distribution,
      window: p.window,
      deltaKnown: p.deltaKnown,
      approximate: true,
      binWidthWasSuggested: req.binWidth === undefined,
    };
  } catch (err) {
    if (err instanceof VolumeProfileError) {
      throw new AppError("VALIDATION", err.message);
    }
    log.error(`Volume profile failed for ${symbol} ${intervalMin}m`, err);
    throw err;
  }
}
