/**
 * Onboarding, credentials and the app-launch gate
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain, app } from "electron";
import * as credentials from "../security/credentials";
import * as windowsHello from "../security/windows-hello";
import type { SetupStatus } from "../../shared/ipc-types";
import { auditLog } from "../db/database";
import { appMode, readMode, writeMode, isAppMode } from "../modes/app-mode";
import { venueCapabilities } from "../integrations/venue/registry";
import { AppError } from "../../shared/errors";
import { safe } from "./safe";
import { emit } from "../events/outbound";

export function registerSetup(): void {
ipcMain.handle("setup:status", () =>
    safe(
      (): SetupStatus => ({
        hasKeyPair: credentials.hasKeyPair(),
        hasApiKey: credentials.hasApiKey(),
        hasAnthropicApiKey: credentials.hasAnthropicApiKey(),
        // Presence only — the key itself never crosses IPC.
        hasBrowserbaseKey: credentials.hasBrowserbaseKey(),
        publicKeyPem: credentials.getPublicKeyPem(),
      })
    , "setup:status")
  );

ipcMain.handle("setup:generateKeys", () =>
    safe(() => {
      const publicKeyPem = credentials.ensureKeyPair();
      auditLog("keypair_generated", {});
      return { publicKeyPem };
    }, "setup:generateKeys")
  );

ipcMain.handle("setup:saveApiKey", (_e, apiKey: string) =>
    safe(() => {
      credentials.saveApiKey(apiKey);
      auditLog("api_key_saved", {});
      return { ok: true };
    }, "setup:saveApiKey")
  );

ipcMain.handle("setup:saveAnthropicApiKey", (_e, apiKey: string) =>
    safe(() => {
      credentials.saveAnthropicApiKey(apiKey);
      auditLog("anthropic_api_key_saved", {});
      /* The chat panel fetched its model list with the OLD key; without this it
         keeps showing that result until a restart. */
      emit("data:updated", { kind: "credentials" });
      return { ok: true };
    }, "setup:saveAnthropicApiKey")
  );

ipcMain.handle("setup:saveBrowserbaseKey", (_e, apiKey: string) =>
    safe(() => {
      credentials.saveBrowserbaseKey(apiKey);
      // The key itself never enters the audit log, only the fact it changed.
      auditLog("browserbase_key_saved", {});
      return { ok: true };
    }, "setup:saveBrowserbaseKey")
  );

ipcMain.handle("setup:clearBrowserbaseKey", () =>
    safe(() => {
      credentials.clearBrowserbaseKey();
      auditLog("browserbase_key_cleared", {});
      return { ok: true };
    }, "setup:clearBrowserbaseKey")
  );

  /* ── Security (app-launch gate) ────────────────────────────── */
ipcMain.handle("security:checkWindowsHello", () => safe(() => windowsHello.checkAvailability(), "security:checkWindowsHello"));

ipcMain.handle("security:requestWindowsHello", (_e, reason: string) =>
    safe(() => {
      // Best-effort: make sure our window is unambiguously the foreground
      // window right before spawning PowerShell, so the child process
      // qualifies for Windows' "started by the foreground process"
      // foreground-lock exception (see windows-hello.ts for the rest of
      // the fix — AllowSetForegroundWindow covers the case this doesn't).
      const { mainWindow } = require("../main");
      mainWindow?.focus();
      return windowsHello.requestVerification(reason || "Unlock Modern Vyapari");
    }, "security:requestWindowsHello")
  );

  /* ── App mode ─────────────────────────────────────────────────────
     Simulated or live. Read freely; changing it only takes effect on the next
     launch, because the database, the engine and every cached row belong to
     one mode and swapping them underneath a running monitor is exactly the
     ambiguity the split exists to prevent. */
  ipcMain.handle("mode:get", () =>
    safe(
      () => ({
        mode: appMode(),
        /* What the NEXT launch will use. Differs from `mode` between choosing
           and restarting, and the UI has to be able to say so. */
        pending: readMode(app.getPath("userData")),
        canPlaceOrders: venueCapabilities().canPlaceOrders,
      }),
      "mode:get"
    )
  );

  ipcMain.handle("mode:set", (_e, mode: string) =>
    safe(() => {
      if (!isAppMode(mode)) throw new AppError("VALIDATION", "Unknown mode.");
      writeMode(app.getPath("userData"), mode);
      /* Audited like the kill switch and the venue switch: it decides whether
         this app can reach real money. */
      auditLog("app_mode_selected", { mode, effectiveFrom: "next launch" });
      return { ok: true as const, restartRequired: mode !== appMode() };
    }, "mode:set")
  );
}
