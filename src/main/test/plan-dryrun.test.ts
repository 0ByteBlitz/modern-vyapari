/**
 * Would this plan do anything? (roadmap S3-5)
 *
 * The gate proves a plan can be *wrong*. Nothing proved it can **fire** — and
 * a plan that never triggers and one that triggers on every bar arm
 * identically, display identically, and are both useless in opposite
 * directions. These pin the four answers apart.
 *
 * **The most important test in this file is the last one**, which asserts the
 * report has nowhere to put a PnL. A dry run is the obvious side door through
 * which backtesting walks back into a product that deliberately removed it, and
 * the defence has to be the shape of the type rather than a comment asking
 * nicely.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession } from "./test-helper";
import { dryRunPlan } from "../plans/plan-dryrun";
import { createPlan, getPlan, type PlanInput } from "../plans/plan-service";
import type { CandleNumeric } from "../insights/indicator-types";
import type { ConditionIntent } from "../plans/condition-intent";

const PAIR = "BTC-USD";
const T0 = 1_785_000_000_000;
const BAR = 240 * 60_000;
const DAY = 86_400_000;
/* After the last bar, so "now" is never inside the replayed window. */
const NOW = T0 + BAR * 100;

const bar = (t: number, o: number, h: number, l: number, c: number): CandleNumeric => ({
  timestamp: t,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 10,
});

/** An injected series, so these tests never depend on cached history. */
const source = (bars: CandleNumeric[]) => () => bars;

/**
 * A slow wave through 100, so "crosses above 100" fires a handful of times over
 * twenty bars.
 *
 * Deliberately NOT a 95/105 alternation: that makes a cross condition true on
 * every other bar, which the dry run correctly calls a standing condition — the
 * fixture would be testing the rule against a series no market produces.
 */
function oscillating(n = 20): CandleNumeric[] {
  const out: CandleNumeric[] = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + 8 * Math.sin((i / n) * 4 * Math.PI);
    out.push(bar(T0 + BAR * i, c, c + 1, c - 1, c));
  }
  return out;
}

/** Price sits at 50 and never approaches 100. */
function flatLow(n = 20): CandleNumeric[] {
  return Array.from({ length: n }, (_, i) => bar(T0 + BAR * i, 50, 51, 49, 50));
}

const priceIntent = (operator: ConditionIntent["operator"], value: number): ConditionIntent => ({
  subject: "price",
  operator,
  value,
});

function planInput(sessionId: number, over: Partial<PlanInput> = {}): PlanInput {
  return {
    sessionId,
    slug: "range-break",
    pair: PAIR,
    thesis: "Reclaiming 100 opens the gap to 130.",
    assumptions: [{ text: "The 100 shelf is real supply." }],
    invalidation: priceIntent("below", 40),
    expiresAt: NOW + 30 * DAY,
    risk: { maxQuote: 250 },
    ocoExclusive: true,
    evalInterval: "4h",
    branches: [
      {
        id: "breakout",
        label: "breakout",
        trigger: priceIntent("crosses_above", 100),
        entry: { kind: "static", price: 100 },
        stop: { kind: "static", price: 90 },
        targets: [{ kind: "static", price: 130 }],
        budgetSharePct: 100,
      },
    ],
    ...over,
  };
}

function makePlan(sessionId: number, over: Partial<PlanInput> = {}) {
  const res = createPlan(planInput(sessionId, over));
  if (!res.ok) throw new Error(`createPlan refused: ${res.reason}`);
  return getPlan(res.plan.rowId)!;
}

describe("the dry run tells the four answers apart", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a plan that would fire says so, and says how often", () => {
    const s = createTestSession(PAIR);
    const plan = makePlan(s.id);
    const r = dryRunPlan(plan, { candleSource: source(oscillating()), now: NOW });

    assert.equal(r.verdict, "fires");
    assert.ok(r.branches[0]!.firedBars > 0);
    assert.ok(r.branches[0]!.firstFireAt, "the first bar it would have fired on is reported");
    assert.equal(r.branches[0]!.unreachable, false);
    assert.equal(r.branches[0]!.constant, false);
  });

  test("a plan that never fires says so, instead of looking armed and silent", () => {
    /* The failure this exists for: today this plan arms cleanly, sits there
       forever, and nothing anywhere says why nothing happened. */
    const s = createTestSession(PAIR);
    const plan = makePlan(s.id);
    const r = dryRunPlan(plan, { candleSource: source(flatLow()), now: NOW });

    assert.equal(r.verdict, "never_fires");
    assert.equal(r.branches[0]!.unreachable, true);
    assert.equal(r.branches[0]!.firedBars, 0);
  });

  test("a trigger true on most bars is called a standing condition, not a scenario", () => {
    const s = createTestSession(PAIR);
    /* "Price above 10" is always true here. It is a perfectly valid condition
       and a completely invalid thesis — it describes nothing that has to
       happen. */
    const plan = makePlan(s.id, {
      branches: [
        {
          id: "always",
          label: "always",
          trigger: priceIntent("above", 10),
          entry: { kind: "static", price: 100 },
          stop: { kind: "static", price: 90 },
          targets: [{ kind: "static", price: 130 }],
          budgetSharePct: 100,
        },
      ],
    });
    const r = dryRunPlan(plan, { candleSource: source(oscillating()), now: NOW });

    assert.equal(r.verdict, "fires_constantly");
    assert.equal(r.branches[0]!.constant, true);
  });

  test("an invalidation that is already true says the plan is over before it starts", () => {
    const s = createTestSession(PAIR);
    /* Authored while price was above 60; by the time it is armed, price is 50.
       Arming it would transition it to `invalidated` on the very next bar, and
       the owner would have no idea why. */
    const plan = makePlan(s.id, { invalidation: priceIntent("below", 60) });
    const r = dryRunPlan(plan, { candleSource: source(flatLow()), now: NOW });

    assert.equal(r.verdict, "already_over");
    assert.equal(r.invalidatedNow, true);
    assert.ok(r.headline.includes("armed"), "the headline says what would happen, not just a state name");
  });
});

describe("the dry run reports structure, not opinion", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("an unreachable branch is named even when a sibling fires", () => {
    const s = createTestSession(PAIR);
    const plan = makePlan(s.id, {
      ocoExclusive: true,
      branches: [
        {
          id: "breakout",
          label: "breakout",
          trigger: priceIntent("crosses_above", 100),
          entry: { kind: "static", price: 100 },
          stop: { kind: "static", price: 90 },
          targets: [{ kind: "static", price: 130 }],
          budgetSharePct: 50,
        },
        {
          id: "moon",
          label: "moon",
          trigger: priceIntent("crosses_above", 5000),
          entry: { kind: "static", price: 5000 },
          stop: { kind: "static", price: 4000 },
          targets: [{ kind: "static", price: 9000 }],
          budgetSharePct: 50,
        },
      ],
    });
    const r = dryRunPlan(plan, { candleSource: source(oscillating()), now: NOW });

    /* `evaluatePlan` returns the FIRST branch to fire and stops, which is right
       live (OCO) and would hide the dead sibling here. The dry run evaluates
       each branch independently for exactly this reason. */
    assert.equal(r.verdict, "fires");
    const moon = r.branches.find((b) => b.id === "moon")!;
    assert.equal(moon.unreachable, true);
    assert.ok(r.notes.some((n) => n.includes("moon")), "an unreachable branch is surfaced, not buried");
  });

  test("branches true at the same time with OCO off are called out as double-sizing", () => {
    const s = createTestSession(PAIR);
    const both: PlanInput["branches"] = [
      {
        id: "a",
        label: "a",
        trigger: priceIntent("above", 60),
        entry: { kind: "static", price: 100 },
        stop: { kind: "static", price: 90 },
        targets: [{ kind: "static", price: 130 }],
        budgetSharePct: 50,
      },
      {
        id: "b",
        label: "b",
        trigger: priceIntent("above", 70),
        entry: { kind: "static", price: 100 },
        stop: { kind: "static", price: 90 },
        targets: [{ kind: "static", price: 130 }],
        budgetSharePct: 50,
      },
    ];
    const plan = makePlan(s.id, { ocoExclusive: false, branches: both });
    const r = dryRunPlan(plan, { candleSource: source(oscillating()), now: NOW });

    assert.ok(r.branches.every((b) => b.overlappingBars > 0));
    assert.ok(
      r.notes.some((n) => n.includes("size twice")),
      "two branches firing together without OCO is a silently double-sized position"
    );
  });

  test("too little history is 'cannot evaluate', never 'never fires'", () => {
    const s = createTestSession(PAIR);
    const plan = makePlan(s.id);
    const r = dryRunPlan(plan, { candleSource: source([bar(T0, 95, 96, 94, 95)]), now: NOW });

    /* The distinction is the whole point: one is a statement about the plan,
       the other about the history. Reporting "never fires" here would condemn
       a plan for the app's missing cache. */
    assert.equal(r.verdict, "cannot_evaluate");
    assert.equal(r.branches[0]!.unreachable, false, "no claim is made about the branch");
  });

  test("a near expiry is noted", () => {
    const s = createTestSession(PAIR);
    const plan = makePlan(s.id, { expiresAt: NOW + BAR });
    const r = dryRunPlan(plan, { candleSource: source(oscillating()), now: NOW });

    assert.ok(r.notes.some((n) => n.includes("expires")));
  });
});

describe("a dry run is not a backtest", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("the report has nowhere to put a PnL", () => {
    const s = createTestSession(PAIR);
    const plan = makePlan(s.id);
    const r = dryRunPlan(plan, { candleSource: source(oscillating()), now: NOW });

    /* The guard is structural on purpose. A plan is a one-shot bet on a path,
       so statistical validation of it is *inapplicable* — and a two-trade
       sample dressed as a backtest launders a guess into a metric. That is why
       the strategy path was frozen, and a "dry run" is the obvious side door it
       would come back through. If someone adds a win rate here, this fails. */
    const banned = ["pnl", "profit", "winrate", "win_rate", "expectancy", "sharpe", "returnpct", "equity"];
    const keys = JSON.stringify(r).toLowerCase();
    for (const word of banned) {
      assert.ok(!keys.includes(`"${word}"`), `the dry run must not report ${word}`);
    }
    for (const b of r.branches) {
      assert.deepEqual(
        Object.keys(b).sort(),
        ["constant", "firedBars", "firstFireAt", "id", "label", "overlappingBars", "unreachable"],
        "a branch reports whether it fires, never how it performed"
      );
    }
  });
});
