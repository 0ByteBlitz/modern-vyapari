import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession, createTestStrategy, seedTestCandles } from "./test-helper";
import { runBacktest } from "../backtest/backtester";
import { PaperExchangeEngine } from "../paper/paper-exchange";
import type { StrategySpec } from "../strategy/strategy-spec";
import type { CandleNumeric } from "../insights/indicator-types";
import { getDb } from "../db/database";

describe("Dynamic Position Management Suite (Trailing SL & Breakeven SL)", () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    cleanupTestDb();
  });

  const trailingSpec: StrategySpec = {
    id: "test-trailing-strat",
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
          value: 500,
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
      max_daily_trades: 1,
      stop_loss_pct: 5, // initial stop 5%
      trailing_stop_pct: 3, // trailing stop 3%
    },
  };

  test("Trailing Stop-Loss advances stop price as price rises and triggers when price drops 3%", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    createTestStrategy(session.id, trailingSpec, "paper");

    const baseTime = 1700000000000;
    const intervalMs = 15 * 60 * 1000;
    const candles: CandleNumeric[] = [
      { timestamp: baseTime, open: 98, high: 99, low: 97, close: 98, volume: 10 },
      { timestamp: baseTime + intervalMs, open: 99, high: 106, low: 98, close: 105, volume: 15 },
      { timestamp: baseTime + intervalMs * 2, open: 105, high: 120, low: 104, close: 119, volume: 20 },
      { timestamp: baseTime + intervalMs * 3, open: 119, high: 120, low: 110, close: 95, volume: 25 },
    ];

    seedTestCandles("BTC-USD", 15, candles);

    // 1. Backtester Test
    const backtestRes = runBacktest(trailingSpec, candles, {
      walkForwardSplit: 1.0,
      initialCapital: 10000,
    });

    assert.equal(backtestRes.tradeLog.length, 1);
    const btTrade = backtestRes.tradeLog[0]!;
    assert.equal(btTrade.exitReason, "stop_loss");
    assert.ok(btTrade.exitPrice > btTrade.entryPrice, "Trailing stop should exit in PROFIT!");
    assert.ok(Math.abs(btTrade.exitPrice - 116.40) < 0.1, `Trailing fill price: ${btTrade.exitPrice}`);

    // 2. Paper Engine Test
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
    assert.ok(parseFloat(paperPos.realized_pnl) > 0, "Paper position realized PnL should be positive with trailing stop");

    /* The ratcheted stop must be WRITTEN DOWN, not just held in memory. It used
       to live only on the in-memory position, so the row kept the entry-time 5%
       stop (~99.8) while the engine was actually protecting at ~116.4 — and a
       restart handed back the ratchet the position had earned. */
    const persistedStop = parseFloat(paperPos.stop_price);
    const entry = parseFloat(paperPos.entry_price);
    assert.ok(
      persistedStop > entry,
      `Persisted stop should have trailed above entry (${entry}), got ${persistedStop}`
    );
    assert.ok(
      Math.abs(persistedStop - parseFloat(paperPos.exit_price)) < 0.01,
      `Persisted stop (${persistedStop}) should match the level it filled at (${paperPos.exit_price})`
    );
  });

  const breakevenSpec: StrategySpec = {
    ...trailingSpec,
    id: "test-breakeven-strat",
    risk: {
      max_open_positions: 1,
      max_daily_trades: 1,
      stop_loss_pct: 10, // initial stop 10% below entry
      breakeven_trigger_pct: 5, // move SL to breakeven (entry price) once +5% reached
    },
  };

  test("Move SL to Breakeven locks in risk-free trade once gain target reached", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    createTestStrategy(session.id, breakevenSpec, "paper");

    const baseTime = 1700000000000;
    const intervalMs = 15 * 60 * 1000;
    const candles: CandleNumeric[] = [
      { timestamp: baseTime, open: 98, high: 99, low: 97, close: 98, volume: 10 },
      { timestamp: baseTime + intervalMs, open: 99, high: 102, low: 98, close: 101, volume: 15 },
      { timestamp: baseTime + intervalMs * 2, open: 101, high: 110, low: 100, close: 109, volume: 20 },
      { timestamp: baseTime + intervalMs * 3, open: 109, high: 109, low: 99, close: 99, volume: 25 },
    ];

    seedTestCandles("BTC-USD", 15, candles);

    const backtestRes = runBacktest(breakevenSpec, candles, {
      walkForwardSplit: 1.0,
      initialCapital: 10000,
    });

    assert.equal(backtestRes.tradeLog.length, 1);
    const btTrade = backtestRes.tradeLog[0]!;
    assert.equal(btTrade.exitReason, "stop_loss");
    // Net PnL should only be minor fees/slippage, not a 10% loss
    assert.ok(btTrade.netPnl > -10, `Breakeven PnL should be near zero, got ${btTrade.netPnl}`);

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

    // The breakeven move is persisted too: the row must not still show the
    // original 10%-below-entry stop.
    const persistedStop = parseFloat(paperPos.stop_price);
    const entry = parseFloat(paperPos.entry_price);
    assert.ok(
      persistedStop >= entry,
      `Persisted stop should have moved to at least breakeven (${entry}), got ${persistedStop}`
    );
  });
});
