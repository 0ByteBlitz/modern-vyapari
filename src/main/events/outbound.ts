/**
 * The one typed channel from main to the renderer (roadmap S2-7b).
 *
 * Twelve channels were being sent from six modules by calling
 * `webContents.send` directly, which made the internal↔user boundary
 * **per-call-site rather than per-process**. `safe()` in `ipc.ts` already
 * guards every *request* handler; nothing guarded the pushes. That is not
 * hypothetical: chat streaming rendered raw Anthropic API errors straight into
 * the transcript until it was fixed by hand, which is exactly the leak `safe()`
 * exists to prevent — arriving through the door `safe()` does not cover.
 *
 * So: one module, one map, and **`emitError` is the only way to put an error on
 * a channel**. Sanitisation stops being something seven call sites have to
 * remember.
 *
 * ## What this is not
 *
 * **Not an event bus, and deliberately not usable as one.** The rule from
 * roadmap S2-7 holds: this carries *notifications of things that have already
 * happened*, never a step in a sequence that decides money. It is one-way
 * (main → renderer), there is no request/response, no `once`, and no `waitFor`
 * — the last of which is how a bus starts being used for sequencing. Anything
 * order-dependent stays a direct call.
 */

import { BrowserWindow, type WebContents } from "electron";
import { toUserFacing, type ErrorCode } from "../../shared/errors";
import type { ArchiveStepEvent, CandleRepairProgress } from "../../shared/ipc-types";

/* ── The channel map ────────────────────────────────────────────────── */

/**
 * Every main → renderer channel and its payload.
 *
 * Adding a channel means adding a line here, which is the point: the set is
 * enumerable, and a payload shape cannot drift from what the renderer expects
 * without the compiler noticing.
 */
export interface OutboundMap {
  /** Switch the visible surface, so the user watches the agent work. */
  "agent:navigate": string;
  /** Toggle the "agent is working" indicator. */
  "agent:acting": boolean;
  /** Something an agent tool wrote is now stale on screen. */
  "data:updated": { kind: string };
  /** Embedded research browser navigation state. */
  "browser:state": unknown;
  /** An alert condition became true. */
  "alerts:triggered": unknown;
  /** Live candle tick. **Hot path** — fires per subscription per tick. */
  "binance:candle-update": { symbol: string; intervalMin: number; candle: unknown };
  /** Filtered 24h ticker array. **Hot path.** */
  "binance:ticker-update": unknown[];
  /** Progress of a candle-history repair run. */
  "candles:repairProgress": CandleRepairProgress;
  /** One step of a session archive wind-down. */
  "sessions:archiveStep": ArchiveStepEvent;
  /** A streamed chunk of assistant text. */
  "chat:chunk": { text: string };
  /** The turn finished. */
  "chat:complete": Record<string, never>;
  /** A failure, already sanitised. **Only `emitError` may construct this.** */
  "chat:error": UserFacingPayload;
  /** Something the turn did differently, while still succeeding — e.g. a
   *  capability the model refused. Deliberately not `chat:error`: the turn has
   *  not failed, and styling it as a failure would train the owner to ignore
   *  real ones. Author these as plain sentences; nothing internal goes here. */
  "chat:notice": { text: string };
}

export type OutboundChannel = keyof OutboundMap;

/**
 * The sanitised shape every error-bearing channel must carry.
 *
 * A stable code plus one plain sentence — never an internal message, a SQLite
 * string, a file path or a venue API body.
 */
export interface UserFacingPayload {
  error: string;
  code: ErrorCode;
  hint?: string;
}

/* ── Sending ────────────────────────────────────────────────────────── */

/**
 * Is this target still able to receive?
 *
 * A destroyed `WebContents` throws on `send`. The old direct calls each had to
 * remember to check, and a background writer that outlives a window — the WS
 * candle ingest, for instance — is exactly the case that forgets.
 */
function alive(target: WebContents | null | undefined): target is WebContents {
  return Boolean(target && !target.isDestroyed());
}

/** Send to one specific renderer — used where a reply must go back to the
 *  sender that asked, as chat streaming does. */
export function emitTo<C extends OutboundChannel>(
  target: WebContents | null | undefined,
  channel: C,
  payload: OutboundMap[C]
): void {
  if (!alive(target)) return;
  target.send(channel, payload);
}

/**
 * Send to every open window.
 *
 * Deliberately not "the main window": a channel like `data:updated` is a
 * statement about the world, not about one surface, and resolving a single
 * window here would silently drop it for any other.
 */
export function emit<C extends OutboundChannel>(channel: C, payload: OutboundMap[C]): void {
  /* No window layer at all — a test process, or a shutdown that has already
     torn Electron down. Telling nobody is the correct outcome, and it must
     never be able to break the thing being announced: these are notifications
     that something already happened, so a failure here would abort a write
     that had every right to succeed. */
  if (!BrowserWindow?.getAllWindows) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    emitTo(win.webContents, channel, payload);
  }
}

/**
 * Put a failure on a channel, sanitised.
 *
 * **The only way to construct a `UserFacingPayload`.** Callers hand over
 * whatever they caught; `toUserFacing` classifies it and strips it. There is no
 * overload taking a pre-built string, because that is precisely the shape that
 * let a raw API error reach the transcript.
 */
export function emitError<C extends { [K in OutboundChannel]: OutboundMap[K] extends UserFacingPayload ? K : never }[OutboundChannel]>(
  target: WebContents | null | undefined,
  channel: C,
  err: unknown
): UserFacingPayload {
  const ui = toUserFacing(err);
  const payload: UserFacingPayload = {
    error: ui.hint ? `${ui.message} ${ui.hint}` : ui.message,
    code: ui.code,
    ...(ui.hint ? { hint: ui.hint } : {}),
  };
  emitTo(target, channel, payload as OutboundMap[C]);
  return payload;
}
