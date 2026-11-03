/**
 * The internal↔user boundary, in one place.
 *
 * Every IPC handler funnels through `safe`, which is what makes the boundary
 * enforceable rather than a convention. Before it existed the raw `err.message`
 * was returned to the renderer, so SQLite text, absolute paths and venue API
 * bodies rendered straight into the UI. Now the full error is logged with its
 * channel name and the renderer gets a short sentence plus a stable code.
 *
 * It lives here rather than in `index.ts` so a domain module can import it
 * without importing the registry that imports every other domain — which was
 * the whole point of the split.
 */
import { createLogger } from "../logger";
import { AppError, toUserFacing, type UserFacingError } from "../../shared/errors";
import { refusesWhileLocked } from "../security/app-lock";

const ipcLog = createLogger("ipc");

export async function safe<T>(fn: () => T | Promise<T>, channel = "unknown"): Promise<T | UserFacingError> {
  /* The app lock is enforced here, once, for every handler (security/app-lock.ts).
     An unlabelled call is "unknown", which is not on the open list — refused. */
  if (refusesWhileLocked(channel)) {
    ipcLog.warn(`${channel} refused: the app is locked`);
    return toUserFacing(new AppError("LOCKED"));
  }
  try {
    return await fn();
  } catch (err) {
    ipcLog.error(`${channel} failed`, err);
    return toUserFacing(err);
  }
}
