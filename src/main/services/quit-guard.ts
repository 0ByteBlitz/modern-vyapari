/**
 * Confirm before quitting, in the app's own theme.
 *
 * The close is intercepted here and the question is asked by the renderer
 * (`quit-dialog.tsx`), so it looks like the rest of the app instead of a grey
 * Windows message box. Two things make that safe rather than merely pretty:
 *
 *  1. **A window must always be closable.** If the renderer is loading, has
 *     crashed, or does not acknowledge the request within `ACK_MS`, main falls
 *     back to the native box with the same words. A themed dialog that never
 *     appears would be a close button that does nothing.
 *  2. **One question at a time.** Pressing close again while the dialog is up
 *     brings the window forward instead of stacking a second request — and an
 *     acknowledgement that arrives after the fallback already answered is
 *     refused, so the renderer never shows a dialog nobody is waiting for.
 *
 * What the dialog says is `describeQuit` in `shared/quit.ts`, used by both paths.
 */
import { app, dialog, type BrowserWindow } from "electron";
import { getDb } from "../db/database";
import { appMode } from "../modes/app-mode";
import { describeQuit, type QuitSummary } from "../../shared/quit";
import { createLogger } from "../logger";

const log = createLogger("quit-guard");

/** How long the renderer has to say the dialog is on screen. */
const ACK_MS = 1500;

let confirmed = false;
let pending: { timer: NodeJS.Timeout | null; shown: boolean; summary: QuitSummary } | null = null;

/** Counts read fresh at the moment of asking. Unreadable → null, never 0. */
export function quitSummary(): QuitSummary {
  const mode = appMode();
  try {
    const db = getDb();
    const plans = db
      .prepare(
        `SELECT COUNT(*) AS n FROM trade_plans p
           JOIN sessions s ON s.id = p.session_id
          WHERE p.state = 'planned' AND s.status != 'archived'`
      )
      .get() as { n: number };
    const positions = db
      .prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE status = 'open'`)
      .get() as { n: number };
    return { mode, armedPlans: Number(plans.n), openPositions: Number(positions.n) };
  } catch (e) {
    log.warn("Could not read what is being watched:", e);
    return { mode, armedPlans: null, openPositions: null };
  }
}

export function attachQuitGuard(win: BrowserWindow): void {
  win.on("close", (e) => {
    if (confirmed) return;
    e.preventDefault();
    requestQuit(win);
  });
}

function requestQuit(win: BrowserWindow): void {
  if (pending) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  const summary = quitSummary();
  const wc = win.webContents;
  if (wc.isDestroyed() || wc.isLoading() || wc.isCrashed()) {
    nativeConfirm(win, summary);
    return;
  }
  pending = { timer: null, shown: false, summary };
  pending.timer = setTimeout(() => {
    if (!pending || pending.shown) return;
    log.warn(`Renderer did not show the quit dialog within ${ACK_MS}ms — using the native one.`);
    pending = null;
    nativeConfirm(win, summary);
  }, ACK_MS);
  wc.send("app:quitRequested", summary);
}

/** The renderer is about to show the dialog. False means "too late, don't". */
export function quitShown(): boolean {
  if (!pending) return false;
  pending.shown = true;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  return true;
}

export function answerQuit(quit: boolean): void {
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending = null;
  if (quit) confirmQuit();
}

function confirmQuit(): void {
  confirmed = true;
  app.quit();
}

function nativeConfirm(win: BrowserWindow, summary: QuitSummary): void {
  const copy = describeQuit(summary);
  const detail = [copy.lead, ...copy.consequences.map((c) => `• ${c}`)].join("\n");
  const choice = dialog.showMessageBoxSync(win, {
    type: copy.guarded ? "warning" : "question",
    buttons: ["Quit", "Cancel"],
    defaultId: copy.guarded ? 1 : 0,
    cancelId: 1,
    title: copy.title,
    message: copy.title,
    detail,
  });
  if (choice === 0) confirmQuit();
}
