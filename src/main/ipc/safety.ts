/**
 * Kill switch and alerts
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import { alertEngine } from "../insights/alert-engine";
import { auditLog } from "../db/database";
import { binanceWS } from "../data/binance-ws";
import { emitTo } from "../events/outbound";
import { createLogger } from "../logger";
import { safe } from "./safe";

const ipcLog = createLogger("ipc");

export function registerSafety(): void {
  /* ── Emergency Kill Switch ───────────────────────────────── */
  /* Tripping the breaker is an order-affecting operator action, so it belongs in
     the audit log next to what the engines did — otherwise the record shows
     entries simply stopping with no stated cause. */
ipcMain.handle("killSwitch:trip", (_e, reason?: string) =>
    safe(() => {
      const { killSwitch } = require("./risk/kill-switch");
      killSwitch.trip(reason);
      auditLog("kill_switch_tripped", { reason: killSwitch.getReason() });
      return { active: true, reason: killSwitch.getReason() };
    }, "killSwitch:trip")
  );

ipcMain.handle("killSwitch:reset", () =>
    safe(() => {
      const { killSwitch } = require("./risk/kill-switch");
      killSwitch.reset();
      auditLog("kill_switch_reset", {});
      return { active: false, reason: "" };
    }, "killSwitch:reset")
  );

ipcMain.handle("killSwitch:status", () =>
    safe(() => {
      const { killSwitch } = require("./risk/kill-switch");
      return { active: killSwitch.isTripped(), reason: killSwitch.getReason() };
    }, "killSwitch:status")
  );

  /* ── Phase 2: Alerts ──────────────────────────────────────── */
ipcMain.handle("alerts:list", (_e, sessionId?: number) =>
    safe(() => alertEngine.getSessionAlerts(sessionId), "alerts:list")
  );

ipcMain.handle("alerts:remove", (_e, alertId: number) =>
    safe(() => {
      alertEngine.removeAlert(alertId);
      return { ok: true };
    }, "alerts:remove")
  );

  /* Alerts are loaded and wired to the live stream HERE rather than lazily in a
     handler: they must be watching whether or not the renderer ever asks about
     them. `alertEngine.onCandle` existed for a long time with nothing calling
     it, so an alert could be created and simply sit there for ever. */
  // Initialize alert engine (load persisted alerts + re-establish their
  // live Binance subscriptions), then wire it to the actual candle stream
  // and push triggers to the renderer.
  try {
    alertEngine.loadFromDb();
  } catch (err) {
    ipcLog.error("alert engine load failed", err);
  }

  binanceWS.onCandle((symbol, intervalMin, candle) => {
    alertEngine.onCandle(symbol, intervalMin, {
      timestamp: candle.start,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });
  });

  alertEngine.onAlert((event) => {
    const { mainWindow } = require("../main");
    if (mainWindow && !mainWindow.isDestroyed()) {
      emitTo(mainWindow.webContents, "alerts:triggered", event);
      emitTo(mainWindow.webContents, "data:updated", { kind: "alert" });
      emitTo(mainWindow.webContents, "data:updated", { kind: "journal" });
    }
  });
}
