/**
 * Pure Risk Engine — the non-negotiable safety authority of the trading bot.
 *
 * Runs as a pure, deterministic function stack before any order intent touches
 * the paper or live execution path. Every check is isolated, stateless, and
 * exhaustively unit-tested.
 */

export interface OrderIntent {
  sessionId: number;
  strategyId?: number;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity?: number;
  quoteAmount?: number;
  price?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  mode: "paper" | "live_supervised" | "live_auto";
}

export interface RiskConfig {
  max_position_size?: number;
  max_daily_loss?: number;
  max_open_positions?: number;
  max_daily_trades?: number;
  max_spread_bps?: number;
}

export interface RiskContext {
  sessionStatus: "active" | "paused" | "archived";
  riskConfig: RiskConfig;
  openPositionsCount: number;
  tradesTodayCount: number;
  dailyRealizedPnl: number;
  currentSpreadBps?: number;
  killSwitchActive: boolean;
}

export type RiskGateId =
  /** Not a numbered safety gate — a precondition. Kept distinct so the audit
   *  trace says "the session wasn't active" instead of blaming a position cap
   *  that was never the reason. */
  | "GATE_0_SESSION_ACTIVE"
  | "GATE_1_STOP_LOSS"
  | "GATE_2_MAX_POSITION_SIZE"
  | "GATE_3_MAX_DAILY_LOSS"
  | "GATE_4_MAX_OPEN_POSITIONS"
  | "GATE_5_DAILY_TRADE_COUNT"
  | "GATE_6_SPREAD_LIQUIDITY"
  | "GATE_7_KILL_SWITCH"
  | "GATE_8_MODE_SUPERVISION";

export interface GateResult {
  gateId: RiskGateId;
  passed: boolean;
  reason?: string;
}

export interface RiskAssessmentResult {
  approved: boolean;
  awaitingApproval: boolean;
  failedGate: GateResult | null;
  gateResults: GateResult[];
}

/**
 * Evaluate an OrderIntent against all 8 hard risk safety gates.
 * Returns an immediate approval/rejection decision with full audit trace.
 */
export function evaluateRisk(intent: OrderIntent, context: RiskContext): RiskAssessmentResult {
  const gateResults: GateResult[] = [];

  // Gate 7: Global Emergency Kill Switch
  if (context.killSwitchActive) {
    const failed: GateResult = {
      gateId: "GATE_7_KILL_SWITCH",
      passed: false,
      reason: "Emergency kill switch is ACTIVE — all order intents are blocked.",
    };
    gateResults.push(failed);
    return { approved: false, awaitingApproval: false, failedGate: failed, gateResults };
  }
  gateResults.push({ gateId: "GATE_7_KILL_SWITCH", passed: true });

  // Gate 0: Session must be active
  if (context.sessionStatus !== "active") {
    const failed: GateResult = {
      gateId: "GATE_0_SESSION_ACTIVE",
      passed: false,
      reason: `Session is ${context.sessionStatus} — order intents rejected.`,
    };
    gateResults.push(failed);
    return { approved: false, awaitingApproval: false, failedGate: failed, gateResults };
  }
  gateResults.push({ gateId: "GATE_0_SESSION_ACTIVE", passed: true });

  // Gate 1: Explicit Stop-Loss Required
  if (intent.side === "buy" && (!intent.stopLossPrice || intent.stopLossPrice <= 0)) {
    const failed: GateResult = {
      gateId: "GATE_1_STOP_LOSS",
      passed: false,
      reason: "Hard Stop-Loss Gate: Buy order intent must carry a valid positive stop-loss price.",
    };
    gateResults.push(failed);
    return { approved: false, awaitingApproval: false, failedGate: failed, gateResults };
  }
  gateResults.push({ gateId: "GATE_1_STOP_LOSS", passed: true });

  // Gate 2: Max Position Size Cap
  const maxPosSize = context.riskConfig.max_position_size ?? 5000;

  /* The notional must be *establishable*, not merely absent. A market intent
     carrying only `quantity` (no price, no quoteAmount) used to evaluate to 0
     and pass the cap unchecked — an unbounded order sailing through the gate
     whose entire job is to bound it. A gate that cannot measure the thing it
     caps must fail closed. */
  const estimatedQuote =
    intent.quoteAmount ?? (intent.price !== undefined && intent.quantity !== undefined
      ? intent.price * intent.quantity
      : null);

  if (estimatedQuote === null || !Number.isFinite(estimatedQuote) || estimatedQuote <= 0) {
    const failed: GateResult = {
      gateId: "GATE_2_MAX_POSITION_SIZE",
      passed: false,
      reason:
        "Order size could not be established (no quoteAmount, and no price × quantity) — " +
        "the position-size cap cannot be enforced, so the intent is rejected.",
    };
    gateResults.push(failed);
    return { approved: false, awaitingApproval: false, failedGate: failed, gateResults };
  }

  if (estimatedQuote > maxPosSize) {
    const failed: GateResult = {
      gateId: "GATE_2_MAX_POSITION_SIZE",
      passed: false,
      reason: `Position size $${estimatedQuote.toFixed(2)} exceeds maximum cap $${maxPosSize.toFixed(2)}.`,
    };
    gateResults.push(failed);
    return { approved: false, awaitingApproval: false, failedGate: failed, gateResults };
  }
  gateResults.push({ gateId: "GATE_2_MAX_POSITION_SIZE", passed: true });

  // Gate 3: Max Daily Realized Loss Limit
  const maxDailyLoss = context.riskConfig.max_daily_loss ?? 500;
  if (context.dailyRealizedPnl <= -maxDailyLoss) {
    const failed: GateResult = {
      gateId: "GATE_3_MAX_DAILY_LOSS",
      passed: false,
      reason: `Daily realized loss -$${Math.abs(context.dailyRealizedPnl).toFixed(2)} reached maximum limit -$${maxDailyLoss.toFixed(2)}.`,
    };
    gateResults.push(failed);
    return { approved: false, awaitingApproval: false, failedGate: failed, gateResults };
  }
  gateResults.push({ gateId: "GATE_3_MAX_DAILY_LOSS", passed: true });

  // Gate 4: Max Open Positions Cap
  const maxOpen = context.riskConfig.max_open_positions ?? 3;
  if (intent.side === "buy" && context.openPositionsCount >= maxOpen) {
    const failed: GateResult = {
      gateId: "GATE_4_MAX_OPEN_POSITIONS",
      passed: false,
      reason: `Open positions count (${context.openPositionsCount}) reached maximum cap (${maxOpen}).`,
    };
    gateResults.push(failed);
    return { approved: false, awaitingApproval: false, failedGate: failed, gateResults };
  }
  gateResults.push({ gateId: "GATE_4_MAX_OPEN_POSITIONS", passed: true });

  // Gate 5: Daily Trade Count Limit
  const maxDailyTrades = context.riskConfig.max_daily_trades ?? 20;
  if (context.tradesTodayCount >= maxDailyTrades) {
    const failed: GateResult = {
      gateId: "GATE_5_DAILY_TRADE_COUNT",
      passed: false,
      reason: `Trades today (${context.tradesTodayCount}) reached daily maximum trade count (${maxDailyTrades}).`,
    };
    gateResults.push(failed);
    return { approved: false, awaitingApproval: false, failedGate: failed, gateResults };
  }
  gateResults.push({ gateId: "GATE_5_DAILY_TRADE_COUNT", passed: true });

  // Gate 6: Spread & Liquidity Threshold
  const maxSpreadBps = context.riskConfig.max_spread_bps ?? 50;
  if (context.currentSpreadBps !== undefined && context.currentSpreadBps > maxSpreadBps) {
    const failed: GateResult = {
      gateId: "GATE_6_SPREAD_LIQUIDITY",
      passed: false,
      reason: `Current market spread ${context.currentSpreadBps.toFixed(1)} bps exceeds maximum allowed threshold ${maxSpreadBps} bps.`,
    };
    gateResults.push(failed);
    return { approved: false, awaitingApproval: false, failedGate: failed, gateResults };
  }
  gateResults.push({ gateId: "GATE_6_SPREAD_LIQUIDITY", passed: true });

  // Gate 8: Mode Supervision Check
  if (intent.mode === "live_supervised") {
    gateResults.push({
      gateId: "GATE_8_MODE_SUPERVISION",
      passed: true,
      reason: "Passed automated risk gates — held for human operator approval signature.",
    });
    return { approved: false, awaitingApproval: true, failedGate: null, gateResults };
  }
  gateResults.push({ gateId: "GATE_8_MODE_SUPERVISION", passed: true });

  return { approved: true, awaitingApproval: false, failedGate: null, gateResults };
}
