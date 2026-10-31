/**
 * The agent can see the product (roadmap J-1, awareness half).
 *
 * Before this, the agent had sixteen tools and **not one of them could observe
 * a plan**. `buildSessionContext` injected the pair, trade stats, journal and
 * lessons — nothing about what was armed. So when the owner asked it to "paper
 * trade the armed plan", it was not merely missing vocabulary: it could not see
 * that the plan existed, and answered about strategies, the one thing it could
 * observe.
 *
 * Two things are pinned here, and they fail in different ways:
 *
 *  1. **The tools read plans, session-scoped and read-only.** A write path
 *     appearing here would be the arming tool that must never exist.
 *  2. **The context names armed plans without being asked.** Tools alone do not
 *     fix blindness — a tool is only called when the model already suspects
 *     there is something to look at.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession } from "./test-helper";
import { PLAN_TOOLS, executeSessionTool } from "../agent/tools";
import { buildSessionContext } from "../agent/context";
import { createPlan, armPlan, getPlan, type PlanInput } from "../plans/plan-service";

const PAIR = "BTC-USD";
const T0 = 1_785_000_000_000;
const DAY = 86_400_000;

function planInput(sessionId: number, over: Partial<PlanInput> = {}): PlanInput {
  return {
    sessionId,
    slug: "range-break",
    pair: PAIR,
    thesis: "Reclaiming 100 opens the gap to 130.",
    assumptions: [{ text: "The 100 shelf is real supply." }],
    invalidation: { subject: "price", operator: "below", value: 80 },
    expiresAt: Date.now() + 30 * DAY,
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
    ...over,
  };
}

function makeArmed(sessionId: number, over: Partial<PlanInput> = {}) {
  const res = createPlan(planInput(sessionId, over));
  if (!res.ok) throw new Error(res.reason);
  const arm = armPlan(res.plan.rowId, T0);
  if (!arm.ok) throw new Error(arm.errors.join(" | "));
  return res.plan.rowId;
}

describe("the agent's plan tools", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("NOTHING arms, edits or deletes a plan — the invariant, not the tool count", () => {
    /* This deliberately does not pin the list. Tools get added; the guarantee
       that must survive every addition is that none of them arms. Arming is the
       owner's signature, and a tool that does not exist cannot be reached by a
       jailbreak, by an instruction inside a fetched page, or by a refactor that
       forgets a check — the same argument that keeps `live_auto` out of
       `PlanState` rather than behind a guard. */
    const names = PLAN_TOOLS.map((t) => t.name);
    for (const forbidden of [
      "arm_plan",
      "update_plan",
      "edit_plan",
      "delete_plan",
      "transition_plan",
      "set_venue",
      "place_order",
    ]) {
      assert.ok(!names.includes(forbidden), `${forbidden} must never exist`);
    }
    /* The one writer that does exist says "draft" in its name and its
       description, so a reader of the catalogue cannot mistake it for arming. */
    assert.ok(names.includes("draft_plan"));
    const draft = PLAN_TOOLS.find((t) => t.name === "draft_plan")!;
    assert.match(draft.description, /never arm|cannot arm|can never arm/i);
  });

  test("list_plans reports state and says what armed actually means", async () => {
    const s = createTestSession(PAIR);
    makeArmed(s.id);

    const res = (await executeSessionTool("list_plans", {}, s.id)) as {
      count: number;
      watched_states_note: string;
      plans: Array<{ name: string; state: string; branches: number }>;
    };

    assert.equal(res.count, 1);
    assert.equal(res.plans[0]?.name, "range-break");
    assert.equal(res.plans[0]?.state, "planned");
    /* The note is the fix for the actual failure: "planned" alone left the
       model to guess whether anything was running, and it guessed wrong. */
    assert.match(res.watched_states_note, /ARMED/);
    assert.match(res.watched_states_note, /opens a paper position/i);
  });

  test("get_plan returns the assumptions and the invalidation, not just prices", async () => {
    const s = createTestSession(PAIR);
    const rowId = makeArmed(s.id);

    const res = (await executeSessionTool("get_plan", { plan_id: rowId }, s.id)) as {
      assumptions: string[];
      thesis_invalidation: string;
      branches: Array<{ entry: unknown; stop: unknown; targets: unknown[] }>;
    };

    /* A plan is judged against its assumptions; a reviewer or critic that only
       sees prices is judging a different object. */
    assert.equal(res.assumptions.length, 1);
    assert.match(res.assumptions[0]!, /shelf/);
    assert.match(res.thesis_invalidation, /80/);
    assert.deepEqual(res.branches[0]?.entry, { kind: "price", value: 100 });
  });

  test("get_plan refuses a plan belonging to another session", async () => {
    const a = createTestSession("BTC-USD");
    const b = createTestSession("ETH-USD");
    const rowId = makeArmed(a.id);

    /* Session-scoped like every other tool here. Reading across sessions would
       let an archived pair's context leak into a live conversation. */
    await assert.rejects(() => executeSessionTool("get_plan", { plan_id: rowId }, b.id), /different session/i);
  });

  test("get_plan refuses a missing or non-numeric id rather than guessing", async () => {
    const s = createTestSession(PAIR);
    await assert.rejects(() => executeSessionTool("get_plan", {}, s.id), /numeric plan_id/i);
    await assert.rejects(() => executeSessionTool("get_plan", { plan_id: 9999 }, s.id), /No plan/i);
  });
});

describe("the session context names armed plans unprompted", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("an armed plan appears with its thesis and the execution boundary", () => {
    const s = createTestSession(PAIR);
    makeArmed(s.id);

    const ctx = buildSessionContext(s.id);
    assert.match(ctx, /Armed plans/);
    assert.match(ctx, /range-break/);
    assert.match(ctx, /gap to 130/);
    /* The line that states what a trigger actually does. It used to assert
       the opposite ("does NOT open a position yet") and kept passing after
       S3-3 made it false — a test certifying a stale fact. */
    assert.match(ctx, /opens a PAPER\s+position/);
    assert.match(ctx, /cannot create or arm a plan/i);
  });

  test("a draft is not announced as armed", () => {
    const s = createTestSession(PAIR);
    const res = createPlan(planInput(s.id));
    assert.equal(res.ok, true);

    /* A draft is where the owner is still thinking. Presenting it as watched
       would be the same ambiguity the state labels exist to prevent. */
    assert.ok(!buildSessionContext(s.id).includes("Armed plans"));
  });

  test("a session with no plans says nothing about them", () => {
    const s = createTestSession(PAIR);
    /* An always-present empty section trains the reader to skip the block —
       the same reason Home's attention list disappears when empty. */
    assert.ok(!buildSessionContext(s.id).includes("Armed plans"));
  });
});

describe("the agent can author, but only as a draft", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("draft_plan saves as a draft and never as armed", async () => {
    const s = createTestSession(PAIR);
    const res = (await executeSessionTool(
      "draft_plan",
      {
        name: "agent-drafted",
        thesis: "Reclaiming 100 opens the gap to 130.",
        assumptions: ["The 100 shelf is real supply."],
        invalidation_price: 80,
        invalidation_direction: "below",
        expires_in_days: 14,
        risk_budget_quote: 250,
        branches: [
          {
            label: "breakout",
            trigger_price: 100,
            trigger_direction: "crosses_above",
            entry_price: 100,
            stop_price: 90,
            target_price: 130,
            budget_share_pct: 100,
          },
        ],
      },
      s.id
    )) as { created: boolean; plan_id: number; state: string; missing_before_arming: string[] };

    assert.equal(res.created, true);
    assert.equal(res.state, "draft");
    /* The whole point. An agent-authored plan reaching `planned` would mean
       capital committed without the owner's signature. */
    const stored = getPlan(res.plan_id)!;
    assert.equal(stored.state, "draft");
    assert.equal(stored.armedAt, null);
    assert.equal(res.missing_before_arming.length, 0, "a complete draft has nothing outstanding");
  });

  test("a draft with no invalidation is refused, and the refusal teaches", async () => {
    const s = createTestSession(PAIR);
    /* Not a loosening candidate. `createPlan` compiles conditions up front and
       refuses a non-numeric one rather than storing an empty group (S2-8) — so
       a plan without an invalidation cannot exist, and the tool should say why
       instead of failing obscurely. "What would prove this wrong?" is the
       question the gate exists to force. */
    await assert.rejects(
      () => executeSessionTool("draft_plan", { name: "half-formed", thesis: "Something might happen." }, s.id),
      /THESIS is wrong|not the stop/i
    );
  });

  test("an otherwise-incomplete draft saves, and reports what arming will still need", async () => {
    const s = createTestSession(PAIR);
    /* A draft IS where you think — refusing to save an unfinished thought
       pushes authoring back into a text file. Assumptions and a budget can come
       later; the agent's job is to say so rather than let the owner discover it
       at the gate. */
    const res = (await executeSessionTool(
      "draft_plan",
      {
        name: "half-formed",
        thesis: "Something might happen.",
        invalidation_price: 80,
        invalidation_direction: "below",
      },
      s.id
    )) as { created: boolean; missing_before_arming: string[]; note: string };

    assert.equal(res.created, true);
    const missing = res.missing_before_arming.join(" ");
    assert.match(missing, /assumption/i);
    assert.match(missing, /risk budget/i);
    assert.match(res.note, /cannot be armed/i);
  });

  test("a branch built on an unknown reference id is refused, not silently retyped", async () => {
    const s = createTestSession(PAIR);
    /* Falling back to a typed price here would build the plan on a different
       level than the agent named — two definitions of one level, which is the
       failure the whole reference layer exists to prevent. */
    await assert.rejects(
      () =>
        executeSessionTool(
          "draft_plan",
          {
            name: "bad-ref",
            thesis: "t",
            invalidation_price: 80,
            branches: [
              {
                label: "b",
                trigger_price: 100,
                trigger_direction: "crosses_above",
                entry_reference_id: 4242,
                stop_price: 90,
                target_price: 130,
              },
            ],
          },
          s.id
        ),
      /No level reference/i
    );
  });

  test("create_level_reference names a level the engine can resolve", async () => {
    const s = createTestSession(PAIR);
    const made = (await executeSessionTool(
      "create_level_reference",
      { label: "June supply shelf", price: 72400 },
      s.id
    )) as { reference_id: number; label: string };

    assert.ok(made.reference_id > 0);

    const listed = (await executeSessionTool("list_level_references", {}, s.id)) as {
      count: number;
      references: Array<{ reference_id: number; label: string; level: unknown }>;
    };
    assert.equal(listed.count, 1);
    assert.equal(listed.references[0]?.label, "June supply shelf");
    assert.deepEqual(listed.references[0]?.level, { kind: "price", value: 72400 });
  });

  test("a drafted plan can then be armed by the owner's own path", async () => {
    const s = createTestSession(PAIR);
    const res = (await executeSessionTool(
      "draft_plan",
      {
        name: "hand-off",
        thesis: "Reclaiming 100 opens the gap to 130.",
        assumptions: ["The shelf is real."],
        invalidation_price: 80,
        invalidation_direction: "below",
        expires_in_days: 10,
        risk_budget_quote: 250,
        branches: [
          {
            label: "breakout",
            trigger_price: 100,
            trigger_direction: "crosses_above",
            entry_price: 100,
            stop_price: 90,
            target_price: 130,
          },
        ],
      },
      s.id
    )) as { plan_id: number };

    /* The hand-off is the product: the agent drafts, the owner signs. If a
       draft the agent wrote could not pass the same gate a hand-authored one
       does, the tool would be producing plans that look real and cannot run. */
    const armed = armPlan(res.plan_id);
    assert.equal(armed.ok, true, armed.ok ? "" : armed.errors.join(" | "));
    assert.equal(getPlan(res.plan_id)!.state, "planned");
  });
});
