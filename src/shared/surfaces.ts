/**
 * The surfaces that belong to one session. Everything else (Home, Portfolio,
 * Markets, Approvals, Settings, Browser) is global.
 *
 * One definition for both bundles: the renderer uses it to decide what the
 * rail and the agent drawer show, and main uses it so the agent only navigates
 * within its own conversation's side (`agent/chat.ts`). No imports, ever.
 */
export const SESSION_SURFACES = ["dashboard", "orders", "plans", "journal", "research", "alerts"] as const;
export type SessionSurface = (typeof SESSION_SURFACES)[number];

export function isSessionSurfaceId(s: string): s is SessionSurface {
  return (SESSION_SURFACES as readonly string[]).includes(s);
}
