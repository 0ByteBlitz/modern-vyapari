import type { SessionSummary } from "@/lib/api";

/**
 * What a session is doing, in one word — the same word on every surface.
 *
 * Home's session cards and the rail's dots used to answer this separately: the
 * card said IDLE while the dot was green, because the dot only meant "status is
 * active" and every unpaused session had one. One function now answers it.
 */

/** One word for a session card. An open position outranks an armed plan:
 *  it is the state with money in it. Never "idle" while either exists. */
export function sessionState(s: Pick<SessionSummary, "openCount" | "armedCount">): string {
  if (s.openCount > 0 && s.armedCount > 0) return "in position · armed";
  if (s.openCount > 0) return "in position";
  if (s.armedCount > 0) return "armed";
  return "idle";
}

export type SessionDot = "working" | "idle" | "paused";

/** The rail's dot. Green only while the engine has something to act on —
 *  an armed plan or an open position — never merely for being unpaused. */
export function sessionDot(status: string, s: Pick<SessionSummary, "openCount" | "armedCount"> | undefined): SessionDot {
  if (status === "paused") return "paused";
  return s && (s.openCount > 0 || s.armedCount > 0) ? "working" : "idle";
}
