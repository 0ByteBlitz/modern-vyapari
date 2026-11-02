/**
 * Telling the owner something happened — on every channel it should reach.
 *
 * Until 2026-11-02 the three channels were wired separately and unevenly:
 * plan events went to Telegram but made no sound in the app; price alerts made
 * a sound in the app but never reached Telegram; and nothing used the
 * operating system's notifications, so with the window minimised an alert was
 * a sound with no words. This module is the one place an event is announced:
 *
 *  - **Telegram** through the outbox (durable, deduped, retried) — the caller
 *    has usually already enqueued inside its own transaction; `announceAlert`
 *    enqueues for alerts, which have no transaction to bind to.
 *  - **Windows notification** when the app window is not in front: minimised,
 *    hidden or behind another app. Clicking it brings the window back.
 *  - **In the app** via `notify:event`, which the toast host shows — except for
 *    alerts, which already have their own toast and sound (`alerts:triggered`).
 *
 * Called AFTER the state change has committed, never inside the transaction: a
 * notification for a change that then rolled back would be a lie.
 */
import { BrowserWindow, Notification } from "electron";
import { enqueue, type NotificationDraft } from "./outbox";
import { emit } from "../events/outbound";
import { createLogger } from "../logger";

const log = createLogger("announce");

/* The app window, found through Electron rather than by importing `main` —
   which would start the app in any process that loads this module (tests). */
function mainWindow(): BrowserWindow | null {
  if (!BrowserWindow?.getAllWindows) return null;
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
}

/** A Windows notification, only when the owner isn't already looking. */
function desktop(draft: NotificationDraft): void {
  try {
    const win = mainWindow();
    if (win && win.isVisible() && !win.isMinimized() && win.isFocused()) return;
    if (!Notification?.isSupported?.()) return;
    const n = new Notification({ title: draft.title, body: draft.body.slice(0, 240) });
    n.on("click", () => {
      const w = mainWindow();
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    });
    n.show();
    log.info(`Desktop notification shown: ${draft.kind}`);
  } catch (err) {
    // A notification that can't be shown must not break what it reports on.
    log.warn("Desktop notification failed", err);
  }
}

/**
 * Announce an event whose Telegram message the caller has ALREADY enqueued in
 * the same transaction as the change (plan transitions, branch triggers).
 */
export function announce(draft: NotificationDraft): void {
  desktop(draft);
  emit("notify:event", { kind: draft.kind, title: draft.title, body: draft.body, at: Date.now() });
}

/**
 * Announce a fired alert: Telegram (via the outbox) and a Windows
 * notification. The in-app toast and sound come from `alerts:triggered`.
 */
export function announceAlert(draft: NotificationDraft): void {
  try {
    enqueue(draft);
  } catch (err) {
    log.error("Could not queue the alert for Telegram", err);
  }
  desktop(draft);
}
