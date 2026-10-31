/**
 * Paper positions and equity
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as paperPositions from "../paper/positions-service";
import { getPaperAccount, resetPaperAccount } from "../paper/account";
import { AppError } from "../../shared/errors";
import { auditLog } from "../db/database";
import { safe } from "./safe";

export function registerPaper(): void {
  /* ── Phase 3: Paper positions (read-only) ─────────────────── */
ipcMain.handle("paper:listPositions", (_e, sessionId: number, strategyId?: number) =>
    safe(() => paperPositions.listPaperPositions(sessionId, { strategyId }), "paper:listPositions")
  );

ipcMain.handle("paper:stats", (_e, sessionId: number) =>
    safe(() => paperPositions.getPaperStats(sessionId), "paper:stats")
  );

ipcMain.handle("paper:equityCurve", (_e, sessionId: number) =>
    safe(() => paperPositions.getPaperEquityCurve(sessionId), "paper:equityCurve")
  );

ipcMain.handle("paper:strategyComparisons", (_e, sessionId: number) =>
    safe(() => paperPositions.getStrategyComparisons(sessionId), "paper:strategyComparisons")
  );

  /* The one paper balance. Cash is an account fact, not a session one — see
     `paper/account.ts` for what the per-session version cost. */
  ipcMain.handle("paper:account", () => safe(() => getPaperAccount(), "paper:account"));

  ipcMain.handle("paper:setBalance", (_e, startingBalance: number) =>
    safe(() => {
      if (!Number.isFinite(startingBalance) || startingBalance <= 0) {
        throw new AppError("VALIDATION", "Enter a starting balance above zero.");
      }
      /* Audited: it resets the figure every return is measured against, so a
         changed balance silently rewriting the equity curve is exactly what
         should be traceable. */
      resetPaperAccount(startingBalance);
      auditLog("paper_account_reset", { startingBalance });
      return { ok: true as const };
    }, "paper:setBalance")
  );
}
