/**
 * Order-flow coverage and history repair (roadmap S1-3).
 *
 * The point of this suite is that the *report* is trustworthy. A repair whose
 * coverage figure is assumed rather than measured is the same failure as every
 * other entry in this project's bug list — a number presented with more
 * confidence than it earned. So the assertions are about honesty:
 *
 *   • unknown means unknown, whether stored as NULL or "";
 *   • a series that cannot be refetched says so, and says why;
 *   • a repair that healed nothing reports that it healed nothing.
 *
 * `setupTestDb()` puts the network guard in offline mode, so `fetchKlineRange`
 * writes zero bars here. That is deliberate: it exercises the path where the
 * fetch achieves nothing, which is precisely where a function is tempted to
 * report success it did not earn.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, seedTestCandles } from "./test-helper";
import { getDb } from "../db/database";
import {
  listCandleCoverage,
  getCandleCoverage,
  repairCandleHistory,
} from "../data/candle-repair";
import type { CandleNumeric } from "../insights/indicator-types";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;

function bars(count: number, takerBuy: (i: number) => number | null | undefined): CandleNumeric[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: T + i * HOUR,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    takerBuyVolume: takerBuy(i),
  }));
}

describe("Candle coverage reporting", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("counts known vs unknown aggressor splits", () => {
    // First 4 bars unknown (pre-v11), last 6 known.
    seedTestCandles("BTC-USD", 60, bars(10, (i) => (i < 4 ? null : 6)));

    const c = getCandleCoverage("BTC-USD", 60);
    assert.ok(c);
    assert.equal(c!.totalBars, 10);
    assert.equal(c!.knownBars, 6);
    assert.ok(Math.abs(c!.coverage - 0.6) < 1e-9);
    assert.equal(c!.firstUnknownMs, T);
    assert.equal(c!.lastUnknownMs, T + 3 * HOUR);
    assert.equal(c!.repairable, true);
  });

  test('an empty-string split counts as unknown, matching what the reader does', () => {
    /* `toNumericCandle` reads "" as null. If the coverage report disagreed it
       would claim CVD should work while CVD said it doesn't — worse than no
       report at all. */
    seedTestCandles("BTC-USD", 60, bars(3, () => 5));
    getDb()
      .prepare(`UPDATE candles SET taker_buy_volume = '' WHERE start_ms = ?`)
      .run(T);

    const c = getCandleCoverage("BTC-USD", 60);
    assert.equal(c!.knownBars, 2);
    assert.equal(c!.firstUnknownMs, T);
  });

  test("full coverage reports no unknown span at all", () => {
    seedTestCandles("BTC-USD", 60, bars(5, () => 6));
    const c = getCandleCoverage("BTC-USD", 60);
    assert.equal(c!.coverage, 1);
    assert.equal(c!.firstUnknownMs, null);
    assert.equal(c!.lastUnknownMs, null);
  });

  test("a non-USD quote is reported as unrepairable, with the reason", () => {
    /* Fetching BASEUSDT and storing it under a GBP symbol is exactly the FX
       contamination schema v8 had to purge. Refuse rather than repeat it. */
    seedTestCandles("BTC-GBP", 60, bars(4, () => null));

    const c = getCandleCoverage("BTC-GBP", 60);
    assert.equal(c!.repairable, false);
    assert.match(c!.blockedReason ?? "", /non-USD quote/i);
  });

  test("an interval Binance REST can't serve is unrepairable, not silently skipped", () => {
    seedTestCandles("BTC-USD", 7, bars(4, () => null));
    const c = getCandleCoverage("BTC-USD", 7);
    assert.equal(c!.repairable, false);
    assert.match(c!.blockedReason ?? "", /backfill supports/i);
  });

  test("the list is ordered worst-coverage first, so it reads as a work queue", () => {
    seedTestCandles("AAA-USD", 60, bars(10, () => 5));          // 100%
    seedTestCandles("BBB-USD", 60, bars(10, (i) => (i < 9 ? null : 5))); // 10%
    seedTestCandles("CCC-USD", 60, bars(10, (i) => (i < 5 ? null : 5))); // 50%

    const list = listCandleCoverage().map((c) => c.symbol);
    assert.deepEqual(list, ["BBB-USD", "CCC-USD", "AAA-USD"]);
  });

  test("an uncached series is absent rather than reported as 0% of nothing", () => {
    assert.equal(getCandleCoverage("NOPE-USD", 60), null);
  });
});

describe("Candle history repair", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a complete series is a no-op that fetches nothing", async () => {
    seedTestCandles("BTC-USD", 60, bars(5, () => 6));

    const r = await repairCandleHistory("BTC-USD", 60);
    assert.equal(r.barsFetched, 0);
    assert.equal(r.healed, 0);
    assert.equal(r.stillUnknown, 0);
    assert.equal(r.after.coverage, 1);
  });

  test("a repair that healed nothing says so instead of claiming success", async () => {
    /* Offline, so the fetch writes nothing. The result must reflect reality:
       the bars are still unknown and the report must not round that away.
       "A stub must fail loudly" — ROADMAP §7. */
    seedTestCandles("BTC-USD", 60, bars(8, () => null));

    const r = await repairCandleHistory("BTC-USD", 60);
    assert.equal(r.healed, 0);
    assert.equal(r.stillUnknown, 8);
    assert.equal(r.after.coverage, 0);
    assert.equal(r.before.totalBars, r.after.totalBars, "repair must not drop rows");
  });

  test("repairing an unrepairable series is refused, not attempted", async () => {
    seedTestCandles("BTC-GBP", 60, bars(4, () => null));
    await assert.rejects(
      () => repairCandleHistory("BTC-GBP", 60),
      (err: Error) => /non-USD quote/i.test(err.message)
    );
  });

  test("repairing an uncached series is refused with a usable hint", async () => {
    await assert.rejects(
      () => repairCandleHistory("NOPE-USD", 60),
      (err: Error) => /No cached/i.test(err.message)
    );
  });
});
