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
import * as appLock from "../security/app-lock";
import type { LockSettings, SetupStatus } from "../../shared/ipc-types";
import { auditLog } from "../db/database";
import { appMode, readMode, resolveMode, writeMode, isAppMode } from "../modes/app-mode";
import { liveVenue, liveExecutionBuilt } from "../integrations/venue/registry";
import { aiProvider } from "../ai/registry";
import { AppError } from "../../shared/errors";
import { safe } from "./safe";
import { emit } from "../events/outbound";

/**
 * Whether the app is ready to use. Simulated mode trades on the paper adapter,
 * which needs no account, so it needs only an AI provider; live mode also needs
 * its venue. Decided here, once — the renderer used to require one exchange's
 * key files, which locked onboarding to that exchange.
 */
export function isSetupComplete(ai: { configured: boolean }, venue: { required: boolean; configured: boolean }): boolean {
  return ai.configured && (!venue.required || venue.configured);
}

export function registerSetup(): void {
ipcMain.handle("setup:status", () =>
    safe(
      (): SetupStatus => {
        const mode = appMode();
        const live = liveVenue();
        const ai = aiProvider();
        const venue = {
          id: live?.capabilities.id ?? "none",
          displayName: live?.capabilities.displayName ?? "No venue",
          configured: live?.isConfigured() ?? false,
          /* Simulated mode trades on the paper adapter, which needs no account
             — so a venue is optional there, and required only to go live. */
          required: mode === "live",
        };
        const aiStatus = { id: ai.info.id, displayName: ai.info.displayName, configured: ai.isConfigured() };
        return {
        setupComplete: isSetupComplete(aiStatus, venue),
        mode,
        venue,
        ai: aiStatus,
        hasKeyPair: credentials.hasKeyPair(),
        hasApiKey: credentials.hasApiKey(),
        hasAnthropicApiKey: credentials.hasAnthropicApiKey(),
        // Presence only — the key itself never crosses IPC.
        hasBrowserbaseKey: credentials.hasBrowserbaseKey(),
        publicKeyPem: credentials.getPublicKeyPem(),
        };
      }
    , "setup:status")
  );

ipcMain.handle("setup:generateKeys", () =>
    safe(async () => {
      const publicKeyPem = await credentials.ensureKeyPair();
      auditLog("keypair_generated", {});
      return { publicKeyPem };
    }, "setup:generateKeys")
  );

ipcMain.handle("setup:saveApiKey", (_e, apiKey: string) =>
    safe(async () => {
      await credentials.saveApiKey(apiKey);
      auditLog("api_key_saved", {});
      return { ok: true };
    }, "setup:saveApiKey")
  );

ipcMain.handle("setup:saveAnthropicApiKey", (_e, apiKey: string) =>
    safe(async () => {
      /* Awaited before the broadcast: announcing the change first would make
         the chat panel re-fetch models with the key that is being replaced. */
      await credentials.saveAnthropicApiKey(apiKey);
      auditLog("anthropic_api_key_saved", {});
      /* The chat panel fetched its model list with the OLD key; without this it
         keeps showing that result until a restart. */
      emit("data:updated", { kind: "credentials" });
      return { ok: true };
    }, "setup:saveAnthropicApiKey")
  );

ipcMain.handle("setup:saveBrowserbaseKey", (_e, apiKey: string) =>
    safe(async () => {
      await credentials.saveBrowserbaseKey(apiKey);
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

  /* ── Security (the app lock, held in main — security/app-lock.ts) ── */
  /* `recheck` asks Windows again, for the Settings pane; the lock screen and
     the shell read the launch answer, which is instant. */
ipcMain.handle("security:status", (_e, recheck?: boolean) =>
    safe(() => appLock.lockStatus(recheck === true), "security:status")
  );

ipcMain.handle("security:setLockSettings", (_e, next: LockSettings) =>
    safe(() => appLock.writeLockSettings(next), "security:setLockSettings")
  );

ipcMain.handle("security:requestWindowsHello", (_e, reason: string) =>
    safe(() => {
      // Best-effort: make sure our window is unambiguously the foreground
      // window right before spawning PowerShell, so the child process
      // qualifies for Windows' "started by the foreground process"
      // foreground-lock exception (see windows-hello.ts for the rest of
      // the fix — AllowSetForegroundWindow covers the case this doesn't).
      const { mainWindow } = require("../main");
      mainWindow?.focus();
      return appLock.unlockWithHello(reason || "Unlock Modern Vyapari");
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
        pending: resolveMode(readMode(app.getPath("userData")), liveExecutionBuilt()),
        liveAvailable: liveExecutionBuilt(),
      }),
      "mode:get"
    )
  );

  ipcMain.handle("mode:set", (_e, mode: string) =>
    safe(() => {
      if (!isAppMode(mode)) throw new AppError("VALIDATION", "Unknown mode.");
      if (mode === "live" && !liveExecutionBuilt()) {
        throw new AppError("NOT_IMPLEMENTED", "Live trading isn't available yet. Keep using simulated mode.");
      }
      writeMode(app.getPath("userData"), mode);
      /* Audited like the kill switch and the venue switch: it decides whether
         this app can reach real money. */
      auditLog("app_mode_selected", { mode, effectiveFrom: "next launch" });
      return { ok: true as const, restartRequired: mode !== appMode() };
    }, "mode:set")
  );
}
