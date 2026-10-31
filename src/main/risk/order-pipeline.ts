import { evaluateRisk, type OrderIntent, type RiskContext, type RiskAssessmentResult } from "./risk-engine";
import { killSwitch } from "./kill-switch";
import { getDb } from "../db/database";
import { getSessionById } from "../sessions/service";
import { createLogger } from "../logger";
import crypto from "node:crypto";

const log = createLogger("order-pipeline");

export interface OrderPipelineSubmissionResult {
  accepted: boolean;
  orderId?: number;
  clientOrderId: string;
  assessment: RiskAssessmentResult;
}

export class OrderPipeline {
  /**
   * Submit an OrderIntent through the RiskEngine and order storage pipeline.
   */
  public submitIntent(intent: OrderIntent): OrderPipelineSubmissionResult {
    const db = getDb();
    const session = getSessionById(intent.sessionId);

    if (!session) {
      const failed = {
        gateId: "GATE_0_SESSION_ACTIVE" as const,
        passed: false,
        reason: `Session ${intent.sessionId} not found.`,
      };
      return {
        accepted: false,
        clientOrderId: crypto.randomUUID(),
        assessment: {
          approved: false,
          awaitingApproval: false,
          failedGate: failed,
          gateResults: [failed],
        },
      };
    }

    let riskConfig = {};
    try {
      riskConfig = JSON.parse(session.risk_config || "{}");
    } catch {}

    // Calculate context parameters from SQLite DB
    const openPositionsCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE session_id = ? AND status = 'open'`)
        .get(intent.sessionId) as { n: number }
    ).n;

    const startOfDay = new Date().setHours(0, 0, 0, 0);

    /* Trades TODAY means trades *entered* today. Counting `closed_at` instead
       meant a position opened this morning and still running didn't count
       against the daily cap at all (`NULL >= startOfDay` is NULL, never true),
       so the frequency limit could be blown wide open by trades that simply
       hadn't closed yet — and a trade opened yesterday that closed today
       counted against today's budget twice over. */
    const tradesTodayCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE session_id = ? AND opened_at >= ?`)
        .get(intent.sessionId, startOfDay) as { n: number }
    ).n;

    const dailyPnlRow = db
      .prepare(
        `SELECT COALESCE(SUM(CAST(realized_pnl AS REAL)), 0) AS pnl
         FROM paper_positions WHERE session_id = ? AND closed_at >= ? AND status = 'closed'`
      )
      .get(intent.sessionId, startOfDay) as { pnl: number };

    const context: RiskContext = {
      sessionStatus: session.status,
      riskConfig,
      openPositionsCount,
      tradesTodayCount,
      dailyRealizedPnl: dailyPnlRow?.pnl || 0,
      killSwitchActive: killSwitch.isTripped(),
    };

    const assessment = evaluateRisk(intent, context);
    const clientOrderId = crypto.randomUUID();
    const now = Date.now();

    const status = assessment.approved
      ? "approved"
      : assessment.awaitingApproval
      ? "proposed"
      : "rejected";

    let orderId: number | undefined;

    try {
      const res = db
        .prepare(
          `INSERT INTO orders (session_id, strategy_id, client_order_id, symbol, side, type, quantity, quote_amount, price, status, mode, reasoning, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          intent.sessionId,
          intent.strategyId ?? null,
          clientOrderId,
          intent.symbol,
          intent.side,
          intent.type,
          intent.quantity?.toString() ?? null,
          intent.quoteAmount?.toString() ?? null,
          intent.price?.toString() ?? null,
          status,
          intent.mode,
          JSON.stringify(assessment),
          now,
          now
        );

      orderId = Number(res.lastInsertRowid);
    } catch (err) {
      log.error("Failed to insert order intent record", err);
    }

    if (!assessment.approved) {
      log.warn(
        `Order intent ${clientOrderId} ${status}: ${assessment.failedGate?.reason ?? "awaiting human signature"}`
      );
    } else {
      log.info(`Order intent ${clientOrderId} APPROVED by RiskEngine.`);
    }

    return {
      accepted: assessment.approved,
      orderId,
      clientOrderId,
      assessment,
    };
  }
}

export const orderPipeline = new OrderPipeline();
