/**
 * The notification outbox — write the intent to tell the owner in the SAME
 * transaction as the thing you are telling them about.
 *
 * **Why a table and not a `fetch` at the call site.** Two failures are certain
 * otherwise, and both destroy trust in the whole away-flow:
 *
 *  - **Traded but never told.** The plan transitions, the process dies (or the
 *    network is down, or Telegram 500s) before the send, and the owner learns
 *    about it hours later by opening the app. Nothing records that a message was
 *    owed.
 *  - **Told twice.** The send succeeds, the write that marks it sent fails, and
 *    a retry fires the same alert again. An owner who is woken twice for one
 *    trigger stops trusting the channel, which is worse than no channel.
 *
 * The outbox pattern fixes both by making the *intent* durable and the delivery
 * idempotent. It is standard in payments for exactly this reason.
 *
 * **`dedupe_key` is the whole guarantee.** It is UNIQUE, and it is derived from
 * the event rather than the clock — `plan:12:triggered:breakout`, not
 * `now()`. Enqueuing the same event twice is a no-op, so a retry loop, a replay
 * on restart, or two code paths noticing the same fact can never double-send.
 *
 * Delivery itself lives in `channels.ts`; this file only knows that something
 * is owed and whether it has been paid.
 */
import { getDb } from "../db/database";
import { createLogger } from "../logger";

const log = createLogger("outbox");

/** How many times a message is retried before it is left alone. */
export const MAX_ATTEMPTS = 5;

export interface NotificationDraft {
  /** Event class, for filtering and for the diagnostics pane. */
  kind: string;
  /** One line. This is what arrives on the phone first. */
  title: string;
  /** The detail. Plain text — channels format it themselves. */
  body: string;
  /**
   * Derived from the EVENT, never from the clock. Two enqueues with the same
   * key are one message.
   */
  dedupeKey: string;
  /** Optional: hold the message until this time (ms epoch). */
  deliverAfter?: number;
}

export interface PendingNotification extends NotificationDraft {
  id: number;
  attempts: number;
}

type DbHandle = ReturnType<typeof getDb>;

/**
 * Enqueue **inside a transaction the caller already owns.**
 *
 * This is the outbox half that matters: the caller passes the same `db` handle
 * it is using for the state change, so the message and the fact it describes
 * commit or roll back together. `withTransaction` is deliberately not reentrant
 * (SQLite has no nested transactions), which is why this takes a handle rather
 * than opening one.
 */
export function enqueueWithin(db: DbHandle, n: NotificationDraft): void {
  db.prepare(
    `INSERT INTO notifications (kind, title, body, dedupe_key, deliver_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`
  ).run(n.kind, n.title, n.body, n.dedupeKey, n.deliverAfter ?? 0, Date.now());
}

/** Enqueue on its own. Use only when there is no state change to bind to. */
export function enqueue(n: NotificationDraft): void {
  enqueueWithin(getDb(), n);
}

/**
 * Messages that are owed: not yet delivered, due now, still worth trying.
 *
 * Ordered oldest first so a backlog is told in the order it happened — an owner
 * reading "target hit" before "entered" would have to reconstruct the sequence
 * themselves.
 */
export function pending(now: number = Date.now(), limit = 20): PendingNotification[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, title, body, dedupe_key, deliver_after, attempts
         FROM notifications
        WHERE delivered_at IS NULL AND attempts < ? AND deliver_after <= ?
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .all(MAX_ATTEMPTS, now, limit) as unknown as Array<{
    id: number;
    kind: string;
    title: string;
    body: string;
    dedupe_key: string;
    deliver_after: number;
    attempts: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    dedupeKey: r.dedupe_key,
    deliverAfter: r.deliver_after,
    attempts: r.attempts,
  }));
}

/**
 * Mark delivered.
 *
 * Recorded *after* the channel confirms. The residual risk is the classic
 * at-least-once window — delivered, then the process dies before this write, so
 * the message is sent again on restart. That is the correct trade for an alert:
 * a duplicate is annoying, a silent miss can cost money. `dedupe_key` bounds the
 * damage to one repeat rather than a loop.
 */
export function markDelivered(id: number, now: number = Date.now()): void {
  getDb().prepare(`UPDATE notifications SET delivered_at = ?, last_error = NULL WHERE id = ?`).run(now, id);
}

/** Record a failed attempt. The row stays pending until `MAX_ATTEMPTS`. */
export function markFailed(id: number, error: string): void {
  getDb()
    .prepare(`UPDATE notifications SET attempts = attempts + 1, last_error = ? WHERE id = ?`)
    .run(error.slice(0, 500), id);
}

/**
 * Messages that ran out of attempts.
 *
 * Surfaced rather than swallowed: a notification the app gave up on is exactly
 * the thing the owner must be able to discover, because by definition they were
 * not told about it any other way.
 */
export function abandoned(limit = 20): PendingNotification[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, title, body, dedupe_key, deliver_after, attempts
         FROM notifications
        WHERE delivered_at IS NULL AND attempts >= ?
        ORDER BY created_at DESC LIMIT ?`
    )
    .all(MAX_ATTEMPTS, limit) as unknown as Array<{
    id: number;
    kind: string;
    title: string;
    body: string;
    dedupe_key: string;
    deliver_after: number;
    attempts: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    dedupeKey: r.dedupe_key,
    deliverAfter: r.deliver_after,
    attempts: r.attempts,
  }));
}

export function outboxStats(): { pending: number; delivered: number; abandoned: number } {
  const db = getDb();
  const one = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(...(args as never[])) as { n: number }).n;
  return {
    pending: one(
      `SELECT COUNT(*) AS n FROM notifications WHERE delivered_at IS NULL AND attempts < ?`,
      MAX_ATTEMPTS
    ),
    delivered: one(`SELECT COUNT(*) AS n FROM notifications WHERE delivered_at IS NOT NULL`),
    abandoned: one(
      `SELECT COUNT(*) AS n FROM notifications WHERE delivered_at IS NULL AND attempts >= ?`,
      MAX_ATTEMPTS
    ),
  };
}

export { log as outboxLog };
