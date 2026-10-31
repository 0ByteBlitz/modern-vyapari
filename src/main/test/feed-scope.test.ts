/**
 * The analysis feed's scope, pinned (roadmap S2-9).
 *
 * Eighteen SQL predicates across ten files said `source = 'binance'`. Those
 * sit under every number the app produces — levels, indicators, backtests,
 * paper fills, CVD — so consolidating them is the one change in this refactor
 * that can move a number *silently* rather than break loudly.
 *
 * This test is the guard, and it was written and run **before** the
 * consolidation so its expected values describe the old behaviour. The
 * mechanism is a **decoy**: every fixture seeds a second candle from a
 * different source at an absurd price. If the scope ever widens — a predicate
 * dropped, a helper that forgets its filter, a future feed writing into the
 * same table — the decoy is included and the assertions move. A test that only
 * checked "the right rows are there" would pass in that world.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, seedTestCandles } from "./test-helper";
import { getDb } from "../db/database";
import { LevelResolver, dbCandleSource } from "../insights/level-resolver";
import type { DerivedLevel } from "../../shared/levels";

const SYMBOL = "BTC-USD";
const INTERVAL = 240;
const BAR = INTERVAL * 60_000;
const T0 = 1_780_000_000_000;

/** 20 bars at a known, boring price so any contamination is obvious. */
function seed(): number {
  const candles = [];
  for (let i = 0; i < 20; i++) {
    candles.push({
      timestamp: T0 + i * BAR,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000,
      takerBuyVolume: 600,
    });
  }
  seedTestCandles(SYMBOL, INTERVAL, candles);

  /* The decoy. Same symbol, same interval, same timestamps — different source,
     and a price nothing could mistake for real. Any query that forgets to
     scope itself will pull these in and every assertion below will move. */
  const db = getDb();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO candles
       (symbol, interval_min, start_ms, open, high, low, close, volume, taker_buy_volume, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'revx')`
  );
  for (let i = 0; i < 20; i++) {
    ins.run(SYMBOL, INTERVAL, T0 + i * BAR, "9999", "9999", "9999", "9999", "9999", "5000");
  }
  return T0 + 19 * BAR;
}

const avwap = (): DerivedLevel => ({
  kind: "derived",
  source: "avwap",
  params: {},
  window: { from: T0, to: "developing" },
  field: "vwap",
  resolve: "live",
  resolvedAtArm: 100,
  driftTolerance: { pct: 50 },
  onDrift: "invalidate",
});

const profile = (): DerivedLevel => ({
  kind: "derived",
  source: "volume_profile",
  params: { binWidth: 1, valueAreaPct: 70, distribution: "uniform" },
  window: { from: T0, to: "developing" },
  field: "poc",
  resolve: "live",
  resolvedAtArm: 100,
  driftTolerance: { pct: 50 },
  onDrift: "invalidate",
});

describe("the analysis feed's scope is pinned", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("dbCandleSource returns ONLY analysis-feed bars", () => {
    const last = seed();
    const rows = dbCandleSource(SYMBOL, INTERVAL, T0, last);

    assert.equal(rows.length, 20, "20 analysis bars, not 40 — the decoy must be excluded");
    for (const r of rows) {
      assert.equal(r.close, 100, `a decoy bar leaked in: close ${r.close}`);
    }
  });

  test("an anchored VWAP resolves to the analysis price, not a blend", () => {
    /* If the decoy leaked, this would land somewhere between 100 and 9999 —
       a number that looks plausible and is fiction. That is the failure mode
       the whole feed-role rule exists to prevent. */
    const last = seed();
    const r = new LevelResolver().resolve(avwap(), { symbol: SYMBOL, intervalMin: INTERVAL, asOf: last });
    assert.equal(r.price, 100);
  });

  test("a volume profile's POC resolves to the analysis price", () => {
    const last = seed();
    const r = new LevelResolver().resolve(profile(), { symbol: SYMBOL, intervalMin: INTERVAL, asOf: last });
    assert.ok(r.price !== null);
    assert.ok(r.price! >= 99 && r.price! <= 101, `POC ${r.price} is outside the analysis range`);
  });

  test("the decoy really is in the table — otherwise this suite proves nothing", () => {
    /* Without this, a bug that stopped the fixture writing decoys would make
       every test above pass for the wrong reason. */
    seed();
    const n = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM candles WHERE symbol = ? AND source = 'revx'`)
      .get(SYMBOL) as unknown as { n: number };
    assert.equal(n.n, 20, "the decoy rows must exist for these assertions to mean anything");
  });
});
