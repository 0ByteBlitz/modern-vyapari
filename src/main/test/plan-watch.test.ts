/**
 * An armed plan is actually watched (roadmap S3-3, watch-only half).
 *
 * `plan-monitor.test.ts` proves the *decision* is right. These prove the
 * decision is **reached** — that the paper engine calls the monitor on a closed
 * bar and writes the outcome down. Before this wiring, `plan-monitor.ts` was
 * imported by nothing but its own test: every plan in the database read "armed"
 * and no code path evaluated it. A control that does not control is this
 * project's recurring defect, and the state label made it invisible.
 *
 * These used to pin a **watch-only boundary** — a trigger was recorded and had
 * to open nothing, until S1-2 proved the engine could execute at all. That
 * assertion did its job: it failed the moment entry was wired, deliberately.
 * Execution itself is now pinned in `plan-execution.test.ts`.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, seedTestCandles, createTestSession } from "./test-helper";
import { PaperExchangeEngine } from "../paper/paper-exchange";
import { createPlan, armPlan, getPlan, type PlanInput } from "../plans/plan-service";
import { getDb } from "../db/database";
import type { CandleNumeric } from "../insights/indicator-types";
import type { ConditionIntent } from "../plans/condition-intent";

const PAIR = "BTC-USD";
const T0 = 1_785_000_000_000;
const BAR = 240 * 60_000;
const DAY = 86_400_000;

/** Bars that walk price from 95 up through 105, so a "crosses above 100"
 *  trigger fires on the third and a "below 80" invalidation never does. */
function risingBars(): CandleNumeric[] {
  return [
    { timestamp: T0, open: 95, high: 96, low: 94, close: 95, volume: 10 },
    { timestamp: T0 + BAR, open: 95, high: 99, low: 95, close: 98, volume: 10 },
    { timestamp: T0 + BAR * 2, open: 98, high: 106, low: 98, close: 105, volume: 10 },
  ];
}

/* Seed only the FIRST bar: `seedBuffer` primes the engine's buffer from the
   database at start-up, so seeding every bar and then replaying them appends
   history the engine has already seen — out of order, with "previous" pointing
   at the wrong bar. Live, the cache holds history and the stream delivers what
   comes next; the test has to match that shape. */
function seedPriming(bars: CandleNumeric[]) {
  seedTestCandles(PAIR, 240, bars.slice(0, 1));
}

function feed(paper: PaperExchangeEngine, c: CandleNumeric) {
  paper.handleCandle(PAIR, 240, {
    start: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    closed: true,
  });
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
    invalidation: priceIntent("below", 80),
    expiresAt: T0 + 30 * DAY,
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

function armed(sessionId: number, over: Partial<PlanInput> = {}) {
  const res = createPlan(planInput(sessionId, over));
  if (!res.ok) throw new Error(`createPlan refused: ${res.reason}`);
  const arm = armPlan(res.plan.rowId, T0);
  if (!arm.ok) throw new Error(`armPlan refused: ${arm.errors.join(" | ")}`);
  return res.plan.rowId;
}

describe("an armed plan is watched by the engine", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a trigger is recorded and its branch marked", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    const rowId = armed(s.id);

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    const plan = getPlan(rowId)!;
    assert.equal(plan.state, "triggered", "crossing 100 must trigger the plan");
    assert.equal(plan.branches[0]?.status, "triggered");
    assert.ok(plan.branches[0]?.triggeredAt, "the trigger time is recorded");
    /* The branch carries its position, so the calibration record can tell a
       trigger that was acted on from one that was not. */
    assert.ok(plan.branches[0]?.positionId, "the branch records the position it opened");
  });

  test("expiry is acted on, and beats a trigger on the same bar", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    /* Expires before the bar that would otherwise trigger it. A stale
       conditional firing into a later market is the worst failure mode of
       scenario automation, so expiry must win. */
    const rowId = armed(s.id, { expiresAt: T0 + BAR + 1 });

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    const plan = getPlan(rowId)!;
    assert.equal(plan.state, "expired");
    assert.equal(plan.branches[0]?.status, "pending", "an expired plan never fired");
  });

  test("thesis invalidation is acted on", () => {
    const s = createTestSession(PAIR);
    const bars: CandleNumeric[] = [
      { timestamp: T0, open: 95, high: 96, low: 94, close: 95, volume: 10 },
      { timestamp: T0 + BAR, open: 95, high: 95, low: 70, close: 75, volume: 10 },
    ];
    seedPriming(bars);
    const rowId = armed(s.id);

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    assert.equal(getPlan(rowId)!.state, "invalidated");
  });

  test("a plan on an archived session is not watched", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    const rowId = armed(s.id);
    getDb().prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(s.id);

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    /* Same rule as strategies: an archived session's plans never load, or a
       wound-down session could still act. */
    assert.equal(getPlan(rowId)!.state, "planned");
  });

  test("a draft is never watched", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    const res = createPlan(planInput(s.id));
    if (!res.ok) throw new Error(res.reason);

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    assert.equal(getPlan(res.plan.rowId)!.state, "draft", "an unarmed plan must not act");
  });
});
