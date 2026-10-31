/**
 * The calibration record (roadmap S3-6).
 *
 * With the strategy path frozen this is the **only** evidence the app
 * accumulates, which makes the ways it could quietly lie more important than
 * the arithmetic. Each test here is one of those ways.
 *
 * The one that matters most is the unwatched-window test. A closed laptop
 * watches nothing, and a plan that never triggered because nobody was looking
 * records identically to one that never triggered because price never came —
 * in the **flattering** direction, since a thesis that never got its chance is
 * not a thesis that failed. That is this project's recurring defect landing on
 * the number whose entire job is to be honest with the owner about themselves.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession } from "./test-helper";
import { buildCalibration, MIN_SAMPLE } from "../plans/calibration";
import { getDb, auditLog } from "../db/database";
import { GAP_THRESHOLD_MS } from "../paper/monitor-heartbeat";

const PAIR = "BTC-USD";
const T0 = 1_785_000_000_000;
const HOUR = 3_600_000;

/** A resolved plan, written straight to the tables — these tests are about the
 *  reading, not the authoring, and going through `createPlan`/`armPlan` for
 *  twenty fixtures would test the gate instead. */
function seedPlan(
  sessionId: number,
  opts: {
    state: string;
    tags?: Array<string | undefined>;
    armedAt?: number;
    closedAt?: number;
    fired?: boolean;
    exit?: { reason: string; entry: number; exit: number; target: number };
  }
): number {
  const db = getDb();
  const assumptions = (opts.tags ?? ["reclaim"]).map((t) => ({ text: "something", ...(t ? { tag: t } : {}) }));
  const res = db
    .prepare(
      `INSERT INTO trade_plans (session_id, slug, pair, thesis, assumptions_json, invalidation_json,
                                expires_at, risk_json, oco_exclusive, eval_interval, state,
                                armed_at, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'thesis', ?, '{}', ?, '{"maxQuote":100}', 1, '4h', ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      `plan-${Math.random().toString(36).slice(2, 9)}`,
      PAIR,
      JSON.stringify(assumptions),
      T0 + 100 * HOUR,
      opts.state,
      opts.armedAt ?? T0,
      opts.closedAt ?? T0 + HOUR,
      T0,
      opts.closedAt ?? T0 + HOUR
    );
  const planId = Number(res.lastInsertRowid);

  /* Branch first, then the position that names it, then link back. Schema v15
     requires a position to have exactly one owner, so a position cannot be
     written before the branch it belongs to exists — the CHECK caught this
     fixture writing an ownerless row, which is precisely its job. */
  const b = db
    .prepare(
      `INSERT INTO plan_branches (plan_id, slug, label, trigger_json, entry_json, stop_json,
                                  targets_json, budget_share_pct, status)
       VALUES (?, 'b', 'branch', '{}', '{}', '{}', ?, 100, ?)`
    )
    .run(
      planId,
      JSON.stringify(opts.exit ? [{ kind: "static", price: opts.exit.target }] : [{ kind: "static", price: 130 }]),
      opts.fired || opts.exit ? "triggered" : "pending"
    );
  const branchId = Number(b.lastInsertRowid);

  if (opts.exit) {
    const pos = db
      .prepare(
        `INSERT INTO paper_positions (session_id, strategy_id, plan_branch_id, symbol, side,
                                      entry_price, quantity, entry_fee, status, exit_price,
                                      exit_reason, realized_pnl, opened_at, closed_at)
         VALUES (?, NULL, ?, ?, 'buy', ?, '1', '0', 'closed', ?, ?, '0', ?, ?)`
      )
      .run(
        sessionId,
        branchId,
        PAIR,
        String(opts.exit.entry),
        String(opts.exit.exit),
        opts.exit.reason,
        T0,
        T0 + HOUR
      );
    db.prepare(`UPDATE plan_branches SET position_id = ? WHERE id = ?`).run(
      Number(pos.lastInsertRowid),
      branchId
    );
  }

  return planId;
}

describe("the calibration record measures the planner, not the plan", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("plans are grouped by assumption tag", () => {
    const s = createTestSession(PAIR);
    seedPlan(s.id, { state: "closed", tags: ["reclaim"], fired: true });
    seedPlan(s.id, { state: "expired", tags: ["reclaim"] });
    seedPlan(s.id, { state: "expired", tags: ["breakdown"] });

    const r = buildCalibration();
    const reclaim = r.tags.find((t) => t.tag === "reclaim")!;
    assert.equal(reclaim.resolved, 2);
    assert.equal(reclaim.triggered, 1);
    assert.equal(r.tags.find((t) => t.tag === "breakdown")!.resolved, 1);
    assert.equal(r.overall.resolved, 3, "and folded together for the overall view");
  });

  test("a plan carrying one tag twice votes once", () => {
    const s = createTestSession(PAIR);
    seedPlan(s.id, { state: "expired", tags: ["reclaim", "reclaim", "reclaim"] });

    /* Otherwise a plan with three assumptions sharing a tag would count three
       times, and a habit of restating an assumption would look like a track
       record. */
    assert.equal(buildCalibration().tags.find((t) => t.tag === "reclaim")!.resolved, 1);
  });

  test("a plan that has not resolved is not evidence", () => {
    const s = createTestSession(PAIR);
    seedPlan(s.id, { state: "planned" });
    seedPlan(s.id, { state: "draft" });

    const r = buildCalibration();
    /* Including a live plan as a non-trigger would make the record look worse
       the more actively it is being used. */
    assert.equal(r.overall.resolved, 0);
    assert.equal(r.stillOpen, 1, "planned is reported as context");
    assert.equal(r.empty, true);
  });
});

describe("the record refuses to flatter", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a plan whose life overlaps an unwatched window is excluded, not counted as a miss", () => {
    const s = createTestSession(PAIR);
    auditLog("monitor_gap", { from: T0 + HOUR, to: T0 + 5 * HOUR, ms: GAP_THRESHOLD_MS + 1 });

    seedPlan(s.id, { state: "expired", armedAt: T0, closedAt: T0 + 10 * HOUR });

    const r = buildCalibration();
    /* The plan expired without firing — but nobody was watching for four hours
       of its life, so "it did not trigger" is not something this app knows.
       Counting it would push the trigger rate down for a reason that has
       nothing to do with the thesis. */
    assert.equal(r.overall.resolved, 0, "excluded from the evidence");
    assert.equal(r.overall.unwatched, 1, "and reported, not silently dropped");
  });

  test("a gap outside a plan's life does not exclude it", () => {
    const s = createTestSession(PAIR);
    auditLog("monitor_gap", { from: T0 + 50 * HOUR, to: T0 + 60 * HOUR, ms: GAP_THRESHOLD_MS + 1 });
    seedPlan(s.id, { state: "expired", armedAt: T0, closedAt: T0 + HOUR });

    assert.equal(buildCalibration().overall.resolved, 1);
    assert.equal(buildCalibration().overall.unwatched, 0);
  });

  test("a brief gap is not an outage", () => {
    const s = createTestSession(PAIR);
    /* Ordinary jitter — a busy event loop, a slow disk — must not manufacture
       an outage the owner then has to interpret. */
    auditLog("monitor_gap", { from: T0, to: T0 + 1000, ms: 1000 });
    seedPlan(s.id, { state: "expired", armedAt: T0, closedAt: T0 + HOUR });

    assert.equal(buildCalibration().overall.resolved, 1);
  });

  test("rates stay null until the sample is worth quoting", () => {
    const s = createTestSession(PAIR);
    for (let i = 0; i < MIN_SAMPLE - 1; i++) seedPlan(s.id, { state: "expired", tags: ["thin"] });

    const thin = buildCalibration().tags.find((t) => t.tag === "thin")!;
    /* "0 of 7 = 0%" on screen reads as a finding about the thesis. The counts
       are the honest form until there are enough of them. */
    assert.equal(thin.resolved, MIN_SAMPLE - 1);
    assert.equal(thin.triggerRate, null);
    assert.equal(thin.invalidationRate, null);
  });

  test("rates appear once the sample reaches the threshold", () => {
    const s = createTestSession(PAIR);
    for (let i = 0; i < MIN_SAMPLE; i++) {
      seedPlan(s.id, { state: i < 4 ? "closed" : "expired", tags: ["enough"], fired: i < 4 });
    }

    const t = buildCalibration().tags.find((t) => t.tag === "enough")!;
    assert.equal(t.resolved, MIN_SAMPLE);
    assert.equal(t.triggerRate, 4 / MIN_SAMPLE);
  });
});

describe("captured share is about the forecast, not the money", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("it measures how far the planned move got", () => {
    const s = createTestSession(PAIR);
    /* Entry 100, target 200, exited at 150 — half the forecast move. The answer
       to "when I say 200, how far do I usually get?", which no PnL figure
       gives: the same 50 dollars means something different on a 100-point
       forecast than on a 60-point one. */
    seedPlan(s.id, {
      state: "closed",
      tags: ["half"],
      exit: { reason: "exit_signal", entry: 100, exit: 150, target: 200 },
    });

    const t = buildCalibration().tags.find((t) => t.tag === "half")!;
    assert.ok(Math.abs(t.capturedShare! - 0.5) < 1e-9);
  });

  test("target and stop outcomes are counted separately", () => {
    const s = createTestSession(PAIR);
    seedPlan(s.id, { state: "closed", tags: ["x"], exit: { reason: "take_profit", entry: 100, exit: 200, target: 200 } });
    seedPlan(s.id, { state: "closed", tags: ["x"], exit: { reason: "stop_loss", entry: 100, exit: 90, target: 200 } });

    const t = buildCalibration().tags.find((t) => t.tag === "x")!;
    assert.equal(t.reachedTarget, 1);
    assert.equal(t.stoppedOut, 1);
  });

  test("an unreadable target is not a captured share of zero", () => {
    const s = createTestSession(PAIR);
    const id = seedPlan(s.id, {
      state: "closed",
      tags: ["broken"],
      exit: { reason: "exit_signal", entry: 100, exit: 150, target: 200 },
    });
    getDb().prepare(`UPDATE plan_branches SET targets_json = 'not json' WHERE plan_id = ?`).run(id);

    /* Unknown is a value. Reporting 0% captured for a target we cannot read
       would be the missing-taker-volume bug in a new costume. */
    assert.equal(buildCalibration().tags.find((t) => t.tag === "broken")!.capturedShare, null);
  });
});
