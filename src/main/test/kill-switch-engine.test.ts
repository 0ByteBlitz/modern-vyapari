/**
 * The kill switch must actually stop the engine that trades.
 *
 * It was exposed over IPC and wired to a button on the Approvals page, but
 * nothing in the paper engine read it — tripping it flipped a flag and the
 * engine kept opening positions. These tests pin down both halves of the
 * contract, because the dangerous half is the second one:
 *
 *   1. tripped  → no NEW entries
 *   2. tripped  → protective stops and targets STILL fire
 *
 * A breaker that also silenced the stop-loss would strand every open position
 * unprotected, which is worse than having no breaker at all.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession, createTestStrategy, seedTestCandles } from "./test-helper";
import { PaperExchangeEngine } from "../paper/paper-exchange";
import { killSwitch } from "../risk/kill-switch";
import type { StrategySpec } from "../strategy/strategy-spec";
import type { CandleNumeric } from "../insights/indicator-types";
import { getDb } from "../db/database";

const spec: StrategySpec = {
  id: "kill-switch-strat",
  pair: "BTC-USD",
  type: "signal",
  entry: {
    logic: "and",
    conditions: [{ indicator: "price", params: {}, field: "close", operator: "above", value: 100 }],
  },
  exit: {
    logic: "and",
    conditions: [{ indicator: "price", params: {}, field: "close", operator: "above", value: 100000 }],
  },
  sizing: { mode: "fixed_quote", amount: 1000 },
  schedule: { eval_interval: "15m" },
  risk: {
    max_open_positions: 1,
    max_daily_trades: 5,
    stop_loss_pct: 5,
  },
};

const baseTime = 1700000000000;
const intervalMs = 15 * 60 * 1000;

function feed(paper: PaperExchangeEngine, candles: CandleNumeric[]) {
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
}

describe("Kill switch vs. the paper engine", () => {
  beforeEach(() => {
    setupTestDb();
    killSwitch.reset();
  });

  afterEach(() => {
    killSwitch.reset();
    cleanupTestDb();
  });

  test("a tripped kill switch blocks new entries", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    createTestStrategy(session.id, spec, "paper");

    const candles: CandleNumeric[] = [
      { timestamp: baseTime, open: 98, high: 99, low: 97, close: 98, volume: 10 },
      { timestamp: baseTime + intervalMs, open: 99, high: 106, low: 98, close: 105, volume: 15 },
    ];
    seedTestCandles("BTC-USD", 15, candles);

    killSwitch.trip("test trip");

    const paper = new PaperExchangeEngine();
    paper.start(false);
    feed(paper, candles);
    paper.stop();

    const n = getDb()
      .prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE session_id = ?")
      .get(session.id) as { n: number };

    assert.equal(n.n, 0, "No position should have been opened while the kill switch was tripped");
  });

  test("the same entry opens once the kill switch is reset", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    createTestStrategy(session.id, spec, "paper");

    const candles: CandleNumeric[] = [
      { timestamp: baseTime, open: 98, high: 99, low: 97, close: 98, volume: 10 },
      { timestamp: baseTime + intervalMs, open: 99, high: 106, low: 98, close: 105, volume: 15 },
    ];
    seedTestCandles("BTC-USD", 15, candles);

    const paper = new PaperExchangeEngine();
    paper.start(false);
    feed(paper, candles);
    paper.stop();

    const n = getDb()
      .prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE session_id = ?")
      .get(session.id) as { n: number };

    assert.equal(n.n, 1, "Control: the identical entry must open when the switch is clear");
  });

  test("a stop-loss on an already-open position still fires while tripped", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    createTestStrategy(session.id, spec, "paper");

    const entryCandles: CandleNumeric[] = [
      { timestamp: baseTime, open: 98, high: 99, low: 97, close: 98, volume: 10 },
      { timestamp: baseTime + intervalMs, open: 99, high: 106, low: 98, close: 105, volume: 15 },
    ];
    seedTestCandles("BTC-USD", 15, entryCandles);

    const paper = new PaperExchangeEngine();
    paper.start(false);
    feed(paper, entryCandles);

    const opened = getDb()
      .prepare("SELECT id, stop_price FROM paper_positions WHERE session_id = ? AND status = 'open'")
      .get(session.id) as { id: number; stop_price: string } | undefined;
    assert.ok(opened, "Precondition: a position must be open before tripping");

    // Now trip the breaker, then send a bar that breaches the stop.
    killSwitch.trip("tripped while holding a position");

    const stopBreach: CandleNumeric[] = [
      { timestamp: baseTime + intervalMs * 2, open: 105, high: 105, low: 80, close: 82, volume: 20 },
    ];
    seedTestCandles("BTC-USD", 15, stopBreach);
    feed(paper, stopBreach);
    paper.stop();

    const closed = getDb()
      .prepare("SELECT status, exit_reason FROM paper_positions WHERE id = ?")
      .get(opened!.id) as { status: string; exit_reason: string };

    assert.equal(closed.status, "closed", "The stop must still protect the position while tripped");
    assert.equal(closed.exit_reason, "stop_loss");
  });
});
