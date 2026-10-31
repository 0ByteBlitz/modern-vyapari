/**
 * Custom-titlebar window controls
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";


export function registerWindow(): void {
  /* ── Window controls (custom titlebar) ──────────────────────── */
ipcMain.handle("window:minimize", () => {
    const { mainWindow } = require("../main");
    mainWindow?.minimize();
  });

ipcMain.handle("window:maximize", () => {
    const { mainWindow } = require("../main");
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });

ipcMain.handle("window:close", () => {
    const { mainWindow } = require("../main");
    mainWindow?.close();
  });
}
