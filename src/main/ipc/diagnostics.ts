/**
 * Log file, database info, clipboard
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain, clipboard } from "electron";
import { getLogFilePath, readRecentLogs } from "../logger";
import { dbInfo } from "../db/database";
import { safe } from "./safe";

export function registerDiagnostics(): void {
ipcMain.handle("db:info", () => safe(() => dbInfo(), "db:info"));

  /* ── Diagnostics ──────────────────────────────────────────────
     The log file is where internal detail lives. These expose the path and
     recent lines so the user can inspect or share them deliberately, rather
     than having internals pushed at them through error messages. */
ipcMain.handle("logs:path", () => safe(() => ({ path: getLogFilePath() }), "logs:path"));

ipcMain.handle("logs:recent", (_e, maxLines?: number) =>
    safe(() => ({ lines: readRecentLogs(maxLines ?? 200) }), "logs:recent")
  );

ipcMain.handle("logs:reveal", () =>
    safe(async () => {
      const { shell } = require("electron");
      await shell.openPath(getLogFilePath());
      return { ok: true };
    }, "logs:reveal")
  );

ipcMain.handle("clipboard:write", (_e, text: string) =>
    safe(async () => {
      /* Electron 44 made clipboard.writeText return a Promise. Without the
         await, this reported success before the copy happened, and a failed
         copy became an unhandled rejection the user never saw. */
      await clipboard.writeText(text);
      return { ok: true };
    }, "clipboard:write")
  );
}
