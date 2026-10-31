/**
 * Level resolution (roadmap S1-1, plan §17.6).
 *
 * The arithmetic is already covered by `volume-tools.test.ts`. What is tested
 * here are the three properties that make a resolver safe to put in front of an
 * engine that decides money:
 *
 *   • **point-in-time** — a resolution as of bar `i` cannot see bar `i+1`;
 *   • **incremental == fresh** — carrying accumulator state forward gives the
 *     same answer as computing from the anchor, including after a rewind;
 *   • **unresolvable stays unresolvable** — never a substitute number.
 *
 * The candle source is injected, so none of this touches SQLite or a network.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LevelResolver, isResolvableSource } from "../insights/level-resolver";
import type { CandleSource } from "../insights/level-resolver";
import type { CandleNumeric } from "../insights/indicator-types";
import type { DerivedLevel, PriceLevel } from "../../shared/levels";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;
const SYMBOL = "BTC-USD";
const INTERVAL = 60;

function bar(
  i: number,
  low: number,
  high: number,
  close: number,
  volume: number,
  takerBuyVolume: number | null = volume / 2
): CandleNumeric {
  return {
    timestamp: T + i * HOUR,
    open: (low + high) / 2,
    high,
    low,
    close,
    volume,
    takerBuyVolume,
  };
}

/** A source over a fixed series, counting reads so the incremental claim can
 *  be checked rather than assumed. */
function sourceOver(series: CandleNumeric[]): CandleSource & { barsRead: number } {
  const fn = ((_symbol: string, _interval: number, fromMs: number, toMs: number) => {
    const rows = series.filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
    (fn as { barsRead: number }).barsRead += rows.length;
    return rows;
  }) as CandleSource & { barsRead: number };
  fn.barsRead = 0;
  return fn;
}

const ctx = (asOf: number) => ({ symbol: SYMBOL, intervalMin: INTERVAL, asOf });

function avwap(overrides: Partial<DerivedLevel> = {}): DerivedLevel {
  return {
    kind: "derived",
    source: "avwap",
    params: {},
    window: { from: T, to: "developing" },
    field: "vwap",
    resolve: "live",
    resolvedAtArm: 100,
    driftTolerance: { pct: 50 },
    onDrift: "invalidate",
    ...overrides,
  };
}

describe("LevelResolver — point-in-time", () => {
  const series = [
    bar(0, 100, 102, 101, 10),
    bar(1, 101, 103, 102, 10),
    bar(2, 200, 260, 250, 1000), // a violent bar the earlier resolutions must not see
  ];

  test("a resolution as of bar i is unaffected by bars after i", () => {
    const early = new LevelResolver(sourceOver(series)).resolve(avwap(), ctx(T + 1 * HOUR));

    // Same bar, but resolved by a resolver that has already been walked to the
    // end and back — the answer must be identical.
    const walked = new LevelResolver(sourceOver(series));
    walked.resolve(avwap(), ctx(T + 2 * HOUR));
    const rewound = walked.resolve(avwap(), ctx(T + 1 * HOUR));

    assert.ok(early.price !== null);
    assert.ok(rewound.price !== null);
    assert.ok(
      Math.abs(early.price! - rewound.price!) < 1e-9,
      `going forward then back changed the answer: ${early.price} vs ${rewound.price}`
    );
    // And it is genuinely the pre-spike value, not the post-spike one.
    assert.ok(early.price! < 110, `bar 2's spike leaked backwards: ${early.price}`);
  });

  test("resolving forward incrementally matches resolving each bar fresh", () => {
    const incremental = new LevelResolver(sourceOver(series));
    for (let i = 0; i < series.length; i++) {
      const asOf = T + i * HOUR;
      const stepwise = incremental.resolve(avwap(), ctx(asOf));
      const fresh = new LevelResolver(sourceOver(series)).resolve(avwap(), ctx(asOf));
      assert.ok(stepwise.price !== null && fresh.price !== null);
      assert.ok(
        Math.abs(stepwise.price! - fresh.price!) < 1e-9,
        `bar ${i}: incremental ${stepwise.price} vs fresh ${fresh.price}`
      );
    }
  });

  test("each bar is read from the source once, not the whole window every time", () => {
    /* Path-dependent accumulators recomputed from the anchor each bar are O(n)
       per bar — O(n²) across a replay, which is the constraint plan §17 calls
       out by name. */
    const src = sourceOver(series);
    const resolver = new LevelResolver(src);
    for (let i = 0; i < series.length; i++) resolver.resolve(avwap(), ctx(T + i * HOUR));

    assert.equal(src.barsRead, series.length, `read ${src.barsRead} bars for ${series.length} resolutions`);
  });

  test("an anchor later than the bar being evaluated is unresolvable, not zero", () => {
    const r = new LevelResolver(sourceOver(series)).resolve(
      avwap({ window: { from: T + 10 * HOUR, to: "developing" } }),
      ctx(T)
    );
    assert.equal(r.price, null);
    assert.ok(r.unavailableReason);
  });
});

describe("LevelResolver — sources", () => {
  const series = [
    bar(0, 100, 102, 101, 10),
    bar(1, 101, 103, 102, 20),
    bar(2, 100, 104, 103, 30),
  ];

  test("volume-profile fields resolve and report the POC's bin", () => {
    const level: DerivedLevel = {
      kind: "derived",
      source: "volume_profile",
      params: { binWidth: 1, valueAreaPct: 70, distribution: "uniform" },
      window: { from: T, to: "developing" },
      field: "poc",
      resolve: "live",
      resolvedAtArm: 102.5,
      driftTolerance: { binChange: true },
      onDrift: "reconfirm",
    };

    const r = new LevelResolver(sourceOver(series)).resolve(level, ctx(T + 2 * HOUR));
    assert.ok(r.price !== null, r.unavailableReason);
    assert.equal(typeof r.pocBinIndex, "number");
  });

  test("CVD is unresolvable when any bar's aggressor split is unknown", () => {
    /* Reading a missing split as 0 yields delta = −volume: a bar of pure
       aggressive selling that never happened. Silence is the honest output. */
    const withGap = [bar(0, 100, 102, 101, 10), bar(1, 101, 103, 102, 20, null), bar(2, 100, 104, 103, 30)];
    const level = avwap({ source: "cvd", field: "cvd", resolvedAtArm: 5 });

    const r = new LevelResolver(sourceOver(withGap)).resolve(level, ctx(T + 2 * HOUR));
    assert.equal(r.price, null);
    assert.match(r.unavailableReason ?? "", /aggressor split/i);
  });

  test("VWAP band fields resolve above and below the VWAP", () => {
    const resolver = new LevelResolver(sourceOver(series));
    const mid = resolver.resolve(avwap(), ctx(T + 2 * HOUR));
    const upper = resolver.resolve(avwap({ field: "upper_2" }), ctx(T + 2 * HOUR));
    const lower = resolver.resolve(avwap({ field: "lower_2" }), ctx(T + 2 * HOUR));

    assert.ok(mid.price !== null && upper.price !== null && lower.price !== null);
    assert.ok(lower.price! < mid.price! && mid.price! < upper.price!);
  });

  test("sources the resolver cannot compute say so rather than going silent", () => {
    assert.equal(isResolvableSource("ichimoku"), false);
    assert.equal(isResolvableSource("fib"), false);
    assert.equal(isResolvableSource("avwap"), true);

    const r = new LevelResolver(sourceOver(series)).resolve(
      avwap({ source: "ichimoku", field: "kijun" }),
      ctx(T + 2 * HOUR)
    );
    assert.equal(r.price, null);
    assert.match(r.unavailableReason ?? "", /isn't implemented/i);
  });

  test("a static level resolves to itself and needs no history", () => {
    const level: PriceLevel = { kind: "static", price: 71800 };
    const r = new LevelResolver(sourceOver([])).resolve(level, ctx(T));
    assert.equal(r.price, 71800);
  });

  test("snapshot_at_arm returns the armed value verbatim, without recomputing", () => {
    /* The trader's thesis was about that price. Honour it literally — and note
       the source is empty here, so any recomputation would have failed. */
    const r = new LevelResolver(sourceOver([])).resolve(
      avwap({ resolve: "snapshot_at_arm", resolvedAtArm: 71800 }),
      ctx(T + 99 * HOUR)
    );
    assert.equal(r.price, 71800);
    assert.equal(r.drifted, false);
  });
});

describe("LevelResolver — drift", () => {
  const series = [bar(0, 100, 102, 101, 10), bar(1, 101, 103, 102, 10)];

  test("a level inside its tolerance is not flagged", () => {
    const r = new LevelResolver(sourceOver(series)).resolve(
      avwap({ resolvedAtArm: 101.5, driftTolerance: { pct: 10 } }),
      ctx(T + 1 * HOUR)
    );
    assert.equal(r.drifted, false);
    assert.ok(Math.abs(r.driftPct ?? 99) < 10);
  });

  test("a level that has wandered past its tolerance is flagged", () => {
    /* The §17.6 danger: a plan armed against VAH at 71,800 firing three days
       later at 74,200 is the same words describing a different trade. */
    const r = new LevelResolver(sourceOver(series)).resolve(
      avwap({ resolvedAtArm: 50, driftTolerance: { pct: 5 } }),
      ctx(T + 1 * HOUR)
    );
    assert.equal(r.drifted, true);
    assert.ok((r.driftPct ?? 0) > 5);
  });

  test("an ATR tolerance that cannot be measured fails closed", () => {
    /* Same rule the risk engine's quote cap now follows: a guard that cannot
       measure the thing it guards must not wave it through. Two bars is far
       short of ATR(14)'s warmup. */
    const r = new LevelResolver(sourceOver(series)).resolve(
      avwap({ resolvedAtArm: 101.5, driftTolerance: { atr: 2 } }),
      ctx(T + 1 * HOUR)
    );
    assert.equal(r.price, null, "an unguarded developing level must not be usable");
    assert.equal(r.drifted, true);
    assert.match(r.unavailableReason ?? "", /ATR/i);
  });
});
