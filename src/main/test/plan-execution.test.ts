/**
 * A plan trigger opens, manages and closes a real position (roadmap S1-2).
 *
 * This is the smoke test the whole of Sprint 3 was waiting behind: before it,
 * `paper_positions` had never held a single row in this project's life, and the
 * plan monitor deliberately recorded triggers that opened nothing. Everything
 * downstream — the calibration record, the away-notifications, the review
 * agent's plan prompt — takes its input from here.
 *
 * What is pinned is the arithmetic and the refusals, not the happy path alone.
 * The failures worth catching are the quiet ones: a position sized off the
 * balance instead of the plan's own budget, a stop that ratchets when the owner
 * approved a fixed price, an entry taken at a price that is already past the
 * stop, a restart that forgets it is holding something.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, seedTestCandles, createTestSession } from "./test-helper";
import { PaperExchangeEngine } from "../paper/paper-exchange";
import { createPlan, armPlan, getPlan, type PlanInput } from "../plans/plan-service";
import { getDb } from "../db/database";
import { killSwitch } from "../risk/kill-switch";
import { getPaperBalance } from "../paper/account";
import type { CandleNumeric } from "../insights/indicator-types";
import type { ConditionIntent } from "../plans/condition-intent";

const PAIR = "BTC-USD";
const T0 = 1_785_000_000_000;
const BAR = 240 * 60_000;
const DAY = 86_400_000;

/* The fill model, restated here on purpose. If these drift from
   DEFAULT_BACKTEST_CONFIG the test should fail — a paper fill and a backtest
   fill silently disagreeing is the failure this project has already paid for. */
const FEE_RATE = 25 / 10_000;
const SLIPPAGE = 5 / 10_000;
const buyFill = (close: number) => close * (1 + SLIPPAGE);

const bar = (t: number, o: number, h: number, l: number, c: number): CandleNumeric => ({
  timestamp: t,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 10,
});

/** Price walks 95 → 105, so "crosses above 100" fires on the third bar. */
const risingBars = (): CandleNumeric[] => [
  bar(T0, 95, 96, 94, 95),
  bar(T0 + BAR, 95, 99, 95, 98),
  bar(T0 + BAR * 2, 98, 106, 98, 105),
];

/* Seed only the first bar — `seedBuffer` primes from the database, so seeding
   every bar and then replaying them appends history the engine has seen. */
function seedPriming(bars: CandleNumeric[]) {
  seedTestCandles(PAIR, 240, bars.slice(0, 1));
}

function feed(paper: PaperExchangeEngine, c: CandleNumeric, closed = true) {
  paper.handleCandle(PAIR, 240, {
    start: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    closed,
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

const positionRow = () =>
  getDb().prepare("SELECT * FROM paper_positions ORDER BY id DESC LIMIT 1").get() as any;

describe("a triggered branch opens a position", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("the position carries the branch's approved stop and target", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    const rowId = armed(s.id);

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    const pos = positionRow();
    assert.ok(pos, "a position row exists");
    assert.equal(parseFloat(pos.stop_price), 90, "the stop is the price the owner approved");
    assert.equal(parseFloat(pos.target_price), 130);
    assert.equal(pos.status, "open");
    /* Schema v15: a plan-owned position has no strategy, and the branch is the
       authoritative link. Inventing a strategy row to satisfy the old NOT NULL
       is the shortcut that migration exists to reject. */
    assert.equal(pos.strategy_id, null, "no synthetic strategy is invented");
    assert.ok(pos.plan_branch_id, "the branch owns it");
    assert.equal(getPlan(rowId)!.branches[0]!.positionId, pos.id);
  });

  test("the entry order carries no strategy id", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    armed(s.id);

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    const order = getDb().prepare("SELECT * FROM orders WHERE side = 'buy'").get() as any;
    /* `orders.strategy_id` is a foreign key into `strategies`; there is nothing
       to point at, and pointing anyway would corrupt every per-strategy read. */
    assert.equal(order.strategy_id, null);
    assert.equal(order.mode, "paper");
  });

  test("size comes from the plan's budget, not the account balance", () => {
    /* The distinction that makes a plan a plan: an absolute quote amount the
       owner agreed to at authoring time. Sized as a percentage of a $10,000
       balance this position would be ~40x larger. */
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    armed(s.id, { risk: { maxQuote: 250 } });

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    const pos = positionRow();
    const fill = buyFill(105);
    const expectedQuote = 250 / (1 + FEE_RATE);
    assert.ok(
      Math.abs(parseFloat(pos.quantity) - expectedQuote / fill) < 1e-9,
      `quantity should be the budget at the fill price, got ${pos.quantity}`
    );
    /* Fee inside the budget, not on top of it — so a plan can never spend more
       than the number the owner wrote down. */
    assert.ok(expectedQuote + parseFloat(pos.entry_fee) <= 250 + 1e-9);
  });

  test("a branch's share of the budget is respected", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    armed(s.id, {
      risk: { maxQuote: 400 },
      branches: [
        {
          id: "breakout",
          label: "breakout",
          trigger: priceIntent("crosses_above", 100),
          entry: { kind: "static", price: 100 },
          stop: { kind: "static", price: 90 },
          targets: [{ kind: "static", price: 130 }],
          budgetSharePct: 25,
        },
      ],
    });

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    const pos = positionRow();
    const spent = parseFloat(pos.quantity) * parseFloat(pos.entry_price);
    assert.ok(Math.abs(spent - 400 * 0.25 / (1 + FEE_RATE)) < 1e-6, `spent ${spent}`);
  });

  test("cash falls by the position plus its fee", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    armed(s.id);

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    const pos = positionRow();
    const spent = parseFloat(pos.quantity) * parseFloat(pos.entry_price) + parseFloat(pos.entry_fee);
    const cash = getPaperBalance();
    assert.ok(Math.abs(cash - (10000 - spent)) < 1e-6, `cash ${cash}, spent ${spent}`);
  });
});

describe("the entry can be refused, and the trigger still counts", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("price already past the stop refuses the entry", () => {
    /* A gap through the whole setup. Taking this would be trading a geometry
       the owner never agreed to — the trade is dead before it starts. The
       refusal is derived from the owner's own stop, not an invented tolerance. */
    const s = createTestSession(PAIR);
    const bars = [
      bar(T0, 95, 96, 94, 95),
      bar(T0 + BAR, 95, 99, 95, 98),
      bar(T0 + BAR * 2, 98, 106, 98, 105),
    ];
    seedPriming(bars);
    const rowId = armed(s.id, {
      branches: [
        {
          id: "breakout",
          label: "breakout",
          trigger: priceIntent("crosses_above", 100),
          entry: { kind: "static", price: 100 },
          /* Stop above where price now is. */
          stop: { kind: "static", price: 110 },
          targets: [{ kind: "static", price: 130 }],
          budgetSharePct: 100,
        },
      ],
    });

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    const plan = getPlan(rowId)!;
    /* The branch DID fire. A trigger that fired and could not be acted on is a
       different fact from one that never fired, and the calibration record has
       to keep them apart. */
    assert.equal(plan.branches[0]!.status, "triggered");
    assert.equal(plan.branches[0]!.positionId, null, "but no position was opened");
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM paper_positions").get() as { n: number };
    assert.equal(n.n, 0);
  });

  test("price already past the target refuses the entry", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    const rowId = armed(s.id, {
      branches: [
        {
          id: "breakout",
          label: "breakout",
          trigger: priceIntent("crosses_above", 100),
          entry: { kind: "static", price: 100 },
          stop: { kind: "static", price: 90 },
          /* The move already happened; there is nothing left to be paid for. */
          targets: [{ kind: "static", price: 104 }],
          budgetSharePct: 100,
        },
      ],
    });

    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);

    const plan = getPlan(rowId)!;
    assert.equal(plan.branches[0]!.status, "triggered", "the branch fired");
    assert.equal(plan.branches[0]!.positionId, null, "but nothing was opened");
  });

  test("the kill switch blocks a plan entry", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    const rowId = armed(s.id);

    killSwitch.trip("test");
    try {
      const paper = new PaperExchangeEngine();
      paper.start(false);
      for (const c of bars) feed(paper, c);
    } finally {
      killSwitch.reset();
    }

    /* "Take no new risk" has to mean plans too, or the switch stops half the
       app — which is the same as stopping none of it, because you stop
       believing the label. */
    const plan = getPlan(rowId)!;
    assert.equal(plan.branches[0]!.status, "triggered", "watching continues while tripped");
    assert.equal(plan.branches[0]!.positionId, null, "but no new risk is taken");
  });
});

describe("an open plan position is managed and closed", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  /** Trigger, then a bar that reaches `to`. */
  function runToExit(sessionId: number, exitBar: CandleNumeric, over: Partial<PlanInput> = {}) {
    const bars = risingBars();
    seedPriming(bars);
    const rowId = armed(sessionId, over);
    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);
    feed(paper, exitBar);
    return { rowId, paper };
  }

  test("a stop is honoured intrabar and fills at the stop price", () => {
    const s = createTestSession(PAIR);
    const { rowId } = runToExit(s.id, bar(T0 + BAR * 3, 105, 105, 85, 88));

    const pos = positionRow();
    assert.equal(pos.status, "closed");
    assert.equal(pos.exit_reason, "stop_loss");
    /* Fills AT the level, matching the backtester — not at the bar's low, which
       would be claiming a fill the stop would never have got. */
    assert.equal(parseFloat(pos.exit_price), 90);
    assert.ok(parseFloat(pos.realized_pnl) < 0);
    assert.equal(getPlan(rowId)!.state, "closed", "the plan is over once its last position closes");
  });

  test("a target is honoured intrabar and fills at the target price", () => {
    const s = createTestSession(PAIR);
    const { rowId } = runToExit(s.id, bar(T0 + BAR * 3, 106, 135, 106, 133));

    const pos = positionRow();
    assert.equal(pos.exit_reason, "take_profit");
    assert.equal(parseFloat(pos.exit_price), 130);
    assert.ok(parseFloat(pos.realized_pnl) > 0);
    assert.equal(getPlan(rowId)!.state, "closed");
  });

  test("when one bar spans both, the stop wins", () => {
    const s = createTestSession(PAIR);
    /* We cannot know which tick came first, so the pessimistic assumption is
       the only honest one — the same rule the backtester follows. */
    runToExit(s.id, bar(T0 + BAR * 3, 105, 140, 85, 120));
    assert.equal(positionRow().exit_reason, "stop_loss");
  });

  test("the stop does not ratchet — a plan's stop is a price, not a distance", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    armed(s.id);
    const paper = new PaperExchangeEngine();
    paper.start(false);
    for (const c of bars) feed(paper, c);
    /* A big favourable move. A strategy with a trailing stop would ratchet
       here; a plan must not, because the owner signed a specific price and
       moving it is trading a geometry they never approved. */
    feed(paper, bar(T0 + BAR * 3, 105, 128, 105, 127));

    assert.equal(parseFloat(positionRow().stop_price), 90);
    assert.equal(positionRow().status, "open");
  });

  test("closing notifies the review agent", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    armed(s.id);
    const paper = new PaperExchangeEngine();
    const closed: number[] = [];
    paper.onPositionClosed((id) => closed.push(id));
    paper.start(false);
    for (const c of bars) feed(paper, c);
    feed(paper, bar(T0 + BAR * 3, 105, 105, 85, 88));

    /* The review is the only input the calibration record has. A plan position
       that closed without firing this would vanish from the record silently. */
    assert.equal(closed.length, 1);
    assert.equal(closed[0], positionRow().id);
  });

  test("cash returns on exit", () => {
    const s = createTestSession(PAIR);
    runToExit(s.id, bar(T0 + BAR * 3, 105, 135, 105, 133));

    const pos = positionRow();
    const cash = getPaperBalance();
    const expected = 10000 + parseFloat(pos.realized_pnl);
    assert.ok(Math.abs(cash - expected) < 1e-6, `cash ${cash} vs ${expected}`);
  });
});

describe("a restart keeps managing what it holds", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a new engine re-adopts an open plan position and still honours its stop", () => {
    const s = createTestSession(PAIR);
    const bars = risingBars();
    seedPriming(bars);
    armed(s.id);

    const first = new PaperExchangeEngine();
    first.start(false);
    for (const c of bars) feed(first, c);
    assert.equal(positionRow().status, "open");

    /* The failure this guards: an engine that forgot the position would leave
       it with nothing checking its stop while the app still displayed one —
       believing you are protected when you are not. */
    const second = new PaperExchangeEngine();
    second.start(false);
    feed(second, bar(T0 + BAR * 3, 105, 105, 85, 88));

    assert.equal(positionRow().status, "closed");
    assert.equal(positionRow().exit_reason, "stop_loss");
  });
});
