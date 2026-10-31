import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession, createTestStrategy, seedTestCandles } from "./test-helper";
import { runBacktest } from "../backtest/backtester";
import { PaperExchangeEngine } from "../paper/paper-exchange";
import type { StrategySpec } from "../strategy/strategy-spec";
import type { CandleNumeric } from "../insights/indicator-types";
import { getDb } from "../db/database";

describe("Fill-Model Equivalence Suite", () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    cleanupTestDb();
  });

  const baseSpec: StrategySpec = {
    id: "test-rsi-strat",
    pair: "BTC-USD",
    type: "signal",
    entry: {
      logic: "and",
      conditions: [
        {
          indicator: "price",
          params: {},
          field: "close",
          operator: "above",
          value: 100,
        },
      ],
    },
    exit: {
      logic: "and",
      conditions: [
        {
          indicator: "price",
          params: {},
          field: "close",
          operator: "above",
          value: 110,
        },
      ],
    },
    sizing: {
      mode: "fixed_quote",
      amount: 1000,
    },
    schedule: {
      eval_interval: "15m",
    },
    risk: {
      max_open_positions: 1,
      max_daily_trades: 10,
      stop_loss_pct: 5,
      take_profit_pct: 10,
    },
  };

  test("Signal entry and signal exit produce identical fill and PnL metrics", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    createTestStrategy(session.id, baseSpec, "paper");

    // Candle series (15m interval)
    // Bar 0: below 100 (no entry)
    // Bar 1: close = 105 (>100 -> entry trigger on close)
    // Bar 2: close = 107 (holding position)
    // Bar 3: close = 112 (>110 -> exit trigger on close)
    const baseTime = 1700000000000;
    const intervalMs = 15 * 60 * 1000;
    const candles: CandleNumeric[] = [
      { timestamp: baseTime, open: 98, high: 99, low: 97, close: 98, volume: 10 },
      { timestamp: baseTime + intervalMs, open: 99, high: 106, low: 98, close: 105, volume: 15 },
      { timestamp: baseTime + intervalMs * 2, open: 105, high: 108, low: 104, close: 107, volume: 20 },
      { timestamp: baseTime + intervalMs * 3, open: 107, high: 114, low: 106, close: 112, volume: 25 },
    ];

    // Seed DB candles
    seedTestCandles("BTC-USD", 15, candles);

    // 1. Run Backtester
    const backtestRes = runBacktest(baseSpec, candles, {
      walkForwardSplit: 1.0,
      initialCapital: 10000,
      feeRateTakerBps: 25,
      slippageBps: 5,
    });

    assert.equal(backtestRes.tradeLog.length, 1, "Backtester should produce 1 trade");
    const btTrade = backtestRes.tradeLog[0]!;

    // 2. Run Paper Engine
    const paper = new PaperExchangeEngine();
    paper.start(false);

    // Feed candles tick by tick
    for (const c of candles) {
      paper.handleCandle("BTC-USD", 15, {
        start: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        closed: true,
      });
    }

    paper.stop();

    // Query paper trade and position from DB
    const db = getDb();
    const paperPos = db.prepare("SELECT * FROM paper_positions WHERE session_id = ?").get(session.id) as any;
    assert.ok(paperPos, "Paper position should exist in DB");
    assert.equal(paperPos.status, "closed", "Paper position should be closed");
    assert.equal(paperPos.exit_reason, "exit_signal", "Exit reason should be exit_signal");

    // Compare entry fill price
    const paperEntryPrice = parseFloat(paperPos.entry_price);
    assert.ok(Math.abs(paperEntryPrice - btTrade.entryPrice) < 0.0001, `Entry price mismatch: paper ${paperEntryPrice} vs bt ${btTrade.entryPrice}`);

    // Compare exit fill price
    const paperExitPrice = parseFloat(paperPos.exit_price);
    assert.ok(Math.abs(paperExitPrice - btTrade.exitPrice) < 0.01, `Exit price mismatch: paper ${paperExitPrice} vs bt ${btTrade.exitPrice}`);

    // Compare realized PnL
    const paperPnl = parseFloat(paperPos.realized_pnl);
    assert.ok(Math.abs(paperPnl - btTrade.netPnl) < 0.01, `PnL mismatch: paper ${paperPnl} vs bt ${btTrade.netPnl}`);
  });

  test("Intrabar Stop-Loss fill equivalence", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    createTestStrategy(session.id, baseSpec, "paper");

    // Bar 0: no entry
    // Bar 1: close = 105 (entry) -> entry fill at 105 * 1.0005 = 105.0525
    // Stop loss @ 5% below entry -> ~99.799875
    // Bar 2: low drops to 95 -> triggers stop loss!
    const baseTime = 1700000000000;
    const intervalMs = 15 * 60 * 1000;
    const candles: CandleNumeric[] = [
      { timestamp: baseTime, open: 98, high: 99, low: 97, close: 98, volume: 10 },
      { timestamp: baseTime + intervalMs, open: 99, high: 106, low: 98, close: 105, volume: 15 },
      { timestamp: baseTime + intervalMs * 2, open: 105, high: 106, low: 95, close: 98, volume: 20 },
    ];

    seedTestCandles("BTC-USD", 15, candles);

    const backtestRes = runBacktest(baseSpec, candles, {
      walkForwardSplit: 1.0,
      initialCapital: 10000,
    });

    assert.equal(backtestRes.tradeLog.length, 1);
    const btTrade = backtestRes.tradeLog[0]!;
    assert.equal(btTrade.exitReason, "stop_loss");

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of candles) {
      paper.handleCandle("BTC-USD", 15, {
        start: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        closed: true,
      });
    }
    paper.stop();

    const db = getDb();
    const paperPos = db.prepare("SELECT * FROM paper_positions WHERE session_id = ?").get(session.id) as any;
    assert.equal(paperPos.status, "closed");
    assert.equal(paperPos.exit_reason, "stop_loss");
    assert.ok(Math.abs(parseFloat(paperPos.exit_price) - btTrade.exitPrice) < 0.0001);
  });

  test("Intrabar Take-Profit fill equivalence", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    createTestStrategy(session.id, baseSpec, "paper");

    // Bar 0: no entry
    // Bar 1: close = 105 (entry) -> fill @ ~105.05
    // Take profit @ 10% above entry -> ~115.55
    // Bar 2: high spikes to 120 -> triggers take profit!
    const baseTime = 1700000000000;
    const intervalMs = 15 * 60 * 1000;
    const candles: CandleNumeric[] = [
      { timestamp: baseTime, open: 98, high: 99, low: 97, close: 98, volume: 10 },
      { timestamp: baseTime + intervalMs, open: 99, high: 106, low: 98, close: 105, volume: 15 },
      { timestamp: baseTime + intervalMs * 2, open: 105, high: 120, low: 104, close: 108, volume: 20 },
    ];

    seedTestCandles("BTC-USD", 15, candles);

    const backtestRes = runBacktest(baseSpec, candles, {
      walkForwardSplit: 1.0,
      initialCapital: 10000,
    });

    assert.equal(backtestRes.tradeLog.length, 1);
    const btTrade = backtestRes.tradeLog[0]!;
    assert.equal(btTrade.exitReason, "take_profit");

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of candles) {
      paper.handleCandle("BTC-USD", 15, {
        start: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        closed: true,
      });
    }
    paper.stop();

    const db = getDb();
    const paperPos = db.prepare("SELECT * FROM paper_positions WHERE session_id = ?").get(session.id) as any;
    assert.equal(paperPos.status, "closed");
    assert.equal(paperPos.exit_reason, "take_profit");
    assert.ok(Math.abs(parseFloat(paperPos.exit_price) - btTrade.exitPrice) < 0.0001);
  });
});
