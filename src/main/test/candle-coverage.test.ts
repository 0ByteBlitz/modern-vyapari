import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, seedTestCandles } from "./test-helper";
import { getAnalysisCandles } from "../data/analysis-candles";
import type { CandleNumeric } from "../insights/indicator-types";

describe("Candle Coverage & Integrity Suite", () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    cleanupTestDb();
  });

  test("Rejects non-USD quote currencies loudly", async () => {
    await assert.rejects(
      async () => {
        await getAnalysisCandles("BTC-GBP", 15, 100);
      },
      (err: Error) => {
        return err.message.includes("non-USD quote currency");
      }
    );

    await assert.rejects(
      async () => {
        await getAnalysisCandles("ETH-EUR", 60, 100);
      },
      (err: Error) => {
        return err.message.includes("non-USD quote currency");
      }
    );
  });

  test("Rejects invalid symbol formats", async () => {
    await assert.rejects(
      async () => {
        await getAnalysisCandles("BTCUSD", 15, 100);
      },
      (err: Error) => {
        return err.message.includes("Invalid symbol format");
      }
    );
  });

  test("Rejects unsupported intervals", async () => {
    await assert.rejects(
      async () => {
        await getAnalysisCandles("BTC-USD", 7 as any, 100);
      },
      (err: Error) => {
        return err.message.includes("Unsupported interval");
      }
    );
  });

  test("Returns correctly ordered ascending candles from cache", async () => {
    const baseTime = 1700000000000;
    const intervalMs = 15 * 60 * 1000;
    
    // Seed 10 candles
    const candles: CandleNumeric[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: baseTime + i * intervalMs,
      open: 100 + i,
      high: 105 + i,
      low: 99 + i,
      close: 102 + i,
      volume: 10 + i,
    }));

    seedTestCandles("BTC-USD", 15, candles);

    // Turn off network sync fallback by seeding enough coverage
    const res = await getAnalysisCandles("BTC-USD", 15, 10);
    assert.equal(res.length, 10, "Should return 10 candles");
    
    // Assert strictly ascending timestamps
    for (let i = 1; i < res.length; i++) {
      assert.ok(res[i]!.start > res[i - 1]!.start, `Timestamp out of order at index ${i}`);
      assert.equal(res[i]!.start - res[i - 1]!.start, intervalMs, `Interval mismatch at index ${i}`);
    }
  });
});
