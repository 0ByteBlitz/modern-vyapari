import { test, describe, beforeEach, afterEach } from "node:test";
import { getPaperBalance } from "../paper/account";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession, createTestStrategy, seedTestCandles } from "./test-helper";
import { PaperExchangeEngine } from "../paper/paper-exchange";
import type { StrategySpec } from "../strategy/strategy-spec";
import type { CandleNumeric } from "../insights/indicator-types";
import { getDb } from "../db/database";

describe("End-to-End Paper Roundtrip Suite", () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    cleanupTestDb();
  });

  const testSpec: StrategySpec = {
    id: "roundtrip-test-spec",
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
          value: 200,
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
      max_daily_trades: 5,
      stop_loss_pct: 2,
      take_profit_pct: 5,
    },
  };

  test("Complete paper round trip: Entry -> Intrabar Take-Profit -> Close Listener & DB Reconciliation", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    const strat = createTestStrategy(session.id, testSpec, "paper");

    const baseTime = 1700000000000;
    const intervalMs = 15 * 60 * 1000;

    const candles: CandleNumeric[] = [
      { timestamp: baseTime, open: 98, high: 99, low: 97, close: 98, volume: 10 },
      { timestamp: baseTime + intervalMs, open: 99, high: 105, low: 98, close: 104, volume: 15 }, // Entry trigger!
      { timestamp: baseTime + intervalMs * 2, open: 104, high: 112, low: 103, close: 110, volume: 20 }, // TP trigger! Entry ~104.05, +5% TP = ~109.25, High 112 hits TP
    ];

    seedTestCandles("BTC-USD", 15, candles);

    const paper = new PaperExchangeEngine();
    let closedNotificationPositionId: number | null = null;

    paper.onPositionClosed((positionId) => {
      closedNotificationPositionId = positionId;
    });

    paper.start(false);

    // Bar 0
    paper.handleCandle("BTC-USD", 15, {
      start: candles[0]!.timestamp,
      open: candles[0]!.open,
      high: candles[0]!.high,
      low: candles[0]!.low,
      close: candles[0]!.close,
      volume: candles[0]!.volume,
      closed: true,
    });

    const db = getDb();
    let openPositions = db.prepare("SELECT * FROM paper_positions WHERE session_id = ? AND status = 'open'").all(session.id);
    assert.equal(openPositions.length, 0, "No open position on Bar 0");

    // Bar 1 -> Entry!
    paper.handleCandle("BTC-USD", 15, {
      start: candles[1]!.timestamp,
      open: candles[1]!.open,
      high: candles[1]!.high,
      low: candles[1]!.low,
      close: candles[1]!.close,
      volume: candles[1]!.volume,
      closed: true,
    });

    openPositions = db.prepare("SELECT * FROM paper_positions WHERE session_id = ? AND status = 'open'").all(session.id);
    assert.equal(openPositions.length, 1, "Should have 1 open position after Bar 1");
    const openPos = openPositions[0] as any;
    assert.equal(openPos.strategy_id, strat.id);
    assert.ok(parseFloat(openPos.entry_price) > 104, "Entry price should be filled with slippage");
    assert.ok(openPos.stop_price !== null, "Stop price should be set");
    assert.ok(openPos.target_price !== null, "Target price should be set");

    // Check orders and trades
    const orders = db.prepare("SELECT * FROM orders WHERE session_id = ?").all(session.id) as any[];
    assert.equal(orders.length, 1, "Should have 1 buy order");
    assert.equal(orders[0].side, "buy");
    assert.equal(orders[0].status, "filled");

    const trades = db.prepare("SELECT * FROM trades WHERE session_id = ?").all(session.id) as any[];
    assert.equal(trades.length, 1, "Should have 1 buy trade");
    assert.equal(trades[0].side, "buy");

    // Bar 2 -> Take-Profit exit!
    paper.handleCandle("BTC-USD", 15, {
      start: candles[2]!.timestamp,
      open: candles[2]!.open,
      high: candles[2]!.high,
      low: candles[2]!.low,
      close: candles[2]!.close,
      volume: candles[2]!.volume,
      closed: true,
    });

    paper.stop();

    // Position should be closed
    const closedPositions = db.prepare("SELECT * FROM paper_positions WHERE id = ?").all(openPos.id) as any[];
    assert.equal(closedPositions.length, 1);
    const closedPos = closedPositions[0]!;
    assert.equal(closedPos.status, "closed");
    assert.equal(closedPos.exit_reason, "take_profit");
    assert.ok(parseFloat(closedPos.realized_pnl) > 0, "Realized PnL should be positive for Take-Profit");

    // Check Close Listener notification
    assert.equal(closedNotificationPositionId, openPos.id, "Close listener should have received closed position ID");

    /* The ACCOUNT balance, not a per-session one — cash moved to a single
       account in schema v20, and `sessions.paper_balance` is a dead column
       that would answer a frozen 10,000. */
    const currentBalance = getPaperBalance();
    const expectedBalance = 10000 + parseFloat(closedPos.realized_pnl);
    assert.ok(Math.abs(currentBalance - expectedBalance) < 0.01, `Balance mismatch: current ${currentBalance} vs expected ${expectedBalance}`);
  });

  test("Session shutdown wind-down (archive) closes position correctly", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    const strat = createTestStrategy(session.id, testSpec, "paper");

    const baseTime = 1700000000000;
    const intervalMs = 15 * 60 * 1000;

    const candles: CandleNumeric[] = [
      { timestamp: baseTime, open: 98, high: 99, low: 97, close: 98, volume: 10 },
      { timestamp: baseTime + intervalMs, open: 99, high: 106, low: 101, close: 105, volume: 15 },
    ];

    seedTestCandles("BTC-USD", 15, candles);

    const paper = new PaperExchangeEngine();
    paper.start(false);

    // Feed bar 0 and bar 1 to trigger entry
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

    const db = getDb();
    const openPos = db.prepare("SELECT * FROM paper_positions WHERE session_id = ? AND status = 'open'").get(session.id) as any;
    assert.ok(openPos, "Position should be open");

    // Wind down via closePositionForShutdown
    const res = paper.closePositionForShutdown(openPos.id, 105, "session_archived");
    assert.ok(res, "Shutdown close should return result");

    paper.stop();

    // Check position in DB
    const closedPos = db.prepare("SELECT * FROM paper_positions WHERE id = ?").get(openPos.id) as any;
    assert.equal(closedPos.status, "closed");
    assert.equal(closedPos.exit_reason, "session_archived");
  });
});
