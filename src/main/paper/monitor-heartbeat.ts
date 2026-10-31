/**
 * Was anything actually watching?
 *
 * The spine journey is *"the plan executes without me"* — and the app only runs
 * when the owner's machine does. A closed laptop watches nothing. That much is
 * obvious; what is **not** obvious, and is the reason this file exists, is that
 * the gap is otherwise **invisible and indistinguishable from a real answer**:
 *
 *   • a plan that expired while the app was shut looks the same as one that
 *     expired while being watched;
 *   • a plan that never triggered because nobody was looking is recorded
 *     identically to one that never triggered because price never came.
 *
 * The second is the dangerous one. S3-6's calibration record measures *trigger
 * rate* — the owner's own hit rate by thesis type — and it is the only evidence
 * a plans-only product accumulates. Counting an unwatched window as "did not
 * trigger" corrupts that number in the flattering direction, with nothing
 * anywhere that would notice. Same shape as the paper balance read from a
 * column the SELECT omitted.
 *
 * So the monitor writes a heartbeat while it runs, and the gaps between
 * heartbeats are recoverable facts rather than silence.
 *
 * **Deliberately not a solution to the app being closed.** It is the honest
 * accounting of it. Running unattended is a different question (a headless
 * Windows task, or out-of-app escalation in ROADMAP §5); for an *open* position
 * the answer is already the plan's hard rule — every live position carries a
 * **venue-side** stop, because a local stop is not a stop if the app is closed.
 */
import { getDb } from "../db/database";
import { createLogger } from "../logger";

const log = createLogger("heartbeat");

/** How often the monitor says it is alive. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Longer than the interval, so ordinary jitter is not reported as an outage.
 * Three missed beats rather than one: a busy event loop or a slow disk should
 * not manufacture a gap the owner then has to interpret.
 */
export const GAP_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3;

const KEY = "monitor_heartbeat";

export interface WatchGap {
  from: number;
  to: number;
  ms: number;
}

/** Record that the monitor is alive right now. */
export function beat(now: number = Date.now()): void {
  getDb()
    .prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(KEY, String(now));
}

/** When the monitor last said it was alive, or null if it never has. */
export function lastBeat(): number | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as
    | { value: string }
    | undefined;
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * The gap between the last heartbeat and now, if there is one worth reporting.
 *
 * Called at startup, before the first beat of this run — that is the only
 * moment the previous run's end is still readable.
 *
 * Returns null on a first-ever run: no heartbeat means nothing was promised, so
 * there is no gap to report. Claiming a gap "since the beginning of time" would
 * be noise on a fresh install.
 */
export function gapSinceLastRun(now: number = Date.now()): WatchGap | null {
  const last = lastBeat();
  if (last === null) return null;
  const ms = now - last;
  if (ms < GAP_THRESHOLD_MS) return null;
  return { from: last, to: now, ms };
}

/** Start beating. Returns a stop function. */
export function startHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS): () => void {
  beat();
  const id = setInterval(() => {
    try {
      beat();
    } catch (e) {
      /* A failed heartbeat must never take the engine down — the worst it can
         do is overstate a gap, which errs toward telling the owner *more*. */
      log.warn("Heartbeat write failed.", e);
    }
  }, intervalMs);
  /* Do not hold the process open for a heartbeat. */
  if (typeof id === "object" && id && "unref" in id) (id as NodeJS.Timeout).unref();
  return () => clearInterval(id);
}

/** Human-readable duration, for the one sentence the owner reads. */
export function describeGap(gap: WatchGap): string {
  const mins = Math.round(gap.ms / 60_000);
  if (mins < 90) return `${mins} minutes`;
  const hours = gap.ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${Math.round(hours / 24)} days`;
}
