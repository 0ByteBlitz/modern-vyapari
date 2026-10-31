/**
 * Drains the outbox.
 *
 * Deliberately dumb: it takes what is owed, tries to deliver it, and records
 * what happened. All the correctness lives in the outbox table's shape — the
 * unique `dedupe_key` and the "written in the same transaction" rule — not
 * here, so a bug in this file can delay a message but cannot lose or duplicate
 * one.
 *
 * **Sequential on purpose.** Messages are delivered oldest first, one at a
 * time. Parallel delivery would let "target hit" arrive before "entered", and
 * an owner reading their phone would have to reconstruct the order themselves.
 *
 * **Runs on boot as well as on a timer**, because the app is shut most of the
 * time and the interesting notifications are exactly the ones that were owed
 * while it was closed. That is the catch-up rule from `docs/RUNTIME.md`.
 */
import { pending, markDelivered, markFailed, MAX_ATTEMPTS, type PendingNotification } from "./outbox";
import { sendTelegram, telegramConfigured } from "./telegram";
import { auditLog } from "../db/database";
import { createLogger } from "../logger";

const log = createLogger("notify");

/** How often the outbox is drained. */
export const DRAIN_INTERVAL_MS = 30_000;

export type Deliverer = (title: string, body: string) => Promise<{ ok: boolean; error?: string; permanent?: boolean }>;

/**
 * Deliver everything currently owed.
 *
 * Injectable deliverer so tests can exercise failure, retry and the
 * no-duplicate-send guarantee without a network. Returns counts for the
 * diagnostics pane.
 */
export async function drainOnce(
  deliver: Deliverer = sendTelegram,
  now: number = Date.now()
): Promise<{ sent: number; failed: number; skipped: number }> {
  const owed = pending(now);
  if (owed.length === 0) return { sent: 0, failed: 0, skipped: 0 };

  let sent = 0;
  let failed = 0;

  for (const n of owed) {
    let res;
    try {
      res = await deliver(n.title, n.body);
    } catch (e) {
      /* A throwing channel must not stop the drain — the next message may be
         deliverable, and an exception here would strand the whole queue. */
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (res.ok) {
      markDelivered(n.id, now);
      sent++;
      continue;
    }

    failed++;
    /* A permanent failure burns the remaining attempts at once rather than
       retrying an unconfigured or misaddressed channel every 30 seconds for
       hours. The row is still visible as abandoned. */
    const burn = res.permanent ? MAX_ATTEMPTS - n.attempts : 1;
    for (let i = 0; i < burn; i++) markFailed(n.id, res.error ?? "unknown");

    if (n.attempts + burn >= MAX_ATTEMPTS) {
      /* Audited, because a notification the app gave up on is precisely the
         thing the owner cannot learn about any other way. */
      auditLog("notification_abandoned", { kind: n.kind, title: n.title, error: res.error });
      log.warn(`Gave up delivering "${n.title}": ${res.error}`);
    }
  }

  return { sent, failed, skipped: 0 };
}

let timer: NodeJS.Timeout | null = null;

/** Start draining. Returns a stop function. */
export function startNotificationWorker(intervalMs = DRAIN_INTERVAL_MS): () => void {
  const tick = () => {
    /* Nothing configured means nothing to do — but messages keep accumulating
       in the outbox, so turning Telegram on later delivers the backlog rather
       than starting from empty. That is the point of persisting the intent. */
    if (!telegramConfigured()) return;
    void drainOnce().catch((e) => log.warn("Drain failed.", e));
  };

  tick();
  timer = setInterval(tick, intervalMs);
  if (typeof timer === "object" && timer && "unref" in timer) (timer as NodeJS.Timeout).unref();

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

export type { PendingNotification };
