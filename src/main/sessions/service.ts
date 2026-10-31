import { getDb, auditLog } from "../db/database";
import * as crypto from "crypto";
import type { Session } from "../../shared/ipc-types";
import { AppError } from "../../shared/errors";
import { createLogger } from "../logger";

const log = createLogger("sessions");

// Shape lives in the shared IPC contract so main and renderer cannot drift.
export type { Session };

/**
 * Session service (plan §4): one session per trading pair, isolated context.
 * Statuses: active | paused | archived. Uniqueness applies only to live
 * sessions (v2) — archived pairs can be recreated fresh.
 */


const PAIR_RE = /^[A-Z0-9]+-[A-Z0-9]+$/;

export function listSessions(includeArchived = false): Session[] {
  const sql = includeArchived
    ? "SELECT id, uuid, pair, status, created_at, updated_at FROM sessions ORDER BY created_at ASC"
    : "SELECT id, uuid, pair, status, created_at, updated_at FROM sessions WHERE status != 'archived' ORDER BY created_at ASC";
  return getDb().prepare(sql).all() as unknown as Session[];
}

export function createSession(pair: string): Session {
  if (!PAIR_RE.test(pair)) throw new Error("Invalid pair format (expected e.g. BTC-USD)");
  const now = Date.now();
  const uuid = crypto.randomUUID();
  try {
    getDb()
      .prepare(
        `INSERT INTO sessions (uuid, pair, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`
      )
      .run(uuid, pair, now, now);
  } catch (e: any) {
    if (e.message && e.message.includes("UNIQUE constraint failed")) {
      throw new Error(`An active or paused session for ${pair} already exists.`);
    }
    throw e;
  }
  const session = getDb()
    .prepare("SELECT id, uuid, pair, status, created_at, updated_at FROM sessions WHERE uuid = ?")
    .get(uuid) as unknown as Session;
  auditLog("session_created", { pair, id: session.id, uuid: session.uuid });
  return session;
}

/* `updatePaperBalance` was removed with schema v20 — cash is an account fact,
   and `paper/account.ts` owns it. */

/**
 * Change a session's lifecycle status.
 *
 * The three statuses mean different things to the engines, and the edge cases
 * are where this gets dangerous:
 *
 *   • **paused** — "stop opening new positions". An open position keeps being
 *     managed (see `paper-exchange.reloadStrategies`), because a stop-loss that
 *     silently stops being watched is worse than no stop-loss: you believe you
 *     are protected and you are not.
 *   • **archived** — terminal, and REFUSED while any position is open. An
 *     archived session's strategies never load, so an open position would be
 *     stranded forever: never stopped out, never taken profit, and permanently
 *     unrealised in every aggregate that sums realised PnL.
 *   • **restoring** (archived → active/paused) — refused if the pair already
 *     has a live session, because `idx_sessions_live_pair` is a partial unique
 *     index over `status != 'archived'`. Without this check SQLite raises a raw
 *     UNIQUE error that means nothing to the person reading it.
 */
export function setSessionStatus(id: number, status: "active" | "paused" | "archived"): Session {
  if (!["active", "paused", "archived"].includes(status)) {
    throw new AppError("VALIDATION", "That isn't a valid session status.");
  }

  const db = getDb();
  const session = db
    .prepare("SELECT id, uuid, pair, status, created_at, updated_at FROM sessions WHERE id = ?")
    .get(id) as unknown as Session | undefined;
  if (!session) throw new AppError("NOT_FOUND", "That session no longer exists.");

  // Idempotent: re-archiving an archived session is a no-op, not an error.
  if (session.status === status) return session;

  if (status === "archived") {
    const open = db
      .prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE session_id = ? AND status = 'open'")
      .get(id) as { n: number } | undefined;
    if (open && open.n > 0) {
      throw new AppError(
        "VALIDATION",
        `This session is holding ${open.n} open paper ${open.n === 1 ? "position" : "positions"}, so it can't be archived yet.`,
        { hint: "Pause it instead — pausing stops new trades but keeps managing stops and targets." }
      );
    }
  }

  if (session.status === "archived") {
    const live = db
      .prepare("SELECT id FROM sessions WHERE pair = ? AND status != 'archived' AND id != ?")
      .get(session.pair, id) as { id: number } | undefined;
    if (live) {
      throw new AppError(
        "VALIDATION",
        `There's already a live session for ${session.pair}, so this archived one can't be restored.`,
        { hint: "Archive the current one first, or keep this as history." }
      );
    }
  }

  db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
  auditLog("session_status_changed", { id, pair: session.pair, from: session.status, to: status });

  if (status === "archived" && getSelectedSessionId() === id) selectSession(null);

  /* The engine caches which strategies are live. Without this, a paused or
     archived session keeps trading until the next app restart — and a restored
     one stays dormant despite looking active in the UI. */
  try {
    const { paperEngine } = require("../paper/paper-exchange");
    paperEngine.reloadStrategies();
  } catch (err) {
    log.warn("Could not reload paper engine after session status change", err);
  }

  return db
    .prepare("SELECT id, uuid, pair, status, created_at, updated_at FROM sessions WHERE id = ?")
    .get(id) as unknown as Session;
}

/** Open paper positions for a session — the gate on archiving. */
export function openPositionCount(sessionId: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE session_id = ? AND status = 'open'")
    .get(sessionId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/* ── Selected session — main process is the source of truth ─────────
   The bot runtime (strategy engine, agent) reads selection from here,
   never from renderer state. Persisted in settings, survives restart. */

const SELECTED_KEY = "selected_session_id";

export function getSelectedSessionId(): number | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(SELECTED_KEY) as
    | { value: string }
    | undefined;
  if (!row || row.value === "") return null;
  const id = parseInt(row.value, 10);
  return Number.isNaN(id) ? null : id;
}

/** Returns the selected session, auto-clearing stale/archived selections. */
export function getSelectedSession(): Session | null {
  const id = getSelectedSessionId();
  if (!id) return null;
  const session = getDb()
    .prepare("SELECT id, uuid, pair, status, created_at, updated_at FROM sessions WHERE id = ?")
    .get(id) as unknown as Session | undefined;
  if (!session) {
    // Failsafe: selected session was deleted out from under us
    selectSession(null);
    return null;
  }
  return session;
}

/**
 * Fetch a session by id regardless of status (archived included).
 *
 * **`paper_balance` is deliberately NOT selected any more** — cash moved to one
 * account in schema v20. The previous note here said the opposite, and for good
 * reason at the time: omitting it made `session.paper_balance` `undefined` at
 * runtime while TypeScript believed it was a string, so every entry was sized
 * off the starting balance and every close rewrote cash to the sale proceeds.
 *
 * The fix then was to select it. The fix now is that a session has no cash at
 * all: it is a workspace for one pair's plans and history. The column remains
 * in the table as history and **nothing maintains it**, so selecting it would
 * hand callers a frozen 10,000 — the same silent-wrong-number failure, arrived
 * at from the other direction. Keeping it off the type is what makes that
 * unwriteable.
 */
export function getSessionById(id: number): Session | null {
  return (getDb()
    .prepare("SELECT id, uuid, pair, status, created_at, updated_at FROM sessions WHERE id = ?")
    .get(id) as unknown as Session | undefined) ?? null;
}

/** Select a session (null = free view). Validates existence and status. */
export function selectSession(id: number | null): Session | null {
  if (id !== null) {
    const session = getDb()
      .prepare("SELECT id, uuid, pair, status, created_at, updated_at FROM sessions WHERE id = ?")
      .get(id) as unknown as Session | undefined;
    if (!session) throw new AppError("NOT_FOUND", "That session no longer exists.");
    /* Archived sessions ARE selectable — otherwise archiving is a black hole
       and the journal you kept becomes unreachable. They're read-only by
       construction instead: the paper engine skips non-active sessions, and
       `setStrategyState` refuses to arm a strategy on one. */
  }
  getDb()
    .prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(SELECTED_KEY, id === null ? "" : String(id));
  auditLog("session_selected", { id });
  return id === null ? null : getSelectedSession();
}
