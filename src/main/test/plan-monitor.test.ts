/**
 * What an armed plan does on a bar (roadmap S3-3).
 *
 * The precedence between checks is the design, so most of these tests are
 * about *which* thing wins when a bar satisfies more than one. Getting that
 * order wrong does not crash anything — it quietly writes the wrong outcome
 * into the calibration record, which is the only evidence a plans-only product
 * accumulates.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluatePlan, planIsWatchable, type PlanBarContext } from "../plans/plan-monitor";
import type { StoredPlan, StoredBranch } from "../plans/plan-service";
import type { ConditionGroup } from "../strategy/strategy-spec";
import type { LevelDraft } from "../plans/level-reference";

const T0 = 1_785_000_000_000;
const DAY = 86_400_000;

const TRIGGER: ConditionGroup = {
  logic: "and",
  conditions: [{ indicator: "price", params: {}, operator: "crosses_above", value: 100 }],
};
const INVALIDATION: ConditionGroup = {
  logic: "and",
  conditions: [{ indicator: "price", params: {}, operator: "below", value: 60 }],
};

const stat = (price: number): LevelDraft => ({ kind: "static", price });

const derived = (): LevelDraft => ({
  kind: "derived",
  source: "avwap",
  params: {},
  window: { from: T0 - 30 * DAY, to: "developing" },
  field: "vwap",
  resolve: "live",
  driftTolerance: { pct: 2 },
  onDrift: "invalidate",
});

function branch(over: Partial<StoredBranch> = {}): StoredBranch {
  return {
    rowId: 1,
    id: "breakout",
    label: "breakout",
    trigger: TRIGGER,
    entry: stat(100),
    stop: stat(90),
    targets: [stat(130)],
    budgetSharePct: 100,
    status: "pending",
    triggeredAt: null,
    positionId: null,
    ...over,
  };
}

function plan(over: Partial<StoredPlan> = {}): StoredPlan {
  return {
    rowId: 1,
    slug: "p",
    sessionId: 1,
    pair: "BTC-USD",
    thesis: "t",
    assumptions: [{ text: "a" }],
    invalidation: INVALIDATION,
    expiresAt: T0 + 10 * DAY,
    risk: { maxQuote: 250 },
    ocoExclusive: true,
    evalInterval: "4h",
    state: "planned",
    armedAt: T0,
    outcomeReason: null,
    branches: [branch()],
    ...over,
  } as StoredPlan;
}

/** Context where nothing fires and every level resolves cleanly. */
function ctx(over: Partial<PlanBarContext> = {}): PlanBarContext {
  return {
    now: T0,
    evaluate: () => false,
    resolve: () => ({ price: 100, drifted: false }),
    ...over,
  };
}

describe("nothing happens when nothing is true", () => {
  test("a quiet bar produces no outcome", () => {
    const res = evaluatePlan(plan(), ctx());
    assert.equal(res.outcome.kind, "none");
    assert.deepEqual(res.notices, []);
  });
});

describe("precedence — which check wins when a bar satisfies several", () => {
  test("expiry beats a trigger on the same bar", () => {
    /* A stale conditional firing into a different market is the worst failure
       mode of scenario automation. Expiry must win. */
    const res = evaluatePlan(
      plan({ expiresAt: T0 - 1 }),
      ctx({ evaluate: () => true })
    );
    assert.equal(res.outcome.kind, "expired");
  });

  test("expiry beats invalidation too — the plan simply ran out", () => {
    const res = evaluatePlan(plan({ expiresAt: T0 }), ctx({ evaluate: () => true }));
    assert.equal(res.outcome.kind, "expired");
  });

  test("invalidation beats a trigger on the same bar", () => {
    /* Recording a bar that both fired and disproved the thesis as a *trigger*
       would flatter the thesis in the calibration record. */
    const res = evaluatePlan(plan(), ctx({ evaluate: (g) => g === INVALIDATION || g === TRIGGER }));
    assert.equal(res.outcome.kind, "invalidated");
  });

  test("a drifted level disqualifies its branch before the trigger is considered", () => {
    const res = evaluatePlan(
      plan({ branches: [branch({ entry: derived() })] }),
      ctx({ evaluate: (g) => g === TRIGGER, resolve: () => ({ price: 120, drifted: true }) })
    );
    assert.equal(res.outcome.kind, "none", "a drifted branch must not fire");
    assert.match(res.notices.join(" "), /drifted past its tolerance/);
  });

  test("an unresolvable level disqualifies its branch, and says so", () => {
    /* Fail closed — but loudly. A plan that silently cannot fire looks armed
       and is not, which is the failure this project keeps finding. */
    const res = evaluatePlan(
      plan({ branches: [branch({ entry: derived() })] }),
      ctx({ evaluate: (g) => g === TRIGGER, resolve: () => ({ price: null }) })
    );
    assert.equal(res.outcome.kind, "none");
    assert.match(res.notices.join(" "), /could not be resolved/);
  });

  test("a static level is never subject to drift", () => {
    const res = evaluatePlan(
      plan(),
      ctx({ evaluate: (g) => g === TRIGGER, resolve: () => ({ price: null, drifted: true }) })
    );
    assert.equal(res.outcome.kind, "triggered", "static levels do not consult the resolver");
  });
});

describe("triggering and OCO", () => {
  test("a trigger fires and names its branch", () => {
    const res = evaluatePlan(plan(), ctx({ evaluate: (g) => g === TRIGGER }));
    assert.equal(res.outcome.kind, "triggered");
    if (res.outcome.kind !== "triggered") return;
    assert.equal(res.outcome.branchId, "breakout");
  });

  test("the first branch to fire cancels its siblings", () => {
    /* Without this a plan describing two ways the market might resolve could
       take both and end up silently double-sized. */
    const res = evaluatePlan(
      plan({
        branches: [
          branch({ rowId: 1, id: "a", label: "a" }),
          branch({ rowId: 2, id: "b", label: "b" }),
          branch({ rowId: 3, id: "c", label: "c" }),
        ],
      }),
      ctx({ evaluate: (g) => g === TRIGGER })
    );
    assert.equal(res.outcome.kind, "triggered");
    if (res.outcome.kind !== "triggered") return;
    assert.equal(res.outcome.branchId, "a");
    assert.deepEqual(res.outcome.cancelledBranchIds, ["b", "c"]);
  });

  test("with OCO disabled, siblings are left alone", () => {
    const res = evaluatePlan(
      plan({
        ocoExclusive: false,
        branches: [branch({ rowId: 1, id: "a", label: "a" }), branch({ rowId: 2, id: "b", label: "b" })],
      }),
      ctx({ evaluate: (g) => g === TRIGGER })
    );
    assert.equal(res.outcome.kind, "triggered");
    if (res.outcome.kind !== "triggered") return;
    assert.deepEqual(res.outcome.cancelledBranchIds, []);
  });

  test("only pending branches are considered", () => {
    const res = evaluatePlan(
      plan({ branches: [branch({ status: "cancelled_oco" }), branch({ rowId: 2, id: "b", status: "triggered" })] }),
      ctx({ evaluate: (g) => g === TRIGGER })
    );
    assert.equal(res.outcome.kind, "none");
  });

  test("a drifted branch does not block a healthy sibling", () => {
    const res = evaluatePlan(
      plan({
        branches: [
          branch({ rowId: 1, id: "bad", label: "bad", entry: derived() }),
          branch({ rowId: 2, id: "good", label: "good" }),
        ],
      }),
      ctx({
        evaluate: (g) => g === TRIGGER,
        resolve: () => ({ price: 1, drifted: true }),
      })
    );
    assert.equal(res.outcome.kind, "triggered");
    if (res.outcome.kind !== "triggered") return;
    assert.equal(res.outcome.branchId, "good");
    assert.match(res.notices.join(" "), /bad:/);
  });

  test("a drifted TARGET disqualifies the branch, not just entry or stop", () => {
    /* Entering against an approved stop toward a target that moved is not the
       trade that was approved — the reward half of the geometry changed. */
    const res = evaluatePlan(
      plan({ branches: [branch({ targets: [derived()] })] }),
      ctx({ evaluate: (g) => g === TRIGGER, resolve: () => ({ price: 200, drifted: true }) })
    );
    assert.equal(res.outcome.kind, "none");
  });
});

describe("what is watched", () => {
  test("a triggered plan is still watched — a thesis can fail while a position is green", () => {
    assert.equal(planIsWatchable({ state: "triggered" }), true);
    assert.equal(planIsWatchable({ state: "planned" }), true);
  });

  test("drafts and terminal plans are not watched", () => {
    for (const state of ["draft", "closed", "expired", "invalidated"] as const) {
      assert.equal(planIsWatchable({ state }), false, state);
    }
  });
});
