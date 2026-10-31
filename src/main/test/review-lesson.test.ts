import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb, createTestSession, createTestStrategy } from "./test-helper";
import { buildSessionContext } from "../agent/context";
import { getDb } from "../db/database";
import { replaceLessonsForPair } from "../db/shared-store";

describe("Review & Lesson Loop Suite (Stage A Complete Paper Loop)", () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    cleanupTestDb();
  });

  test("Journal stores trade_review and lesson entries, and buildSessionContext injects them", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    const db = getDb();
    const now = Date.now();

    // Insert trade_review
    db.prepare(
      `INSERT INTO journal (session_id, kind, content, tags, created_at)
       VALUES (?, 'trade_review', '[BTC-USD] btc-rsi — stop_loss, PnL -50.00 USD (-5.00%), held 30m\n\nWHAT HAPPENED: Price dropped past stop.\nPROCESS: Followed spec.\nWATCH: Check high volatility.', 'paper,stop_loss,loss,btc-rsi', ?)`
    ).run(session.id, now - 3600000);

    /* Lessons moved OUT of the journal and into the store both app modes open,
       keyed by pair rather than session — a lesson about how a market behaves
       does not stop being true because a session was archived, and it has to
       survive the move from simulated to live. */
    replaceLessonsForPair(
      "BTC-USD",
      [
        {
          text: "Exits on this strategy fire while the move is still extending, seen in 4 of 6 winners.",
          regime: "trending_up",
        },
      ],
      "simulated",
      { trades: 6, from: now - 86_400_000, to: now },
      now
    );

    // Verify DB entries
    const journalEntries = db.prepare("SELECT * FROM journal WHERE session_id = ?").all(session.id) as any[];
    assert.equal(journalEntries.length, 1, "the review stays in the journal; the lesson does not");

    // Verify context injection
    const context = buildSessionContext(session.id);
    /* The lesson still reaches the prompt — that is the point of the store. */
    assert.ok(
      context.includes("Exits on this strategy fire while the move is still extending"),
      "the lesson reaches the prompt"
    );
    /* But this session has no cached candles, so the current regime is
       `unknown` and a lesson tagged `trending_up` must NOT be presented as
       applying. Claiming a conditions match we cannot measure is exactly the
       overconfidence the regime split exists to remove — so it is shown under
       the "different conditions" heading, labelled with where it came from. */
    assert.ok(
      context.includes("DIFFERENT conditions"),
      "an unmatched lesson is labelled, not presented as applicable"
    );
    assert.ok(context.includes("[learned in trending_up]"), "and says which conditions it came from");
    assert.ok(context.includes("from 6 closed trades"), "and what it rests on");
    assert.ok(context.includes("### Recent journal entries"), "Context should include Recent Journal section");
    assert.ok(context.includes("trade_review"), "Context should include trade_review entry");
  });
});
