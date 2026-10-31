import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateRisk, type OrderIntent, type RiskContext } from "../risk/risk-engine";

describe("Risk Engine Safety Gates Suite (Stage C Pure Risk Authority)", () => {
  const baseIntent: OrderIntent = {
    sessionId: 1,
    strategyId: 10,
    symbol: "BTC-USD",
    side: "buy",
    type: "market",
    quoteAmount: 1000,
    stopLossPrice: 95,
    mode: "paper",
  };

  const baseContext: RiskContext = {
    sessionStatus: "active",
    riskConfig: {
      max_position_size: 5000,
      max_daily_loss: 500,
      max_open_positions: 3,
      max_daily_trades: 10,
      max_spread_bps: 50,
    },
    openPositionsCount: 0,
    tradesTodayCount: 0,
    dailyRealizedPnl: 0,
    currentSpreadBps: 5,
    killSwitchActive: false,
  };

  test("Gate 1: Stop-loss required gate rejects buy intent missing stop price", () => {
    const intentWithoutStop: OrderIntent = { ...baseIntent, stopLossPrice: undefined };
    const res = evaluateRisk(intentWithoutStop, baseContext);
    assert.equal(res.approved, false);
    assert.equal(res.failedGate?.gateId, "GATE_1_STOP_LOSS");
  });

  test("Gate 2: Max position size gate rejects oversized quote amounts", () => {
    const oversizedIntent: OrderIntent = { ...baseIntent, quoteAmount: 10000 };
    const res = evaluateRisk(oversizedIntent, baseContext);
    assert.equal(res.approved, false);
    assert.equal(res.failedGate?.gateId, "GATE_2_MAX_POSITION_SIZE");
  });

  test("Gate 2: Max position size gate fails closed when the notional cannot be established", () => {
    // quantity with no price and no quoteAmount: the cap has nothing to measure.
    const unmeasurable: OrderIntent = { ...baseIntent, quoteAmount: undefined, quantity: 5 };
    const res = evaluateRisk(unmeasurable, baseContext);
    assert.equal(res.approved, false);
    assert.equal(res.failedGate?.gateId, "GATE_2_MAX_POSITION_SIZE");
  });

  test("Gate 2: price × quantity is accepted as the notional when quoteAmount is absent", () => {
    const priced: OrderIntent = { ...baseIntent, quoteAmount: undefined, quantity: 5, price: 100 };
    const res = evaluateRisk(priced, baseContext);
    assert.equal(res.approved, true);
  });

  test("Gate 0: a non-active session is rejected as a session precondition, not a position cap", () => {
    const paused: RiskContext = { ...baseContext, sessionStatus: "paused" };
    const res = evaluateRisk(baseIntent, paused);
    assert.equal(res.approved, false);
    assert.equal(res.failedGate?.gateId, "GATE_0_SESSION_ACTIVE");
  });

  test("Gate 3: Max daily loss gate rejects new entries when loss cap hit", () => {
    const maxLossContext: RiskContext = { ...baseContext, dailyRealizedPnl: -600 };
    const res = evaluateRisk(baseIntent, maxLossContext);
    assert.equal(res.approved, false);
    assert.equal(res.failedGate?.gateId, "GATE_3_MAX_DAILY_LOSS");
  });

  test("Gate 4: Max open positions gate rejects entries at capacity limit", () => {
    const fullContext: RiskContext = { ...baseContext, openPositionsCount: 3 };
    const res = evaluateRisk(baseIntent, fullContext);
    assert.equal(res.approved, false);
    assert.equal(res.failedGate?.gateId, "GATE_4_MAX_OPEN_POSITIONS");
  });

  test("Gate 5: Daily trade count limit gate rejects entries exceeding rate limit", () => {
    const busyContext: RiskContext = { ...baseContext, tradesTodayCount: 10 };
    const res = evaluateRisk(baseIntent, busyContext);
    assert.equal(res.approved, false);
    assert.equal(res.failedGate?.gateId, "GATE_5_DAILY_TRADE_COUNT");
  });

  test("Gate 6: Spread & liquidity threshold gate rejects wide spreads", () => {
    const illiquidContext: RiskContext = { ...baseContext, currentSpreadBps: 80 };
    const res = evaluateRisk(baseIntent, illiquidContext);
    assert.equal(res.approved, false);
    assert.equal(res.failedGate?.gateId, "GATE_6_SPREAD_LIQUIDITY");
  });

  test("Gate 7: Emergency Kill Switch gate immediately blocks all intents when active", () => {
    const trippedContext: RiskContext = { ...baseContext, killSwitchActive: true };
    const res = evaluateRisk(baseIntent, trippedContext);
    assert.equal(res.approved, false);
    assert.equal(res.failedGate?.gateId, "GATE_7_KILL_SWITCH");
  });

  test("Gate 8: Mode Supervision routes live_supervised intent to human approval queue", () => {
    const supervisedIntent: OrderIntent = { ...baseIntent, mode: "live_supervised" };
    const res = evaluateRisk(supervisedIntent, baseContext);
    assert.equal(res.approved, false);
    assert.equal(res.awaitingApproval, true);
    assert.equal(res.failedGate, null);
  });

  test("Valid intent under normal risk conditions passes all 8 safety gates", () => {
    const res = evaluateRisk(baseIntent, baseContext);
    assert.equal(res.approved, true);
    assert.equal(res.awaitingApproval, false);
    assert.equal(res.failedGate, null);
    // 8 numbered gates + the GATE_0 session precondition.
    assert.equal(res.gateResults.length, 9);
    assert.ok(res.gateResults.every((g) => g.passed));
  });
});
