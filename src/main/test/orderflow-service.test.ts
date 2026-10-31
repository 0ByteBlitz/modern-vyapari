/**
 * Order-flow series served to the chart (roadmap S1-4).
 *
 * The property under test is the one the rule exists for: **main computes, the
 * chart renders**. So these assert that the service returns the numbers a
 * strategy condition would resolve against, and that it is honest about what
 * it could not compute — a CVD that silently drew through a gap in the
 * aggressor split would be reporting flat aggression that never happened.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, seedTestCandles } from "./test-helper";
import { getCvdSeries, getVolumeProfile } from "../insights/orderflow-service";
import { computeVolumeProfile } from "../insights/volume-profile";
import type { CandleNumeric } from "../insights/indicator-types";

const HOUR = 3_600_000;
/** Anchored near "now" so the service's default lookback window covers it. */
const T = Math.floor((Date.now() - 50 * HOUR) / HOUR) * HOUR;

function bars(specs: Array<{ tb: number | null; vol?: number; low?: number; high?: number }>): CandleNumeric[] {
  return specs.map((s, i) => ({
    timestamp: T + i * HOUR,
    open: 100,
    high: s.high ?? 101,
    low: s.low ?? 99,
    close: 100.5,
    volume: s.vol ?? 10,
    takerBuyVolume: s.tb,
  }));
}

describe("CVD series for the chart", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("accumulates real delta from the aggressor split, not from candle colour", () => {
    /* The indicator this replaced used `close >= open ? +volume : -volume` —
       it measured whether the bar was green. Every bar here closes green and
       yet CVD must fall, because the aggressor was the seller. */
    seedTestCandles("BTC-USD", 60, bars([{ tb: 2 }, { tb: 2 }, { tb: 2 }]));

    const s = getCvdSeries("BTC-USD", 60);
    assert.equal(s.barsUsed, 3);
    assert.equal(s.coverage, 1);
    // delta = 2*2 - 10 = -6 per bar.
    assert.equal(s.points[0]!.cvd, -6);
    assert.equal(s.points[2]!.cvd, -18);
  });

  test("goes null after a gap rather than reporting a short sum", () => {
    seedTestCandles("BTC-USD", 60, bars([{ tb: 8 }, { tb: null }, { tb: 8 }]));

    const s = getCvdSeries("BTC-USD", 60);
    assert.equal(s.points[0]!.cvd, 6);
    assert.equal(s.points[1]!.cvd, null, "the unknown bar itself");
    assert.equal(
      s.points[2]!.cvd,
      null,
      "and everything after it — a cumulative series cannot skip a bar and stay cumulative"
    );
    assert.ok(s.coverage < 1);
    assert.equal(s.firstUnknownAt, T + HOUR);
    assert.equal(s.suggestedAnchor, T + 2 * HOUR, "offer the last unbroken run as a re-anchor point");
  });

  test("an empty window is empty, not zero", () => {
    const s = getCvdSeries("NOPE-USD", 60);
    assert.equal(s.barsUsed, 0);
    assert.equal(s.points.length, 0);
    assert.equal(s.coverage, 0);
  });
});

describe("Volume profile served to the chart", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("matches the pure computation exactly — the chart draws main's numbers", () => {
    /* If these two could disagree we would be back to two implementations of
       VAH, which is the bug class this project has paid for three times. */
    const fixture = bars([
      { tb: 6, vol: 100, low: 100.1, high: 100.8 },
      { tb: 5, vol: 10, low: 100.4, high: 102.5 },
    ]);
    seedTestCandles("BTC-USD", 60, fixture);

    const served = getVolumeProfile({ symbol: "BTC-USD", intervalMin: 60, binWidth: 1 });
    const pure = computeVolumeProfile(fixture, {
      binWidth: 1,
      valueAreaPct: 70,
      distribution: "uniform",
    });

    assert.equal(served.poc, pure.poc);
    assert.equal(served.vah, pure.vah);
    assert.equal(served.val, pure.val);
    assert.equal(served.pocBinIndex, pure.pocBinIndex);
    assert.equal(served.bins.length, pure.bins.length);
    assert.equal(served.approximate, true, "candle-derived profiles must self-identify");
  });

  test("an omitted bin width is suggested AND flagged, so a caller can persist it", () => {
    /* Asking for "auto" again later would give a different width as history
       grows, moving the level for a non-market reason. The flag is how a
       caller knows it must store what it was given. */
    seedTestCandles("BTC-USD", 60, bars([{ tb: 5 }, { tb: 5 }]));

    const p = getVolumeProfile({ symbol: "BTC-USD", intervalMin: 60 });
    assert.ok(p.binWidth > 0);
    assert.equal(p.binWidthWasSuggested, true);

    const pinned = getVolumeProfile({ symbol: "BTC-USD", intervalMin: 60, binWidth: p.binWidth });
    assert.equal(pinned.binWidthWasSuggested, false);
    assert.equal(pinned.binWidth, p.binWidth);
  });

  test("one unknown split nulls the whole buy breakdown", () => {
    seedTestCandles("BTC-USD", 60, bars([{ tb: 6 }, { tb: null }]));
    const p = getVolumeProfile({ symbol: "BTC-USD", intervalMin: 60, binWidth: 1 });

    assert.equal(p.deltaKnown, false);
    assert.ok(p.bins.every((b) => b.buyVolume === null));
  });

  test("an empty window is refused with a usable hint, not served as a flat profile", () => {
    assert.throws(() => getVolumeProfile({ symbol: "NOPE-USD", intervalMin: 60 }), /No cached/i);
  });
});
