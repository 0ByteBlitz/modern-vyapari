/**
 * A plan that finished without trading gets a written record.
 *
 * Review only ever ran on a **closed position**, so the most common outcome —
 * a plan that expired without firing — produced no journal entry at all. That
 * is backwards: it is the single most informative case for the calibration
 * record, and it was the one case with nothing written down.
 *
 * The model call itself is not exercised here (no API key in a test process).
 * What is pinned is everything around it, which is where the damage would be:
 * writing a second entry for a plan that already has a trade review, reviewing
 * a plan that has not finished, and re-reviewing on every startup.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession } from "./test-helper";
import { reviewResolvedPlan, reviewPendingPlans } from "../agent/review";
import { getDb } from "../db/database";

const PAIR = "BTC-USD";
const T0 = 1_785_000_000_000;

function seedPlan(sessionId: number, state: string, withPosition = false): number {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO trade_plans (session_id, slug, pair, thesis, assumptions_json, invalidation_json,
                                expires_at, risk_json, oco_exclusive, eval_interval, state,
                                armed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'thesis', '[{"text":"a"}]', '{}', ?, '{"maxQuote":100}', 1, '4h', ?, ?, ?, ?)`
    )
    .run(sessionId, `p-${Math.random().toString(36).slice(2, 8)}`, PAIR, T0 + 1000, state, T0, T0, T0);
  const planId = Number(res.lastInsertRowid);

  const b = db
    .prepare(
      `INSERT INTO plan_branches (plan_id, slug, label, trigger_json, entry_json, stop_json,
                                  targets_json, budget_share_pct, status)
       VALUES (?, 'b', 'branch', '{}', '{}', '{}', '[]', 100, ?)`
    )
    .run(planId, withPosition ? "triggered" : "pending");
  const branchId = Number(b.lastInsertRowid);

  if (withPosition) {
    const pos = db
      .prepare(
        `INSERT INTO paper_positions (session_id, strategy_id, plan_branch_id, symbol, side,
                                      entry_price, quantity, entry_fee, status, opened_at)
         VALUES (?, NULL, ?, ?, 'buy', '100', '1', '0', 'closed', ?)`
      )
      .run(sessionId, branchId, PAIR, T0);
    db.prepare(`UPDATE plan_branches SET position_id = ? WHERE id = ?`).run(Number(pos.lastInsertRowid), branchId);
  }
  return planId;
}

const reviewedFlag = (id: number) =>
  (getDb().prepare(`SELECT reviewed FROM trade_plans WHERE id = ?`).get(id) as { reviewed: number }).reviewed;

const journalCount = () =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM journal`).get() as { n: number }).n;

describe("a plan that traded is not reviewed twice", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a plan with a position is marked done and writes nothing", async () => {
    const s = createTestSession(PAIR);
    const id = seedPlan(s.id, "closed", true);

    await reviewResolvedPlan(id);

    /* Its position already produced a `trade_review`. A second entry would
       double-count in every reading of the journal — including the lessons
       distillation, which feeds on exactly these rows. */
    assert.equal(journalCount(), 0, "no second entry for a plan that traded");
    assert.equal(reviewedFlag(id), 1, "but marked done so the catch-up stops returning it");
  });
});

describe("only finished plans are reviewed", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("an armed plan is left alone", async () => {
    const s = createTestSession(PAIR);
    const id = seedPlan(s.id, "planned");

    await reviewResolvedPlan(id);

    /* It has not had its chance yet. Writing "this never happened" about a live
       plan would be wrong and would also mark it reviewed, so the real note
       would never be written. */
    assert.equal(reviewedFlag(id), 0);
    assert.equal(journalCount(), 0);
  });

  test("a draft is left alone", async () => {
    const s = createTestSession(PAIR);
    const id = seedPlan(s.id, "draft");
    await reviewResolvedPlan(id);
    assert.equal(reviewedFlag(id), 0);
  });

  test("the catch-up query picks up only unreviewed finished plans", async () => {
    const s = createTestSession(PAIR);
    const traded = seedPlan(s.id, "closed", true);
    const live = seedPlan(s.id, "planned");
    const done = seedPlan(s.id, "expired");
    getDb().prepare(`UPDATE trade_plans SET reviewed = 1 WHERE id = ?`).run(done);

    await reviewPendingPlans();

    /* `traded` gets flagged (nothing written); `live` is untouched; `done` was
       already reviewed and must not be revisited on every startup — that is
       what the flag is for. */
    assert.equal(reviewedFlag(traded), 1);
    assert.equal(reviewedFlag(live), 0);
    assert.equal(journalCount(), 0);
  });
});

describe("the review never disturbs what called it", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a missing plan resolves quietly rather than throwing", async () => {
    /* Called fire-and-forget from the engine right after a state transition has
       already committed. A throw here would surface as an unhandled rejection
       from a path that has nothing to do with execution. */
    await reviewResolvedPlan(999_999);
  });
});
