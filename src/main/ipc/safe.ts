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
import { toUserFacing, type UserFacingError } from "../../shared/errors";

const ipcLog = createLogger("ipc");

export async function safe<T>(fn: () => T | Promise<T>, channel = "unknown"): Promise<T | UserFacingError> {
  try {
    return await fn();
  } catch (err) {
    ipcLog.error(`${channel} failed`, err);
    return toUserFacing(err);
  }
}
