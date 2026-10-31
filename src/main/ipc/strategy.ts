/**
 * Strategies and backtests — FROZEN (see CLAUDE.md)
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as backtestService from "../backtest/backtest-service";
import * as strategyService from "../strategy/strategy-service";
import { safe } from "./safe";

export function registerStrategy(): void {
  /* ── Phase 2: Strategies ──────────────────────────────────── */
ipcMain.handle("strategies:list", (_e, sessionId: number) =>
    safe(() => strategyService.listStrategies(sessionId), "strategies:list")
  );

ipcMain.handle("strategies:get", (_e, id: number) =>
    safe(() => strategyService.getStrategy(id), "strategies:get")
  );

ipcMain.handle("strategies:setState", (_e, id: number, state: string) =>
    safe(() => strategyService.setStrategyState(id, state as any), "strategies:setState")
  );

ipcMain.handle("strategies:delete", (_e, id: number) =>
    safe(() => {
      strategyService.deleteStrategy(id);
      return { ok: true };
    }, "strategies:delete")
  );

  /* ── Phase 2: Backtests ───────────────────────────────────── */
ipcMain.handle("backtests:list", (_e, sessionId: number) =>
    safe(() => backtestService.listBacktests(sessionId), "backtests:list")
  );

ipcMain.handle("backtests:get", (_e, id: number) =>
    safe(() => backtestService.getBacktestResult(id), "backtests:get")
  );
}
