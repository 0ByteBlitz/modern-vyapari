/**
 * Plan persistence and arming (roadmap S3-1/S3-2).
 *
 * Arming is the operation that matters, and the properties under test are the
 * ones that make a plan mean what it says:
 *
 *  • the falsifiability gate runs at ARM, not at save — a draft is where you
 *    think, and refusing to save an incomplete thought just pushes authoring
 *    into a text file;
 *  • arming fills in `resolvedAtArm` from real data, and **refuses** when a
 *    level cannot be computed rather than storing a placeholder. A fabricated
 *    baseline makes every later drift answer fiction;
 *  • an armed plan cannot be quietly edited, because the plan that fires must
 *    be the plan that was approved.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, seedTestCandles, createTestSession } from "./test-helper";
import {
  createPlan,
  armPlan,
  getPlan,
  listPlans,
  updatePlan,
  deletePlan,
  transitionPlan,
  type PlanInput,
} from "../plans/plan-service";
import { levelResolver } from "../insights/level-resolver";
import { withTransaction } from "../db/database";
import type { ConditionIntent } from "../plans/condition-intent";
import type { LevelDraft } from "../plans/level-reference";

const DAY = 86_400_000;
const BAR = 4 * 3_600_000; // 4h
const T0 = 1_780_000_000_000;
const PAIR = "BTC-USD";

const priceAbove = (v: number): ConditionIntent => ({
  subject: "price",
  operator: "crosses_above",
  value: v,
});
const priceBelow = (v: number): ConditionIntent => ({ subject: "price", operator: "below", value: v });

const stat = (price: number): LevelDraft => ({ kind: "static", price });

/** A developing anchored VWAP — derived, so arming must resolve it. */
const developingVwap = (from: number): LevelDraft => ({
  kind: "derived",
  source: "avwap",
  params: {},
  window: { from, to: "developing" },
  field: "vwap",
  resolve: "live",
  driftTolerance: { pct: 2 },
  onDrift: "invalidate",
});

/** createPlan returns a refusal envelope now — a compile failure must not be
 *  mistaken for a stored plan. */
function unwrap(res: ReturnType<typeof createPlan>) {
  if (!res.ok) throw new Error(`createPlan refused: ${res.reason}`);
  return res.plan;
}

function planInput(sessionId: number, over: Partial<PlanInput> = {}): PlanInput {
  return {
    sessionId,
    slug: "range-break",
    pair: PAIR,
    thesis: "Reclaiming the range high opens the gap above.",
    assumptions: [{ text: "The shelf is real supply.", tag: "range-high-reclaim" }],
    invalidation: priceBelow(90),
    expiresAt: T0 + 10 * DAY,
    risk: { maxQuote: 250 },
    ocoExclusive: true,
    evalInterval: "4h",
    branches: [
      {
        id: "breakout",
        label: "breakout",
        trigger: priceAbove(105),
        entry: stat(105),
        stop: stat(97),
        targets: [stat(120)],
        budgetSharePct: 100,
      },
    ],
    ...over,
  };
}

/** 60 bars of flat-ish 4h candles with a known aggressor split. */
function seedBars(count = 60): number {
  const candles = [];
  for (let i = 0; i < count; i++) {
    const close = 100 + (i % 5);
    candles.push({
      timestamp: T0 + i * BAR,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
      takerBuyVolume: 600,
    });
  }
  seedTestCandles(PAIR, 240, candles);
  return T0 + (count - 1) * BAR;
}

describe("plan persistence", () => {
  beforeEach(() => {
    setupTestDb();
    levelResolver.reset();
  });
  afterEach(() => cleanupTestDb());

  test("a plan is created as a draft, gate or no gate", () => {
    const s = createTestSession(PAIR);
    /* Deliberately incomplete: no assumptions. Saving must still work — the
       gate belongs at arming, not at every keystroke. */
    const p = unwrap(createPlan(planInput(s.id, { assumptions: [] })));
    assert.equal(p.state, "draft");
    assert.equal(getPlan(p.rowId)?.assumptions.length, 0);
  });

  test("branches round-trip with their levels intact", () => {
    const s = createTestSession(PAIR);
    const p = unwrap(createPlan(planInput(s.id)));
    const back = getPlan(p.rowId)!;
    assert.equal(back.branches.length, 1);
    assert.equal(back.branches[0]?.id, "breakout");
    assert.deepEqual(back.branches[0]?.entry, { kind: "static", price: 105 });
    assert.deepEqual(back.branches[0]?.targets, [{ kind: "static", price: 120 }]);
  });

  test("a duplicate name is refused as a value, not raised as a storage error", () => {
    const s = createTestSession(PAIR);
    unwrap(createPlan(planInput(s.id, { slug: "range-break" })));

    /* Before this guard the UNIQUE index raised, `safe()` classified it, and
       the owner saw "couldn't read or write local data" for what is actually
       a name clash (first UI test run, §2.8). The refusal must name the plan
       so the message is actionable. */
    const again = createPlan(planInput(s.id, { slug: "range-break" }));
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.match(again.reason, /range-break/);
    assert.match(again.reason, /pick another name/i);
  });

  test("a name is taken even by a plan that has finished", () => {
    const s = createTestSession(PAIR);
    const p = unwrap(createPlan(planInput(s.id, { slug: "held" })));
    armPlan(p.rowId, T0 + 5 * DAY);
    transitionPlan(p.rowId, "expired", "test");

    /* `idx_plans_slug` has no state filter on purpose: the name is how the
       calibration record refers to that thesis, so it is not recycled. */
    const again = createPlan(planInput(s.id, { slug: "held" }));
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.match(again.reason, /expired/);
  });

  test("the same name in a different session is fine", () => {
    const a = createTestSession("BTC-USD");
    const b = createTestSession("ETH-USD");
    unwrap(createPlan(planInput(a.id, { slug: "range-break" })));
    /* Plans are session-scoped; two sessions may each hold a thesis of the
       same name without either being ambiguous. */
    const other = createPlan(planInput(b.id, { slug: "range-break", pair: "ETH-USD" }));
    assert.equal(other.ok, true);
  });

  test("plans list per session", () => {
    const a = createTestSession("BTC-USD");
    const b = createTestSession("ETH-USD");
    createPlan(planInput(a.id, { slug: "one" }));
    createPlan(planInput(b.id, { slug: "two", pair: "ETH-USD" }));
    assert.equal(listPlans(a.id).length, 1);
    assert.equal(listPlans(b.id).length, 1);
  });
});

describe("arming", () => {
  beforeEach(() => {
    setupTestDb();
    levelResolver.reset();
  });
  afterEach(() => cleanupTestDb());

  test("the falsifiability gate runs at arm — a draft missing assumptions is refused", () => {
    const s = createTestSession(PAIR);
    const p = unwrap(createPlan(planInput(s.id, { assumptions: [] })));
    const res = armPlan(p.rowId, T0 + 5 * DAY);
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /at least one assumption/i);
    assert.equal(getPlan(p.rowId)?.state, "draft", "a refused arm must not change state");
  });

  test("a complete plan with static levels arms", () => {
    const s = createTestSession(PAIR);
    const p = unwrap(createPlan(planInput(s.id)));
    const res = armPlan(p.rowId, T0 + 5 * DAY);
    assert.equal(res.ok, true, res.errors.join(" | "));

    const back = getPlan(p.rowId)!;
    assert.equal(back.state, "planned");
    assert.equal(typeof back.armedAt, "number");
  });

  test("arming resolves a derived level and records resolvedAtArm", () => {
    const s = createTestSession(PAIR);
    const last = seedBars();
    const p = unwrap(createPlan(
      planInput(s.id, {
        branches: [
          {
            id: "breakout",
            label: "breakout",
            trigger: priceAbove(105),
            entry: developingVwap(T0),
            stop: stat(90),
            targets: [stat(130)],
            budgetSharePct: 100,
          },
        ],
      })
    ));

    const res = armPlan(p.rowId, last);
    assert.equal(res.ok, true, res.errors.join(" | "));
    assert.equal(res.resolved.length, 1);
    assert.ok(Number.isFinite(res.resolved[0]?.price));

    const entry = getPlan(p.rowId)!.branches[0]!.entry as { resolvedAtArm?: number };
    assert.ok(
      Number.isFinite(entry.resolvedAtArm),
      "the armed value must be persisted — it is the baseline every drift check uses"
    );
    /* Bars close between 100 and 104, so a VWAP over them must land in range.
       Asserting the band rather than a literal keeps this a correctness test
       rather than a snapshot of the fixture's arithmetic. */
    assert.ok(entry.resolvedAtArm! >= 99 && entry.resolvedAtArm! <= 105, `got ${entry.resolvedAtArm}`);
  });

  test("a level that cannot be resolved REFUSES the arm rather than storing a placeholder", () => {
    /* No candles seeded, so the anchored VWAP has nothing to accumulate. The
       failure mode being prevented: writing 0 or NaN as resolvedAtArm, which
       would make every later drift answer fiction. */
    const s = createTestSession(PAIR);
    const p = unwrap(createPlan(
      planInput(s.id, {
        branches: [
          {
            id: "breakout",
            label: "breakout",
            trigger: priceAbove(105),
            entry: developingVwap(T0),
            stop: stat(90),
            targets: [stat(130)],
            budgetSharePct: 100,
          },
        ],
      })
    ));

    const res = armPlan(p.rowId, T0 + 5 * DAY);
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /could not be resolved|evaluate false forever/i);

    const back = getPlan(p.rowId)!;
    assert.equal(back.state, "draft");
    const entry = back.branches[0]!.entry as { resolvedAtArm?: number };
    assert.equal(
      Object.prototype.hasOwnProperty.call(entry, "resolvedAtArm"),
      false,
      "a refused arm must not leave a fabricated baseline behind"
    );
  });

  test("an armed plan cannot be armed twice", () => {
    const s = createTestSession(PAIR);
    const p = unwrap(createPlan(planInput(s.id)));
    assert.equal(armPlan(p.rowId, T0 + 5 * DAY).ok, true);
    const again = armPlan(p.rowId, T0 + 6 * DAY);
    assert.equal(again.ok, false);
    assert.match(again.errors.join(" "), /cannot be armed/i);
  });
});

describe("an armed plan is a commitment", () => {
  beforeEach(() => {
    setupTestDb();
    levelResolver.reset();
  });
  afterEach(() => cleanupTestDb());

  test("editing an armed plan is refused — the plan that fires must be the plan approved", () => {
    const s = createTestSession(PAIR);
    const p = unwrap(createPlan(planInput(s.id)));
    armPlan(p.rowId, T0 + 5 * DAY);
    const res = updatePlan(p.rowId, planInput(s.id, { thesis: "actually something else" }));
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /can't be edited/i);
    assert.match(getPlan(p.rowId)!.thesis, /Reclaiming/);
  });

  test("a draft can be edited freely", () => {
    const s = createTestSession(PAIR);
    const p = unwrap(createPlan(planInput(s.id)));
    assert.equal(updatePlan(p.rowId, planInput(s.id, { thesis: "revised" })).ok, true);
    assert.equal(getPlan(p.rowId)!.thesis, "revised");
  });

  test("a draft can be deleted; an armed plan cannot — it is the record", () => {
    const s = createTestSession(PAIR);
    const draft = unwrap(createPlan(planInput(s.id, { slug: "a" })));
    assert.equal(deletePlan(draft.rowId).ok, true);

    const armed = unwrap(createPlan(planInput(s.id, { slug: "b" })));
    armPlan(armed.rowId, T0 + 5 * DAY);
    const res = deletePlan(armed.rowId);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /part of your record/i);
  });

  test("expired and invalidated are recorded distinctly, with a reason", () => {
    const s = createTestSession(PAIR);
    const p = unwrap(createPlan(planInput(s.id)));
    armPlan(p.rowId, T0 + 5 * DAY);

    assert.equal(transitionPlan(p.rowId, "invalidated", "closed below 90 on the 4h").ok, true);
    const back = getPlan(p.rowId)!;
    assert.equal(back.state, "invalidated");
    assert.match(back.outcomeReason ?? "", /closed below 90/);

    // Terminal means terminal.
    assert.equal(transitionPlan(p.rowId, "triggered").ok, false);
  });
});

describe("writes are atomic", () => {
  beforeEach(() => {
    setupTestDb();
    levelResolver.reset();
  });
  afterEach(() => cleanupTestDb());

  test("withTransaction rolls back every statement when one throws", () => {
    /* The property the whole transaction change exists for. Before it, a
       multi-row write that failed halfway left a half-written record with
       nothing able to notice — a plan with no branches still lists, and still
       offers an Arm button. */
    const s = createTestSession(PAIR);
    const before = listPlans(s.id).length;

    assert.throws(() =>
      withTransaction((db) => {
        db.prepare(
          `INSERT INTO trade_plans
             (session_id, slug, pair, thesis, invalidation_json, expires_at, risk_json, created_at, updated_at)
           VALUES (?, 'half-written', ?, 't', '{}', ?, '{}', ?, ?)`
        ).run(s.id, PAIR, T0 + DAY, T0, T0);
        throw new Error("branch write failed");
      })
    );

    assert.equal(listPlans(s.id).length, before, "the plan row must not survive the rollback");
  });

  test("a failing branch write takes the whole plan with it", () => {
    const s = createTestSession(PAIR);
    const before = listPlans(s.id).length;

    /* budget_share_pct is NOT NULL; passing undefined makes the branch INSERT
       fail after the plan INSERT has already run. */
    assert.throws(() =>
      createPlan(
        planInput(s.id, {
          slug: "doomed",
          branches: [
            {
              id: "b",
              label: "b",
              trigger: priceAbove(1),
              entry: stat(1),
              stop: stat(1),
              targets: [stat(2)],
              budgetSharePct: undefined as unknown as number,
            },
          ],
        })
      )
    );

    assert.equal(
      listPlans(s.id).length,
      before,
      "no orphaned plan row — a plan with no branches would still look armable"
    );
  });

  test("nested calls join the outer transaction rather than opening a second", () => {
    /* SQLite has no nested transactions. Joining is deliberate: savepoints
       would let an inner rollback silently keep an outer write. */
    const s = createTestSession(PAIR);
    assert.throws(() =>
      withTransaction(() => {
        createPlan(planInput(s.id, { slug: "inner" }));
        throw new Error("outer failed after inner committed nothing");
      })
    );
    assert.equal(
      listPlans(s.id).filter((p) => p.slug === "inner").length,
      0,
      "the inner write must roll back with the outer transaction"
    );
  });
});
