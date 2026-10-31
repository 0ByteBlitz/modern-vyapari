/**
 * Volume-based tooling: profile, anchored VWAP, CVD (plan §17.8).
 *
 * The assertions that matter most here are not the arithmetic ones — they are
 * the two properties that make these safe to replay and safe to plan against:
 *
 *   • **point-in-time**: element `i` never changes when later bars arrive, so
 *     reading it while standing on bar `i` cannot see the future;
 *   • **unknown stays unknown**: a missing aggressor split must never be
 *     silently read as zero, which would fabricate a bar of pure selling.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeVolumeProfile,
  suggestBinWidth,
  VolumeProfileAccumulator,
  VolumeProfileError,
} from "../insights/volume-profile";
import { computeAnchoredVwap, computeCvd, computeCvdFromAnchor } from "../insights/anchored";
import { barDelta, toNumericCandle } from "../insights/indicator-types";
import type { CandleNumeric } from "../insights/indicator-types";

const T = 1_700_000_000_000;
const M = 60_000;

function bar(
  i: number,
  o: number, h: number, l: number, c: number,
  volume: number,
  takerBuyVolume?: number | null
): CandleNumeric {
  return { timestamp: T + i * M, open: o, high: h, low: l, close: c, volume, takerBuyVolume };
}

describe("Volume profile (candle-derived, plan §17.8)", () => {
  // c1 sits entirely inside the lowest bin and carries most of the volume;
  // c2 rakes upward across all three bins with very little.
  const candles: CandleNumeric[] = [
    bar(0, 100.2, 100.8, 100.1, 100.5, 100, 60),
    bar(1, 100.5, 102.5, 100.4, 102.0, 10, 5),
  ];

  test("POC lands in the highest-volume bin and the value area is contiguous", () => {
    const p = computeVolumeProfile(candles, {
      binWidth: 1,
      valueAreaPct: 70,
      distribution: "uniform",
    });

    // Absolute grid: bins are [100,101), [101,102), [102,103) — pinned to
    // multiples of the width, not to the window's low.
    assert.equal(p.bins.length, 3);
    assert.equal(p.pocBinIndex, 0);
    assert.ok(Math.abs(p.poc - 100.5) < 1e-9, `POC ${p.poc}`);

    // c1's 100 units alone exceed 70% of the 110 total, so the value area is
    // the POC bin by itself.
    assert.ok(Math.abs(p.val - 100) < 1e-9, `VAL ${p.val}`);
    assert.ok(Math.abs(p.vah - 101) < 1e-9, `VAH ${p.vah}`);
    assert.ok(p.val < p.poc && p.poc < p.vah, "value area must bracket the POC");
    assert.ok(Math.abs(p.totalVolume - 110) < 1e-9);
    assert.equal(p.approximate, true, "candle-derived profiles must self-identify as approximate");
  });

  test("value area encloses at least the requested share of volume", () => {
    for (const pct of [50, 70, 90]) {
      const p = computeVolumeProfile(candles, { binWidth: 0.5, valueAreaPct: pct, distribution: "uniform" });
      const enclosed = p.bins
        .filter((b) => b.low >= p.val - 1e-9 && b.high <= p.vah + 1e-9)
        .reduce((a, b) => a + b.volume, 0);
      assert.ok(
        enclosed >= p.totalVolume * (pct / 100) - 1e-6,
        `${pct}%: enclosed ${enclosed} of ${p.totalVolume}`
      );
    }
  });

  test("an automatic bin width is refused", () => {
    /* Auto binning would change the bin boundaries as history grows, moving the
       level for a reason that has nothing to do with the market. */
    assert.throws(
      () => computeVolumeProfile(candles, { valueAreaPct: 70, distribution: "uniform" }),
      VolumeProfileError
    );
  });

  test("one bar with an unknown aggressor split nulls the whole buy breakdown", () => {
    const withGap: CandleNumeric[] = [candles[0]!, bar(1, 100.5, 102.5, 100.4, 102.0, 10, null)];
    const p = computeVolumeProfile(withGap, { binWidth: 1, valueAreaPct: 70, distribution: "uniform" });

    assert.equal(p.deltaKnown, false);
    assert.ok(
      p.bins.every((b) => b.buyVolume === null),
      "a partial buy total reported as the bin's buy volume would be quietly wrong"
    );
    // Total volume is unaffected — only the aggressor split is unknown.
    assert.ok(Math.abs(p.totalVolume - 110) < 1e-9);
  });

  test("distribution rule changes the profile, and is reported back", () => {
    const uniform = computeVolumeProfile(candles, { binWidth: 1, valueAreaPct: 70, distribution: "uniform" });
    const weighted = computeVolumeProfile(candles, { binWidth: 1, valueAreaPct: 70, distribution: "close_weighted" });

    assert.equal(uniform.distribution, "uniform");
    assert.equal(weighted.distribution, "close_weighted");
    /* c2 spans bins 0–2 and closes at 102.0, which falls in the top bin
       ([102,103)). Uniform gives each spanned bin 10/3; close-weighting peaks
       on the close's bin. This is exactly why the rule is part of a reference's
       identity — it moves where the volume, and therefore the POC, ends up. */
    assert.ok(
      weighted.bins[2]!.volume > uniform.bins[2]!.volume,
      "close-weighted should concentrate c2's volume on its closing bin"
    );
    assert.ok(
      weighted.bins[1]!.volume < uniform.bins[1]!.volume,
      "and correspondingly less in the bin it only wicked through"
    );
  });

  test("point-in-time: profiling a prefix matches what that prefix looked like", () => {
    const prefix = computeVolumeProfile([candles[0]!], { binWidth: 1, valueAreaPct: 70, distribution: "uniform" });
    assert.equal(prefix.barsUsed, 1);
    assert.ok(Math.abs(prefix.totalVolume - 100) < 1e-9);
    // The later bar extended the range upward; the prefix must not know about it.
    assert.equal(prefix.bins.length, 1);
  });

  test("a new low does not move the bins under the volume that was already there", () => {
    /* The regression this guards: bins used to be anchored to the window's
       lowest low, so one new low shifted every edge and the POC could land on
       a different price with no volume having changed. That is the "auto bin
       width" failure arriving through the origin instead of the width. */
    const before = computeVolumeProfile(candles, { binWidth: 1, valueAreaPct: 70, distribution: "uniform" });

    // A tiny bar printing a new low, well away from the POC and carrying
    // almost no volume — it must not be able to relocate the mode.
    const withNewLow = [...candles, bar(2, 98.4, 98.5, 98.3, 98.45, 0.01, 0.005)];
    const after = computeVolumeProfile(withNewLow, { binWidth: 1, valueAreaPct: 70, distribution: "uniform" });

    assert.ok(Math.abs(after.poc - before.poc) < 1e-9, `POC moved ${before.poc} → ${after.poc}`);
  });

  test("accumulating bar by bar equals profiling the whole window at once", () => {
    /* The resolver folds bars in incrementally to stay O(1) per bar. If that
       path could disagree with the one-shot path we would be back to two
       implementations of VAH — the bug class this project has paid for three
       times already. */
    const params = { binWidth: 1, valueAreaPct: 70, distribution: "uniform" as const };
    const acc = new VolumeProfileAccumulator(params);
    for (const c of candles) acc.add(c);

    const incremental = acc.result();
    const oneShot = computeVolumeProfile(candles, params);

    assert.equal(incremental.bins.length, oneShot.bins.length);
    assert.ok(Math.abs(incremental.poc - oneShot.poc) < 1e-9);
    assert.ok(Math.abs(incremental.vah - oneShot.vah) < 1e-9);
    assert.ok(Math.abs(incremental.val - oneShot.val) < 1e-9);
    assert.ok(Math.abs(incremental.totalVolume - oneShot.totalVolume) < 1e-9);
    assert.equal(incremental.pocBinIndex, oneShot.pocBinIndex);
  });

  test("a developing profile refuses binCount", () => {
    /* binCount derives the grid from the observed range, so appending a bar
       that extends the range would move every boundary and rewrite history
       already accumulated. */
    assert.throws(
      () => new VolumeProfileAccumulator({ binCount: 20, valueAreaPct: 70, distribution: "uniform" }),
      VolumeProfileError
    );
  });

  test("suggestBinWidth returns a clean, positive step", () => {
    const w = suggestBinWidth(candles, 24);
    assert.ok(w > 0 && Number.isFinite(w));
    const mantissa = w / Math.pow(10, Math.floor(Math.log10(w)));
    assert.ok([1, 2, 5, 10].some((m) => Math.abs(mantissa - m) < 1e-9), `mantissa ${mantissa}`);
  });
});

describe("Anchored VWAP", () => {
  const candles: CandleNumeric[] = [
    bar(0, 100, 102, 98, 100, 10),
    bar(1, 100, 106, 100, 104, 30),
    bar(2, 104, 108, 102, 106, 20),
    bar(3, 106, 110, 104, 108, 40),
  ];

  test("first bar's VWAP is its own typical price", () => {
    const r = computeAnchoredVwap([candles[0]!]);
    assert.ok(Math.abs(r.points[0]!.vwap! - 100) < 1e-9, `${r.points[0]!.vwap}`);
    assert.equal(r.points[0]!.stdDev, 0, "a single observation has no dispersion");
  });

  test("VWAP is the volume-weighted mean of typical price", () => {
    const r = computeAnchoredVwap(candles);
    const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
    const num = tp.reduce((a, p, i) => a + p * candles[i]!.volume, 0);
    const den = candles.reduce((a, c) => a + c.volume, 0);
    assert.ok(Math.abs(r.points[3]!.vwap! - num / den) < 1e-9);
  });

  test("point-in-time: appending bars never rewrites an earlier value", () => {
    /* This is the property that makes AVWAP safe to replay, and the reason it's
       the least dangerous developing reference to plan against — it appends,
       it never repaints. */
    const full = computeAnchoredVwap(candles);
    for (let i = 0; i < candles.length; i++) {
      const prefix = computeAnchoredVwap(candles.slice(0, i + 1));
      assert.ok(
        Math.abs(prefix.points[i]!.vwap! - full.points[i]!.vwap!) < 1e-9,
        `bar ${i}: prefix ${prefix.points[i]!.vwap} vs full ${full.points[i]!.vwap}`
      );
    }
  });

  test("σ bands straddle the VWAP and never produce NaN", () => {
    const r = computeAnchoredVwap(candles, [1, 2]);
    assert.equal(r.bandValues.length, 2);
    for (const band of r.bandValues) {
      for (let i = 0; i < candles.length; i++) {
        const upper = band.upper[i]!;
        const lower = band.lower[i]!;
        const vwap = r.points[i]!.vwap!;
        assert.ok(Number.isFinite(upper) && Number.isFinite(lower), `NaN band at bar ${i}`);
        assert.ok(upper >= vwap - 1e-9 && lower <= vwap + 1e-9, `band ${i} does not straddle VWAP`);
      }
    }
    // Wider multiplier ⇒ wider band.
    assert.ok(r.bandValues[1]!.upper[3]! >= r.bandValues[0]!.upper[3]!);
  });
});

describe("CVD", () => {
  test("delta is 2×takerBuy − volume", () => {
    assert.equal(barDelta(bar(0, 1, 1, 1, 1, 10, 7)), 4);
    assert.equal(barDelta(bar(0, 1, 1, 1, 1, 10, 3)), -4);
    assert.equal(barDelta(bar(0, 1, 1, 1, 1, 10, 10)), 10, "all-aggressive-buy bar");
    assert.equal(barDelta(bar(0, 1, 1, 1, 1, 10, 0)), -10, "all-aggressive-sell bar");
  });

  test("an unknown split yields null delta, never a fabricated −volume", () => {
    assert.equal(barDelta(bar(0, 1, 1, 1, 1, 10, null)), null);
    assert.equal(barDelta(bar(0, 1, 1, 1, 1, 10, undefined)), null);
  });

  test("cumulative sum accumulates and coverage is complete when all bars are known", () => {
    const r = computeCvd([
      bar(0, 1, 1, 1, 1, 10, 7),
      bar(1, 1, 1, 1, 1, 10, 3),
      bar(2, 1, 1, 1, 1, 10, 10),
    ]);
    assert.deepEqual(r.points.map((p) => p.cvd), [4, 0, 10]);
    assert.equal(r.coverage, 1);
    assert.equal(r.firstUnknownAt, null);
    assert.equal(r.suggestedAnchor, T);
  });

  test("CVD goes null after a gap rather than reporting a short sum", () => {
    /* A cumulative series cannot skip a bar and stay cumulative: the sum after
       the gap is short by exactly the bars that couldn't be read, and would be
       indistinguishable from aggression genuinely flattening out. */
    const r = computeCvd([
      bar(0, 1, 1, 1, 1, 10, 7),
      bar(1, 1, 1, 1, 1, 10, null),
      bar(2, 1, 1, 1, 1, 10, 10),
    ]);

    assert.deepEqual(r.points.map((p) => p.cvd), [4, null, null]);
    assert.deepEqual(r.points.map((p) => p.delta), [4, null, 10]);
    assert.ok(Math.abs(r.coverage - 2 / 3) < 1e-9);
    assert.equal(r.firstUnknownAt, T + M);
    assert.equal(r.suggestedAnchor, T + 2 * M, "should offer the start of the last unbroken run");
  });

  test("re-anchoring past a gap restores a usable series", () => {
    const candles = [
      bar(0, 1, 1, 1, 1, 10, null),   // legacy bar, pre-v11
      bar(1, 1, 1, 1, 1, 10, 7),
      bar(2, 1, 1, 1, 1, 10, 3),
    ];
    const broken = computeCvd(candles);
    assert.equal(broken.points[2]!.cvd, null);

    const reanchored = computeCvdFromAnchor(candles, broken.suggestedAnchor!);
    assert.deepEqual(reanchored.points.map((p) => p.cvd), [4, 0]);
    assert.equal(reanchored.coverage, 1);
  });
});

describe("Candle row → numeric conversion", () => {
  test("a NULL taker_buy_volume becomes null, not 0", () => {
    const c = toNumericCandle({
      symbol: "BTC-USD", interval_min: 15, start_ms: T,
      open: "100", high: "101", low: "99", close: "100.5", volume: "10",
      taker_buy_volume: null, source: "binance",
    });
    assert.equal(c.takerBuyVolume, null);
    assert.equal(barDelta(c), null);
  });

  test("a present taker_buy_volume parses through to a usable delta", () => {
    const c = toNumericCandle({
      symbol: "BTC-USD", interval_min: 15, start_ms: T,
      open: "100", high: "101", low: "99", close: "100.5", volume: "10",
      taker_buy_volume: "7", source: "binance",
    });
    assert.equal(c.takerBuyVolume, 7);
    assert.equal(barDelta(c), 4);
  });
});
