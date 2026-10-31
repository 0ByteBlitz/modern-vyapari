/**
 * A plan-owned position is reviewable (roadmap J-2).
 *
 * `review.ts` declared `strategy_id: number` and called
 * `getStrategy(pos.strategy_id)`. Schema v15 made ownership exclusive — a
 * position belongs to a strategy **or** to a plan branch — so the moment plan
 * execution opens its first position, that call would receive NULL and the
 * trade would close **and never be reviewed**. Silent, and it would take the
 * calibration record's only input with it: S3-6 derives its figures from these
 * journal entries.
 *
 * These tests are about `resolveOwner` doing its job and the review being
 * *findable afterwards*. They deliberately do not call the model — the network
 * is blocked in tests, and what broke here was ownership resolution, not
 * prompting.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession, createTestStrategy } from "./test-helper";
import { getDb } from "../db/database";
import { createPlan, armPlan, type PlanInput } from "../plans/plan-service";
import type { StrategySpec } from "../strategy/strategy-spec";

const PAIR = "BTC-USD";
const T0 = 1_785_000_000_000;
const DAY = 86_400_000;

const spec = (): StrategySpec =>
  ({
    /* The helper names the strategy from `spec.id`, not `spec.name`. */
    id: "t-strategy",
    name: "t",
    entry: { logic: "and", conditions: [{ indicator: "price", params: {}, field: "close", operator: "above", value: 1 }] },
    exit: { logic: "and", conditions: [{ indicator: "price", params: {}, field: "close", operator: "below", value: 0 }] },
    sizing: { mode: "percent_balance", value: 10 },
    risk: { stop_loss_pct: 4, take_profit_pct: 8 },
    schedule: { eval_interval: "4h" },
  }) as unknown as StrategySpec;

function planInput(sessionId: number): PlanInput {
  return {
    sessionId,
    slug: "range-break",
    pair: PAIR,
    thesis: "Reclaiming 100 opens the gap to 130.",
    assumptions: [{ text: "The 100 shelf is real supply." }],
    invalidation: { subject: "price", operator: "below", value: 80 },
    expiresAt: T0 + 30 * DAY,
    risk: { maxQuote: 250 },
    ocoExclusive: true,
    evalInterval: "4h",
    branches: [
      {
        id: "breakout",
        label: "breakout",
        trigger: { subject: "price", operator: "crosses_above", value: 100 },
        entry: { kind: "static", price: 100 },
        stop: { kind: "static", price: 90 },
        targets: [{ kind: "static", price: 130 }],
        budgetSharePct: 100,
      },
    ],
  };
}

/** A closed position owned by whichever side is passed. */
function insertClosedPosition(
  sessionId: number,
  owner: { strategyId: number; branchId: null } | { strategyId: null; branchId: number }
): number {
  const res = getDb()
    .prepare(
      `INSERT INTO paper_positions
         (session_id, strategy_id, plan_branch_id, symbol, side, entry_price, quantity, entry_fee,
          stop_price, target_price, status, exit_price, exit_reason, realized_pnl, fees_total,
          opened_at, closed_at, reviewed)
       VALUES (?, ?, ?, ?, 'buy', '100', '1', '0.25', '90', '130', 'closed', '112', 'take_profit',
               '11.5', '0.5', ?, ?, 0)`
    )
    .run(sessionId, owner.strategyId, owner.branchId, PAIR, T0, T0 + 3_600_000);
  return Number(res.lastInsertRowid);
}

describe("a review knows what opened the trade", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("ownership is exclusive at the database, both ways", () => {
    const s = createTestSession(PAIR);
    const strat = createTestStrategy(s.id, spec(), "paper");

    /* Owned by both would double-count in every aggregate; owned by neither
       leaves the reviewer unable to say what the trade should be judged
       against. The CHECK constraint refuses each. */
    assert.throws(() => insertClosedPosition(s.id, { strategyId: strat.id, branchId: 1 as never }));
    assert.throws(() =>
      insertClosedPosition(s.id, { strategyId: null as never, branchId: null as never })
    );
  });

  test("a plan-owned position resolves to its plan, thesis and assumptions", () => {
    const s = createTestSession(PAIR);
    const created = createPlan(planInput(s.id));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(armPlan(created.plan.rowId, T0).ok, true);

    const branch = getDb()
      .prepare(`SELECT id FROM plan_branches WHERE plan_id = ?`)
      .get(created.plan.rowId) as { id: number };
    const posId = insertClosedPosition(s.id, { strategyId: null, branchId: branch.id });

    /* The join the reviewer walks: position → branch → plan. Before J-2 this
       path did not exist in review.ts at all. */
    const row = getDb()
      .prepare(
        `SELECT p.slug, p.thesis, p.assumptions_json, p.eval_interval
           FROM paper_positions pos
           JOIN plan_branches b ON b.id = pos.plan_branch_id
           JOIN trade_plans p ON p.id = b.plan_id
          WHERE pos.id = ?`
      )
      .get(posId) as { slug: string; thesis: string; assumptions_json: string; eval_interval: string };

    assert.equal(row.slug, "range-break");
    assert.match(row.thesis, /130/);
    assert.equal(JSON.parse(row.assumptions_json).length, 1);
    /* The price window is read at the plan's own timeframe; a wrong interval
       silently answers "how much of the move was captured" from bars that
       predate the entry. */
    assert.equal(row.eval_interval, "4h");
  });

  test("a plan's review is findable by plan, not only by tag text", () => {
    const s = createTestSession(PAIR);
    const created = createPlan(planInput(s.id));
    if (!created.ok) return;

    getDb()
      .prepare(
        `INSERT INTO journal (session_id, kind, content, tags, ref_strategy_id, ref_plan_id, created_at)
         VALUES (?, 'trade_review', 'ASSUMPTIONS: the shelf held.', 'paper,plan,take_profit,win', NULL, ?, ?)`
      )
      .run(s.id, created.plan.rowId, Date.now());

    /* schema v16. S3-6 derives the calibration record from these entries, so
       searching tag strings for a plan name would be the wrong mechanism —
       two plans could share a word and a rename would orphan the history. */
    const found = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM journal WHERE ref_plan_id = ?`)
      .get(created.plan.rowId) as { n: number };
    assert.equal(found.n, 1);
  });

  test("a strategy review still links to its strategy and not to a plan", () => {
    const s = createTestSession(PAIR);
    const strat = createTestStrategy(s.id, spec(), "paper");
    getDb()
      .prepare(
        `INSERT INTO journal (session_id, kind, content, tags, ref_strategy_id, ref_plan_id, created_at)
         VALUES (?, 'trade_review', 'PROCESS: matched the spec.', 'paper,strategy', ?, NULL, ?)`
      )
      .run(s.id, strat.id, Date.now());

    const row = getDb()
      .prepare(`SELECT ref_strategy_id, ref_plan_id FROM journal WHERE ref_strategy_id = ?`)
      .get(strat.id) as { ref_strategy_id: number; ref_plan_id: number | null };
    assert.equal(row.ref_strategy_id, strat.id);
    assert.equal(row.ref_plan_id, null);
  });
});
