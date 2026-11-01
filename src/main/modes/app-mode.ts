/**
 * Simulated or live — an **app mode**, not a flag on a plan.
 *
 * ## Why the app, and not the plan
 *
 * Proposed as a per-plan flag; the owner improved on it (2026-08-05) and the
 * improvement is structural. A per-plan flag means the app holds a **mixture**
 * at all times, and every list, aggregate, badge, export and notification has
 * to carry the distinction correctly for ever — the ambiguous-state failure the
 * design rules already forbid, enforced in fifty places instead of one.
 *
 * At app level it becomes an **absence rather than a defence**, the same class
 * of guarantee as `PlanState` having no `live_auto` member: in simulated mode
 * the venue registry hands back an adapter that declares `canPlaceOrders:
 * false` and has no signing path at all. There is no route to a real order to
 * forget to close.
 *
 * ## The mode is chosen before the database opens
 *
 * This module deliberately imports **nothing from the app**. It is read by
 * `main.ts` before `initDatabase`, because the mode decides *which database
 * file* opens — two files, never a `mode` column. A column is the
 * `source = 'binance'` problem again: eighteen predicates, and the one you
 * forget blends silently rather than failing. Separate files make cross-mode
 * contamination unwriteable rather than merely discouraged.
 *
 * Consequence worth stating plainly: **switching mode requires a restart.**
 * The database, the engine and every cached row belong to one mode, and
 * swapping them underneath a running monitor is exactly the ambiguity the
 * design forbids.
 *
 * ## What crosses, and what must not
 *
 * **Lessons cross modes; the calibration record does not** (owner decision).
 * What the owner learned about how a range reclaim behaves is market knowledge
 * and transfers. A *hit rate* must never blend simulated fills with real ones —
 * simulated fills are optimistic by construction, so a blended record flatters
 * the owner with nothing that would notice. Distilled lessons therefore live in
 * a small shared store both modes open; sessions, plans, positions and the
 * calibration record stay inside their own mode's file.
 */

import * as fs from "fs";
import * as path from "path";

export type AppMode = "simulated" | "live";

/** Simulated unless deliberately changed. Live is the exception, always. */
export const DEFAULT_MODE: AppMode = "simulated";

/**
 * Where the choice is remembered.
 *
 * A plain file beside the databases rather than a row inside one, because the
 * mode has to be known *before* any database is opened — reading it from the
 * thing it selects would be circular.
 */
const MODE_FILE = "app-mode.json";

function modePath(userDataPath: string): string {
  return path.join(userDataPath, MODE_FILE);
}

export function isAppMode(v: unknown): v is AppMode {
  return v === "simulated" || v === "live";
}

/**
 * The mode this process is running in.
 *
 * Anything unreadable, missing or unrecognised resolves to **simulated**. That
 * is the only safe direction: a corrupt file must never be the reason the app
 * comes up pointed at real money.
 */
export function readMode(userDataPath: string): AppMode {
  try {
    const raw = fs.readFileSync(modePath(userDataPath), "utf8");
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return isAppMode(parsed.mode) ? parsed.mode : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * The mode a process actually runs in, given the stored choice.
 *
 * **Live is only real when some venue can place an order.** Until then a "live"
 * process opens the live database while the paper engine keeps filling — so
 * the titlebar says LIVE, the toolbar says paper, and simulated fills land in
 * the file whose whole purpose is to hold only real ones. That happened
 * (2026-11-01). A stored "live" choice therefore runs simulated until live
 * execution exists; the choice itself is left alone.
 */
export function resolveMode(chosen: AppMode, liveExecutionBuilt: boolean): AppMode {
  return chosen === "live" && liveExecutionBuilt ? "live" : "simulated";
}

/** Persist the choice for the next launch. Takes effect on restart. */
export function writeMode(userDataPath: string, mode: AppMode): void {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(modePath(userDataPath), JSON.stringify({ mode }, null, 2), "utf8");
}

/**
 * The database file for a mode.
 *
 * **Simulated keeps the historic `mybot.db` name, and live is the new file.**
 * That looks backwards for about a second and then is obviously right: live
 * execution has never run — `canPlaceOrders` is false on every adapter and
 * `revolutx-exchange.ts` still throws — so every row in the existing database
 * is paper. Naming it the live file would have labelled a pile of simulated
 * fills as real, which is the ambiguous state the whole mode split exists to
 * prevent, and it would also have meant the owner's actual history did not open
 * in the default mode.
 *
 * The first version of this function had it the other way round, on a
 * reasonable-sounding "preserve the historic filename" argument. The on-disk
 * migration test caught it: it seeds a v16 `mybot.db`, migrates, and asserts a
 * pre-existing session survived — under the old mapping the app opened an empty
 * `mybot-simulated.db` and the row was simply gone.
 *
 * So live starts genuinely empty, which is the truth, and nothing is renamed.
 */
export function databaseFileName(mode: AppMode): string {
  return mode === "live" ? "mybot-live.db" : "mybot.db";
}

/** The one store both modes open. Lessons only — see the header. */
export const SHARED_STORE_FILE = "lessons-shared.db";

/* ── Process-wide current mode ──────────────────────────────────────── */

let current: AppMode = DEFAULT_MODE;
let locked = false;

/**
 * Fix the mode for this process. Called once by `main.ts` before the database
 * opens; a second call throws rather than silently re-pointing a running app at
 * the other mode's data.
 */
export function lockMode(mode: AppMode): void {
  if (locked) {
    throw new Error(`App mode is already locked to "${current}"; changing it requires a restart.`);
  }
  current = mode;
  locked = true;
}

export function appMode(): AppMode {
  return current;
}

export function isLive(): boolean {
  return current === "live";
}

/** Test seam. Never call this from app code — `lockMode` is the real entry. */
export function __resetModeForTests(mode: AppMode = DEFAULT_MODE): void {
  current = mode;
  locked = false;
}
