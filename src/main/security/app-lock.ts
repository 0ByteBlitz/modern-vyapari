/**
 * The app lock, held in main.
 *
 * It used to live in renderer state only: the lock screen covered the window
 * while every IPC handler stayed callable, so "locked" described a picture,
 * not the app. Now main owns the flag and `safe()` refuses every request while
 * it is set, except the few the lock screen itself needs. One check at the
 * shared boundary rather than one per handler — a handler added next month is
 * refused without anyone remembering to.
 *
 * **Only requests are refused.** The plan monitor, alerts, the paper engine and
 * the notification worker never cross IPC, so they keep running while the app
 * is locked — that is J3: the plan executes without you, including while you
 * are away from the screen.
 *
 * It locks at launch, when Windows locks (Win+L, sleep) and after a period with
 * no keyboard or mouse input. It can only lock when Windows Hello can unlock
 * it: a lock nothing can open would strand the owner, so without Hello the app
 * stays open and the renderer says so instead of pretending to be locked.
 *
 * The settings are the owner's, not a mode's, so they live in the shared store.
 */
import { app, powerMonitor } from "electron";
import type { HelloAvailability, LockSettings, LockStatus } from "../../shared/ipc-types";
import { AppError } from "../../shared/errors";
import { getSharedStore } from "../db/shared-store";
import { auditLog } from "../db/database";
import { emit } from "../events/outbound";
import { createLogger } from "../logger";
import * as windowsHello from "./windows-hello";

const log = createLogger("app-lock");

/** What the lock screen needs: its own status, the unlock, and the "while you
 *  were away" feed — plus hiding the embedded browser, which the research page
 *  asks for as it unmounts behind the lock. Window controls and the quit prompt
 *  don't go through `safe()` and are never refused. */
const OPEN_WHILE_LOCKED = new Set([
  "security:status",
  "security:requestWindowsHello",
  "activity:list",
  "browser:hide",
]);

export const IDLE_CHOICES = [5, 15, 30, 60] as const;

const DEFAULTS: LockSettings = { lockAtLaunch: false, lockWithWindows: true, idleMinutes: 15 };
const KEYS = {
  lockAtLaunch: "lock_at_launch",
  lockWithWindows: "lock_with_windows",
  idleMinutes: "lock_idle_minutes",
} as const;

const IDLE_POLL_MS = 15_000;

/* Locked until the launch check decides otherwise: a request that arrives
   while PowerShell is still answering must not slip through. */
let locked = true;
let hello: HelloAvailability = "unavailable";
let ready: Promise<void> = Promise.resolve();

/** Whether `safe()` should refuse this channel right now. */
export function refusesWhileLocked(channel: string): boolean {
  return locked && !OPEN_WHILE_LOCKED.has(channel);
}

export function isLocked(): boolean {
  return locked;
}

export function shouldStartLocked(helloAvailability: HelloAvailability, settings: LockSettings): boolean {
  return helloAvailability === "available" && settings.lockAtLaunch;
}

function readRaw(key: string): string | undefined {
  const row = getSharedStore().prepare("SELECT value FROM shared_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function writeRaw(key: string, value: string): void {
  getSharedStore()
    .prepare("INSERT INTO shared_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function readLockSettings(): LockSettings {
  const bool = (key: string, fallback: boolean) => {
    const v = readRaw(key);
    return v === undefined ? fallback : v === "1";
  };
  const idleRaw = readRaw(KEYS.idleMinutes);
  const idleNum = Number(idleRaw);
  const idleMinutes =
    idleRaw === undefined
      ? DEFAULTS.idleMinutes
      : (IDLE_CHOICES as readonly number[]).includes(idleNum)
        ? idleNum
        : null;
  return {
    lockAtLaunch: bool(KEYS.lockAtLaunch, DEFAULTS.lockAtLaunch),
    lockWithWindows: bool(KEYS.lockWithWindows, DEFAULTS.lockWithWindows),
    idleMinutes,
  };
}

export function writeLockSettings(next: LockSettings): LockSettings {
  if (next.idleMinutes !== null && !(IDLE_CHOICES as readonly number[]).includes(next.idleMinutes)) {
    throw new AppError("VALIDATION", "Choose one of the idle times offered.");
  }
  writeRaw(KEYS.lockAtLaunch, next.lockAtLaunch ? "1" : "0");
  writeRaw(KEYS.lockWithWindows, next.lockWithWindows ? "1" : "0");
  writeRaw(KEYS.idleMinutes, next.idleMinutes === null ? "off" : String(next.idleMinutes));
  auditLog("lock_settings_changed", next);
  const saved = readLockSettings();
  announce();
  return saved;
}

/* Development only: `VYAPARI_SKIP_HELLO=1` on an UNPACKAGED run reports Hello
   as unavailable, so the app opens without the launch prompt and can be driven
   without a person at the fingerprint reader. A packaged build ignores it. */
async function checkHello(): Promise<HelloAvailability> {
  if (!app.isPackaged && process.env.VYAPARI_SKIP_HELLO === "1") return "unavailable";
  return windowsHello.checkAvailability();
}

export async function lockStatus(recheck = false): Promise<LockStatus> {
  await ready;
  if (recheck) hello = await checkHello();
  return { locked, hello, settings: readLockSettings() };
}

function announce(): void {
  void lockStatus().then((s) => emit("security:lock", s));
}

/** Lock now, if Windows Hello can open it again. */
export function lock(reason: "windows" | "idle"): void {
  if (locked || hello !== "available") return;
  locked = true;
  /* The embedded browser is a native view drawn over the window, so the lock
     screen cannot cover it — it is hidden here rather than trusted to the
     renderer. */
  const { hideBrowser } = require("../browser/embedded-browser") as typeof import("../browser/embedded-browser");
  hideBrowser();
  log.info(`Locked (${reason}).`);
  auditLog("app_locked", { reason });
  announce();
}

/* One Windows Hello prompt at a time. A second request while one is open gets
   the same answer instead of queueing another OS prompt behind it. */
let pendingUnlock: Promise<windowsHello.HelloResult> | null = null;

/** Ask Windows Hello; unlock only on a verified answer. */
export function unlockWithHello(reason: string): Promise<windowsHello.HelloResult> {
  if (pendingUnlock) return pendingUnlock;
  pendingUnlock = (async () => {
    try {
      await ready;
      const result = await windowsHello.requestVerification(reason);
      /* Every attempt is recorded, not only the one that worked: a cancelled
         or failed prompt is exactly what the owner would want to see later. */
      if (!result.verified) {
        auditLog("app_unlock_failed", { detail: result.detail ?? "" });
      } else if (locked) {
        locked = false;
        auditLog("app_unlocked", {});
        announce();
      }
      return result;
    } finally {
      pendingUnlock = null;
    }
  })();
  return pendingUnlock;
}

/**
 * Decide the launch state and start watching for the moments to relock.
 * Called once, after the shared store opens and before the window does.
 */
export function startAppLock(): void {
  ready = (async () => {
    hello = await checkHello();
    locked = shouldStartLocked(hello, readLockSettings());
    log.info(`Windows Hello ${hello}; the app starts ${locked ? "locked" : "unlocked"}.`);
  })().catch((err) => {
    /* An unanswerable check leaves Hello unknown — open, with the notice, as
       for a device without Hello. Staying locked would strand the owner. */
    log.error("Windows Hello check failed", err);
    hello = "unavailable";
    locked = false;
  });

  const withWindows = () => {
    if (readLockSettings().lockWithWindows) lock("windows");
  };
  powerMonitor.on("lock-screen", withWindows);
  powerMonitor.on("suspend", withWindows);

  /* System-wide input idle, not idle inside this window: someone working in
     another app is at the machine; nobody touching anything is not. */
  setInterval(() => {
    if (locked) return;
    const minutes = readLockSettings().idleMinutes;
    if (minutes !== null && powerMonitor.getSystemIdleTime() >= minutes * 60) lock("idle");
  }, IDLE_POLL_MS).unref();
}
