/**
 * The one thing both modes open (owner decision, 2026-08-05).
 *
 * **Lessons cross modes; the calibration record does not.** What the owner
 * learned about how a range reclaim behaves is market knowledge and transfers
 * — starting live mode with an empty memory would throw away every lesson
 * simulation taught. A *hit rate* is different: simulated fills are optimistic
 * by construction, so blending them with real ones flatters the owner with
 * nothing anywhere that would notice. Sessions, plans, positions and the
 * calibration record therefore stay inside their own mode's database file, and
 * only this store is shared.
 *
 * ## Keyed by pair, not by session
 *
 * A lesson used to be a `journal` row keyed by `session_id`, and session ids
 * are meaningless across database files — id 3 is a different session in each
 * mode. Since a lesson is knowledge about a *market* rather than about a
 * session, the pair is the honest key, and it happens to be the one thing both
 * modes agree on.
 *
 * ## The second thing that crosses: what the agent cost
 *
 * The rule for this file was "lessons only — a second concept probably belongs
 * in the mode database". API spend is the exception, and it earns it: **the
 * Anthropic bill is one bill.** It is not a fact about simulated or live
 * trading, it is a fact about the account, and splitting it by mode meant the
 * spend readout under-reported by whatever the other mode had cost — a number
 * that looks like "what I have spent" and is really "what I spent in this
 * world". Same defect as the portfolio total counting sessions.
 *
 * Note what does NOT come with it: `session_id`. Session ids are mode-local, so
 * one here would point at a different session in each file. The `mode` column
 * replaces it — enough to attribute a cost, meaningless to misread.
 *
 * ## Still deliberately tiny
 *
 * Two tables, no migrations framework, no FTS. The test for a third is the one
 * spend passes: is this a fact about the *account* rather than about a world?
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as path from "path";
import { SHARED_STORE_FILE } from "../modes/app-mode";
import { createLogger } from "../logger";

const log = createLogger("shared");

let shared: DatabaseSync | null = null;

const SHARED_SQL = `
CREATE TABLE IF NOT EXISTS lessons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The key. Sessions are per-mode; a market is not.
  pair       TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '',
  -- Which mode distilled it. Recorded, never filtered on by default: the whole
  -- point is that both modes read the same set. It is here so a lesson learned
  -- from optimistic simulated fills can be identified if that ever matters.
  origin     TEXT NOT NULL DEFAULT 'simulated',
  -- The conditions this lesson was learned under, measured (never guessed) by
  -- insights/regime.ts from the trades it rests on. 'mixed' means the evidence
  -- spanned several regimes, which makes it the most transferable kind.
  -- Retrieval prefers lessons whose regime matches the market now: a lesson
  -- without its conditions is either overgeneralised or wrong.
  regime     TEXT NOT NULL DEFAULT 'unknown',
  -- What it rests on, so a reader can weigh it. Recorded because "seen in 4 of
  -- 6 winners" in the text is the model's own claim and nothing checks it.
  evidence_trades INTEGER NOT NULL DEFAULT 0,
  evidence_from   INTEGER,
  evidence_to     INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_pair ON lessons(pair, created_at DESC);

-- One Anthropic bill, not one per mode. No session_id: session ids are
-- mode-local and would point at a different session in each database file.
CREATE TABLE IF NOT EXISTS api_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mode        TEXT NOT NULL DEFAULT 'simulated',
  model       TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  -- NULL when the model has no published price. Zero would read as free.
  cost_usd    TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_usage_time ON api_usage(created_at DESC);
`;

export function initSharedStore(userDataPath: string): void {
  const dataDir = path.join(userDataPath, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  shared = new DatabaseSync(path.join(dataDir, SHARED_STORE_FILE));
  shared.exec("PRAGMA journal_mode = WAL;");
  shared.exec(SHARED_SQL);
  log.info("Shared lesson store ready.");
}

export function getSharedStore(): DatabaseSync {
  if (!shared) throw new Error("Shared store not initialized");
  return shared;
}

export interface SharedLesson {
  content: string;
  tags: string;
  origin: string;
  /** Measured from the evidence, not asserted by the model. */
  regime: string;
  evidence_trades: number;
  evidence_from: number | null;
  evidence_to: number | null;
  created_at: number;
}

/** One distilled lesson plus the conditions it was learned under. */
export interface LessonDraft {
  text: string;
  regime: string;
}

export function getLessonsForPair(pair: string, limit = 5): SharedLesson[] {
  return getSharedStore()
    .prepare(
      `SELECT content, tags, origin, regime, evidence_trades, evidence_from, evidence_to, created_at
       FROM lessons WHERE pair = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(pair, limit) as unknown as SharedLesson[];
}

/**
 * Replace the lesson set for one pair.
 *
 * Replace rather than append, because distillation produces the *whole* set
 * each time — it merges duplicates and drops what newer evidence contradicts,
 * so appending would resurrect lessons the model just decided were wrong.
 */
export function replaceLessonsForPair(
  pair: string,
  lessons: Array<LessonDraft | string>,
  origin: string,
  evidence: { trades: number; from: number | null; to: number | null } = { trades: 0, from: null, to: null },
  now = Date.now()
): void {
  const db = getSharedStore();
  db.exec("BEGIN TRANSACTION;");
  try {
    db.prepare(`DELETE FROM lessons WHERE pair = ?`).run(pair);
    const insert = db.prepare(
      `INSERT INTO lessons (pair, content, tags, origin, regime, evidence_trades, evidence_from, evidence_to, created_at)
       VALUES (?, ?, 'distilled', ?, ?, ?, ?, ?, ?)`
    );
    for (const entry of lessons) {
      const draft: LessonDraft = typeof entry === "string" ? { text: entry, regime: "unknown" } : entry;
      const trimmed = draft.text.trim();
      if (!trimmed) continue;
      insert.run(
        pair,
        trimmed,
        origin,
        draft.regime || "unknown",
        evidence.trades,
        evidence.from,
        evidence.to,
        now
      );
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

/**
 * Move any pre-existing per-session lessons into the shared store, once.
 *
 * Without this, introducing the shared store would silently empty the agent's
 * memory on the next launch — the lessons would still be in the journal, and
 * nothing would read them. Idempotent by construction: it only fills pairs the
 * shared store has nothing for, so re-running cannot resurrect a lesson that
 * later distillation deliberately dropped.
 */
export function adoptLegacyLessons(modeDb: DatabaseSync, origin: string): number {
  let adopted = 0;
  try {
    const rows = modeDb
      .prepare(
        `SELECT s.pair AS pair, j.content AS content, j.created_at AS created_at
         FROM journal j JOIN sessions s ON s.id = j.session_id
         WHERE j.kind = 'lesson' ORDER BY j.created_at ASC`
      )
      .all() as unknown as Array<{ pair: string; content: string; created_at: number }>;

    const store = getSharedStore();
    const has = store.prepare(`SELECT 1 FROM lessons WHERE pair = ? LIMIT 1`);
    /* Adopted lessons carry regime 'unknown' honestly: they predate the
       measurement, and stamping a guess onto them would be worse than saying
       the conditions are not known. The next distillation replaces them. */
    const insert = store.prepare(
      `INSERT INTO lessons (pair, content, tags, origin, regime, created_at)
       VALUES (?, ?, 'distilled,adopted', ?, 'unknown', ?)`
    );
    for (const r of rows) {
      if (has.get(r.pair)) continue;
      insert.run(r.pair, r.content, origin, r.created_at);
      adopted++;
    }
  } catch (err) {
    /* A failed adoption must never stop the app from starting — the lessons
       are still in the journal and can be adopted on a later launch. */
    log.error("Could not adopt legacy lessons", err);
  }
  if (adopted > 0) log.info(`Adopted ${adopted} pre-existing lesson(s) into the shared store.`);
  return adopted;
}

/**
 * Move any per-mode API usage into the shared store, once.
 *
 * Same reasoning as the lesson adoption: introducing the shared table without
 * this would silently reset the spend total to zero, which for a cost figure
 * is the flattering direction.
 */
export function adoptLegacyUsage(modeDb: DatabaseSync, mode: string): number {
  let moved = 0;
  try {
    const rows = modeDb
      .prepare(
        `SELECT model, purpose, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, cost_usd, created_at FROM api_usage`
      )
      .all() as unknown as Array<Record<string, unknown>>;
    if (rows.length === 0) return 0;

    const store = getSharedStore();
    const insert = store.prepare(
      `INSERT INTO api_usage (mode, model, purpose, input_tokens, output_tokens,
                              cache_read_tokens, cache_write_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    /* Guarded by timestamp so a second launch cannot double-count a bill. */
    const seen = store.prepare(`SELECT 1 FROM api_usage WHERE created_at = ? AND model = ? LIMIT 1`);
    for (const r of rows) {
      if (seen.get(r.created_at as number, r.model as string)) continue;
      insert.run(
        mode,
        r.model as string,
        r.purpose as string,
        r.input_tokens as number,
        r.output_tokens as number,
        r.cache_read_tokens as number,
        r.cache_write_tokens as number,
        (r.cost_usd as string | null) ?? null,
        r.created_at as number
      );
      moved++;
    }
  } catch {
    /* No api_usage table on an older file — nothing to adopt. */
  }
  if (moved > 0) log.info(`Adopted ${moved} API usage row(s) into the shared store.`);
  return moved;
}

/** Test seam: an in-memory store, so tests never touch the real file. */
export function __setSharedStoreForTests(db: DatabaseSync | null): void {
  shared = db;
  if (db) db.exec(SHARED_SQL);
}