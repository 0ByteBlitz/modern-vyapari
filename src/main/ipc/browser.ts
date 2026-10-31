/**
 * The embedded research browser
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as embeddedBrowser from "../browser/embedded-browser";
import { safe } from "./safe";

export function registerBrowser(): void {
  /* ── Embedded browser (Phase 1 surface 3) ────────────────────── */
ipcMain.handle("browser:show", () =>
    safe(() => {
      const { mainWindow } = require("./main");
      if (!mainWindow) throw new Error("Main window not ready");
      embeddedBrowser.showBrowser(mainWindow);
      return { ok: true };
    }, "browser:show")
  );

ipcMain.handle("browser:hide", () =>
    safe(() => {
      embeddedBrowser.hideBrowser();
      return { ok: true };
    }, "browser:hide")
  );

ipcMain.handle("browser:setBounds", (_e, bounds: { x: number; y: number; width: number; height: number }) =>
    safe(() => {
      embeddedBrowser.setBrowserBounds(bounds);
      return { ok: true };
    }, "browser:setBounds")
  );

ipcMain.handle("browser:navigate", (_e, url: string) =>
    safe(() => {
      embeddedBrowser.navigate(url);
      return { ok: true };
    }, "browser:navigate")
  );

ipcMain.handle("browser:goHome", () =>
    safe(() => {
      embeddedBrowser.goHome();
      return { ok: true };
    }, "browser:goHome")
  );

ipcMain.handle("browser:goBack", () =>
    safe(() => {
      embeddedBrowser.goBack();
      return { ok: true };
    }, "browser:goBack")
  );

ipcMain.handle("browser:goForward", () =>
    safe(() => {
      embeddedBrowser.goForward();
      return { ok: true };
    }, "browser:goForward")
  );

ipcMain.handle("browser:reload", () =>
    safe(() => {
      embeddedBrowser.reload();
      return { ok: true };
    }, "browser:reload")
  );

ipcMain.handle("browser:getState", () => safe(() => embeddedBrowser.getState(), "browser:getState"));
}
