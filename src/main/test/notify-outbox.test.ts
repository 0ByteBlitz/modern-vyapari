/**
 * The outbox — "traded but never told" and "told twice" are both impossible.
 *
 * These are the two failures the pattern exists to prevent, and both would
 * destroy trust in the away-flow in different ways: a silent miss can cost
 * money, and a duplicate alert at 3am teaches the owner to ignore the channel,
 * which costs more.
 *
 * The guarantees under test are structural, not behavioural — a unique
 * `dedupe_key` derived from the event, and enqueuing inside the same
 * transaction as the state change. A bug in the worker can delay a message;
 * neither of these lets it lose or repeat one.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession } from "./test-helper";
import { getDb, withTransaction } from "../db/database";
import { enqueue, enqueueWithin, pending, markDelivered, markFailed, abandoned, outboxStats, MAX_ATTEMPTS } from "../notify/outbox";
import { drainOnce } from "../notify/worker";
import { createPlan, armPlan, transitionPlan, getPlan, type PlanInput } from "../plans/plan-service";

const PAIR = "BTC-USD";
const T0 = 1_785_000_000_000;
const DAY = 86_400_000;

const draft = (over: Partial<Parameters<typeof enqueue>[0]> = {}) => ({
  kind: "test",
  title: "Something happened",
  body: "detail",
  dedupeKey: "evt:1",
  ...over,
});

describe("the outbox refuses to duplicate", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("enqueuing the same event twice is one message", () => {
    enqueue(draft());
    enqueue(draft());
    /* The key is derived from the EVENT, so a retry, a replay after restart, or
       two code paths noticing the same fact all collapse to one. */
    assert.equal(pending().length, 1);
  });

  test("different events are different messages", () => {
    enqueue(draft({ dedupeKey: "evt:1" }));
    enqueue(draft({ dedupeKey: "evt:2" }));
    assert.equal(pending().length, 2);
  });

  test("a delivered message is never handed out again", async () => {
    enqueue(draft());
    let calls = 0;
    const ok = async () => {
      calls++;
      return { ok: true };
    };

    await drainOnce(ok);
    await drainOnce(ok);
    await drainOnce(ok);

    /* Three drains, one send. Without this a restart loop would alert the owner
       once per boot for every historical event. */
    assert.equal(calls, 1);
    assert.equal(pending().length, 0);
  });
});

describe("the outbox refuses to lose a message", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a failed delivery stays owed and is retried", async () => {
    enqueue(draft());
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      return attempts < 3 ? { ok: false, error: "network" } : { ok: true };
    };

    await drainOnce(flaky);
    assert.equal(pending().length, 1, "still owed after a failure");
    await drainOnce(flaky);
    assert.equal(pending().length, 1);
    await drainOnce(flaky);

    assert.equal(pending().length, 0, "delivered on the third try");
    assert.equal(attempts, 3);
  });

  test("a channel that throws does not strand the queue", async () => {
    enqueue(draft({ dedupeKey: "a" }));
    enqueue(draft({ dedupeKey: "b" }));
    let seen = 0;
    const throwsOnce = async () => {
      seen++;
      if (seen === 1) throw new Error("boom");
      return { ok: true };
    };

    const res = await drainOnce(throwsOnce);
    /* The first message threw; the second must still have been attempted, or
       one bad payload would block every later alert indefinitely. */
    assert.equal(seen, 2);
    assert.equal(res.sent, 1);
    assert.equal(pending().length, 1);
  });

  test("a permanent failure is abandoned visibly, not silently", async () => {
    enqueue(draft());
    const unconfigured = async () => ({ ok: false, error: "not configured", permanent: true });

    await drainOnce(unconfigured);

    /* Permanent means retrying cannot help, so the attempts burn at once
       rather than hammering an unreachable channel for hours. But the row
       survives as abandoned — a message the app gave up on is exactly what the
       owner cannot learn about any other way. */
    assert.equal(pending().length, 0);
    assert.equal(abandoned().length, 1);
    assert.equal(outboxStats().abandoned, 1);
  });

  test("a message held for later is not delivered early", async () => {
    enqueue(draft({ deliverAfter: T0 + 60_000 }));
    let calls = 0;
    const ok = async () => {
      calls++;
      return { ok: true };
    };

    await drainOnce(ok, T0);
    assert.equal(calls, 0, "not due yet");
    await drainOnce(ok, T0 + 61_000);
    assert.equal(calls, 1);
  });
});

describe("the message commits with the thing it describes", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  function planInput(sessionId: number): PlanInput {
    return {
      sessionId,
      slug: "range-break",
      pair: PAIR,
      thesis: "Reclaiming 100 opens the gap to 130.",
      assumptions: [{ text: "The shelf is real." }],
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
    };
  }

  test("a plan transition and its notification land together", () => {
    const s = createTestSession(PAIR);
    const created = createPlan(planInput(s.id));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(armPlan(created.plan.rowId).ok, true);

    transitionPlan(created.plan.rowId, "invalidated", "price closed below 80", {
      kind: "plan_invalidated",
      title: "BTC-USD — thesis invalidated",
      body: "closed below 80",
      dedupeKey: `plan:${created.plan.rowId}:invalidated`,
    });

    assert.equal(getPlan(created.plan.rowId)!.state, "invalidated");
    assert.equal(pending().length, 1, "the message is owed the moment the state changed");
  });

  test("a rolled-back transaction leaves no orphan message", () => {
    /* The inverse guarantee, and the reason the enqueue takes a db handle
       rather than opening its own transaction: a message must never describe
       something that did not happen. */
    assert.throws(() =>
      withTransaction((db) => {
        enqueueWithin(db, draft({ dedupeKey: "never-happened" }));
        throw new Error("state change failed");
      })
    );
    assert.equal(pending().length, 0);
  });
});

describe("outbox bookkeeping", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("stats separate owed, delivered and given-up", () => {
    enqueue(draft({ dedupeKey: "a" }));
    enqueue(draft({ dedupeKey: "b" }));
    enqueue(draft({ dedupeKey: "c" }));

    const rows = pending();
    markDelivered(rows[0]!.id);
    for (let i = 0; i < MAX_ATTEMPTS; i++) markFailed(rows[1]!.id, "nope");

    const stats = outboxStats();
    assert.equal(stats.delivered, 1);
    assert.equal(stats.abandoned, 1);
    assert.equal(stats.pending, 1);
  });

  test("older messages are delivered first", async () => {
    enqueue(draft({ dedupeKey: "first", title: "entered" }));
    enqueue(draft({ dedupeKey: "second", title: "target hit" }));

    const order: string[] = [];
    await drainOnce(async (title) => {
      order.push(title);
      return { ok: true };
    });

    /* "target hit" before "entered" would make the owner reconstruct the
       sequence themselves. */
    assert.deepEqual(order, ["entered", "target hit"]);
  });
});
