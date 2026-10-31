/**
 * Market regime, measured rather than guessed.
 *
 * This exists so a lesson can carry the conditions it was learned under. That
 * only helps if the measurement is honest, so most of these tests are about the
 * ways it could quietly lie:
 *
 *  • answering "ranging" when it has no idea;
 *  • calling nine ranging trades and one trending one "mixed", which would
 *    grant a lesson transferability it never earned;
 *  • claiming a conditions match when the current regime is unknown.
 *
 * The classifier is deliberately not asked to be clever. ADX and ATR are
 * conventional and reproducible, which is the point — a model asked "is this
 * trending?" would always answer, fluently, with nothing to check it against,
 * and that answer would be stamped onto a memory injected into every prompt.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRegime,
  regimeApplies,
  dominantRegime,
  describeRegime,
  ADX_TRENDING,
  type TrendRegime,
} from "../insights/regime";
import type { CandleNumeric } from "../insights/indicator-types";

const T0 = 1_785_000_000_000;
const BAR = 240 * 60_000;

/**
 * Deterministic pseudo-random, so a fixture is reproducible across runs.
 *
 * The first version of these fixtures was noise-free — a clean arithmetic ramp
 * and a perfect two-bar zigzag. Both produced **ADX 100**, and the "ranging"
 * series classified as a strong trend. That is not a classifier bug: a
 * perfectly regular series is pathological for a directional-movement
 * indicator, and no market produces one. Loosening the thresholds to
 * accommodate it would have broken the measurement to save the test.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function build(closes: number[], r: () => number): CandleNumeric[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]!;
    return {
      timestamp: T0 + i * BAR,
      open: prev,
      high: Math.max(c, prev) * (1 + r() * 0.004),
      low: Math.min(c, prev) * (1 - r() * 0.004),
      close: c,
      volume: 100,
    };
  });
}

/** Steady drift with noise on top — a real trend, not a ramp. */
function trending(n: number, drift: number, seed: number): CandleNumeric[] {
  const r = rng(seed);
  let p = 100;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    p = p * (1 + drift + (r() - 0.5) * 0.006);
    out.push(p);
  }
  return build(out, rng(seed + 1));
}

/** Mean-reverting around 100 with noise — a real range. */
function ranging(n = 140, seed = 5): CandleNumeric[] {
  const r = rng(seed);
  let p = 100;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    p = p + (100 - p) * 0.25 + (r() - 0.5) * 3;
    out.push(p);
  }
  return build(out, rng(seed + 7));
}

const flat = (n: number) => build(Array.from({ length: n }, () => 100), rng(11));
const trendingUp = () => trending(140, 0.012, 1);
const trendingDown = () => trending(140, -0.012, 3);

describe("the classifier says what it can measure", () => {
  test("a sustained one-way move is a trend, with a direction", () => {
    const r = classifyRegime(trendingUp());
    assert.equal(r.trend, "trending_up");
    assert.ok(r.adx !== null && r.adx >= ADX_TRENDING, `ADX should be trending, got ${r.adx}`);
  });

  test("direction is read from the directional indicators, not from the price delta", () => {
    /* Reading "it went down, so trending_down" would be a second, disagreeing
       implementation of the same idea — the one-definition rule. */
    assert.equal(classifyRegime(trendingDown()).trend, "trending_down");
  });

  test("oscillation with no net progress is a range", () => {
    assert.equal(classifyRegime(ranging()).trend, "ranging");
  });

  test("volatility is a percentile of the pair's own history, not an absolute", () => {
    const r = classifyRegime(trendingUp());
    /* An absolute ATR% threshold would call a quiet week on a small alt a
       storm. Comparing a pair to itself is the only version that transfers. */
    assert.ok(r.atrPercentile === null || (r.atrPercentile >= 0 && r.atrPercentile <= 1));
    assert.ok(["quiet", "normal", "volatile", "unknown"].includes(r.volatility));
  });
});

describe("the classifier refuses to invent an answer", () => {
  test("too little history is unknown, never a default bucket", () => {
    /* ADX needs about two periods of warm-up. Returning "ranging" here would
       stamp a fabricated condition onto a lesson — the missing-taker-volume
       defect in a new costume. */
    for (const n of [0, 1, 10, 25]) {
      const r = classifyRegime(flat(n));
      assert.equal(r.trend, "unknown", `${n} bars must be unknown`);
      assert.equal(r.adx, null);
    }
  });

  test("an unknown regime never counts as a match, in either direction", () => {
    /* The failure that costs money is applying a trend lesson in a range. So
       an unknown on either side is not a match — the lesson is still shown,
       but labelled, and the label is what stops it reading as fact. */
    assert.equal(regimeApplies("unknown", "ranging"), false);
    assert.equal(regimeApplies("trending_up", "unknown"), false);
    assert.equal(regimeApplies("unknown", "unknown"), false);
  });

  test("describeRegime says how thin the evidence is when it cannot answer", () => {
    assert.match(describeRegime(classifyRegime(flat(3))), /3 bars/);
  });
});

describe("matching is conservative", () => {
  test("a lesson matches its own regime", () => {
    assert.equal(regimeApplies("ranging", "ranging"), true);
    assert.equal(regimeApplies("trending_up", "trending_up"), true);
  });

  test("a trend lesson does not apply in a range", () => {
    assert.equal(regimeApplies("trending_up", "ranging"), false);
    assert.equal(regimeApplies("ranging", "trending_down"), false);
    /* And up is not down — the direction is the point of recording it. */
    assert.equal(regimeApplies("trending_up", "trending_down"), false);
  });

  test("a mixed lesson applies everywhere, because it already held everywhere", () => {
    for (const now of ["ranging", "trending_up", "trending_down", "unknown"] as TrendRegime[]) {
      assert.equal(regimeApplies("mixed", now), true);
    }
  });

  test("transitional is compatible with either side, but is not a trend match", () => {
    assert.equal(regimeApplies("transitional", "ranging"), true);
    assert.equal(regimeApplies("trending_up", "transitional"), true);
  });
});

describe("mixed has to be earned", () => {
  test("a clear majority is that regime, not mixed", () => {
    /* Nine ranging trades and one trending one is a ranging lesson. Calling it
       mixed would grant it a transferability the evidence does not support. */
    const mostlyRanging: TrendRegime[] = [...Array(9).fill("ranging"), "trending_up"];
    assert.equal(dominantRegime(mostlyRanging), "ranging");
  });

  test("a genuine spread is mixed", () => {
    assert.equal(dominantRegime(["ranging", "ranging", "trending_up", "trending_down"]), "mixed");
  });

  test("unknown evidence yields unknown, not a guess", () => {
    assert.equal(dominantRegime(["unknown", "unknown"]), "unknown");
    assert.equal(dominantRegime([]), "unknown");
  });

  test("unknowns are ignored rather than dragging the answer to mixed", () => {
    /* Otherwise a pair with thin history would produce "mixed" lessons, which
       is the most transferable tag there is — earned by having no data. */
    assert.equal(dominantRegime(["ranging", "ranging", "ranging", "unknown"]), "ranging");
  });
});
