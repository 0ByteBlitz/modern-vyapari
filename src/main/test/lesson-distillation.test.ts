import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession } from "./test-helper";
import { getDb } from "../db/database";
import { getLessonDistillationCursor, getLessonsForPair } from "../db/shared-store";
import { setAiProviderForTesting } from "../ai/registry";
import type { AiProvider } from "../ai/port";
import { distillLessons, distillPendingLessons, setReviewModel } from "../agent/review";

const PAIR = "BTC-USD";

function insertReview(sessionId: number, tag: string, content: string): number {
  const result = getDb()
    .prepare(`INSERT INTO journal (session_id, kind, content, tags, created_at)
              VALUES (?, 'trade_review', ?, ?, ?)`)
    .run(sessionId, content, tag, Date.now());
  return Number(result.lastInsertRowid);
}

describe("lesson distillation", () => {
  let prompt = "";
  let calls = 0;
  let citedIds: number[] = [];
  let lessonText = "Repeated adverse wicks precede stop exits.";

  beforeEach(() => {
    setupTestDb();
    prompt = "";
    calls = 0;
    citedIds = [];
    lessonText = "Repeated adverse wicks precede stop exits.";
    setReviewModel("test-model");
    setAiProviderForTesting({
      info: {
        id: "test",
        displayName: "Test",
        capabilities: { serverWebSearch: false, promptCaching: false, vision: false, toolCalling: "none" },
      },
      isConfigured: () => true,
      listModels: async () => [],
      complete: async (req) => {
        prompt = req.prompt;
        calls++;
        return {
          textParts: [JSON.stringify([
            { text: lessonText, regime: "unknown", evidence_review_ids: citedIds },
          ])],
          usage: null as never,
        };
      },
      createConversation: () => ({ providerId: "test" }),
      step: async () => ({ toolCalls: [], usage: {} }),
      addToolResults: () => undefined,
      rejectedWebSearch: () => false,
      unsupportedTools: () => [],
    } satisfies AiProvider);
  });

  afterEach(() => {
    setAiProviderForTesting(null);
    cleanupTestDb();
  });

  test("counts only closed-trade reviews across sessions and stores cited evidence", async () => {
    const first = createTestSession(PAIR, "archived");
    const second = createTestSession(PAIR);
    const firstReview = insertReview(first.id, "paper,plan,loss", "Trade review one: adverse wick before stop.");
    insertReview(first.id, "plan,expired,no-trade", "No-trade plan resolution must not count.");
    const secondReview = insertReview(second.id, "paper,strategy,loss", "Trade review two: adverse wick before stop.");
    insertReview(second.id, "plan,invalidated,no-trade", "Another no-trade resolution must not count.");

    await distillLessons(first.id);
    assert.equal(calls, 0, "plan resolution notes cannot satisfy the trade-review threshold");

    const thirdReview = insertReview(second.id, "paper,plan,win", "Trade review three: adverse wick before stop.");
    citedIds = [firstReview, secondReview];
    await distillPendingLessons();

    assert.equal(calls, 1, "reviews in another session of the same pair trigger a pass");
    const evidence = JSON.parse(prompt) as { recent_reviews: Array<{ review_id: number; review: string }> };
    assert.deepEqual(evidence.recent_reviews.map((r) => r.review_id).sort(), [firstReview, secondReview, thirdReview].sort());
    assert.ok(evidence.recent_reviews.every((r) => !r.review.includes("No-trade")));

    const lesson = getLessonsForPair(PAIR)[0]!;
    assert.equal(lesson.evidence_trades, 2, "support count comes from cited review IDs");
    assert.deepEqual(JSON.parse(lesson.evidence_review_ids), citedIds);

    await distillPendingLessons();
    assert.equal(calls, 1, "a startup/retry pass does not re-distill the same evidence");
  });

  test("waits for a batch of new reviews before paying for another pass", async () => {
    const session = createTestSession(PAIR);
    const seeded = [1, 2, 3].map((n) => insertReview(session.id, "paper,plan,win", `Initial trade review ${n}.`));
    citedIds = seeded.slice(0, 2);
    await distillLessons(session.id);
    assert.equal(calls, 1);

    for (let n = 1; n <= 4; n++) insertReview(session.id, "paper,plan,win", `New trade review ${n}.`);
    await distillPendingLessons();
    assert.equal(calls, 1, "four new reviews do not trigger an early duplicate call");

    insertReview(session.id, "paper,plan,win", "New trade review five.");
    citedIds = [seeded[1]!, seeded[2]!];
    await distillPendingLessons();
    assert.equal(calls, 2, "the fifth new review starts the next pass");
  });

  test("rejects unsupported frequency claims without advancing the cursor", async () => {
    const session = createTestSession(PAIR);
    const ids = [1, 2, 3].map((n) => insertReview(session.id, "paper,plan,win", `Trade review ${n}.`));
    citedIds = ids.slice(0, 2);
    lessonText = "Stops were hit in 4 of 6 trades.";

    await distillLessons(session.id);

    assert.equal(getLessonsForPair(PAIR).length, 0, "unsupported model-authored counts are not stored");
    assert.equal(getLessonDistillationCursor(PAIR, "simulated"), null, "rejected output remains eligible for a later retry");
  });
});
