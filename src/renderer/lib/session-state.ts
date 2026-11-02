import type { SessionSummary } from "@/lib/api";

/**
 * What a session is doing, in one word — the same word on every surface.
 *
 * Shared by Home's session cards and the rail's dot tooltips, so the two can
 * never word the same session differently.
 */

/** One word for a session card. An open position outranks an armed plan:
 *  it is the state with money in it. Never "idle" while either exists. */
export function sessionState(s: Pick<SessionSummary, "openCount" | "armedCount">): string {
  if (s.openCount > 0 && s.armedCount > 0) return "in position · armed";
  if (s.openCount > 0) return "in position";
  if (s.armedCount > 0) return "armed";
  return "idle";
}
