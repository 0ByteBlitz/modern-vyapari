/**
 * Scenario plans — the product
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as planService from "../plans/plan-service";
import { dryRunPlan } from "../plans/plan-dryrun";
import { AppError } from "../../shared/errors";
import { buildCalibration } from "../plans/calibration";
import { safe } from "./safe";

export function registerPlans(): void {
  /* ── Scenario plans (S3-1 / S3-2) ─────────────────────────────
     The gate lives in main (`validatePlan`), never in the renderer: a UI that
     enforced it would be a second implementation of the rule that decides
     whether unvalidated conviction reaches real money. */
ipcMain.handle("plans:list", (_e, sessionId: number, states?: string[]) =>
    safe(() => planService.listPlans(sessionId, states as never), "plans:list")
  );

ipcMain.handle("plans:get", (_e, id: number) => safe(() => planService.getPlan(id), "plans:get"));

ipcMain.handle("plans:create", (_e, input: Parameters<typeof planService.createPlan>[0]) =>
    safe(() => planService.createPlan(input), "plans:create")
  );

ipcMain.handle("plans:update", (_e, id: number, input: Parameters<typeof planService.updatePlan>[1]) =>
    safe(() => planService.updatePlan(id, input), "plans:update")
  );

ipcMain.handle("plans:delete", (_e, id: number) => safe(() => planService.deletePlan(id), "plans:delete"));

  /* Returns the gate's errors/warnings AND the resolved level values, so the
     UI can show concrete numbers before committing rather than after. */
ipcMain.handle("plans:arm", (_e, id: number) => safe(() => planService.armPlan(id), "plans:arm"));

  /* Structural, never statistical: does this plan fire at all, does it fire on
     every bar, is a branch unreachable. There is no PnL in the reply and the
     type has nowhere to put one — a plan is never backtested. */
ipcMain.handle("plans:dryRun", (_e, id: number) =>
    safe(() => {
      const plan = planService.getPlan(id);
      if (!plan) throw new AppError("NOT_FOUND", "That plan no longer exists.");
      return dryRunPlan(plan);
    }, "plans:dryRun")
  );

ipcMain.handle("plans:transition", (_e, id: number, to: string, reason?: string) =>
    safe(() => planService.transitionPlan(id, to as never, reason), "plans:transition")
  );

  /* Statistics about the PLANNER, not about a plan — grouped by assumption tag,
     never by plan. Cross-session by default: the same thesis type recurs on
     different pairs, and that is the whole unit of evidence. */
  ipcMain.handle("plans:calibration", (_e, sessionId?: number) =>
    safe(() => buildCalibration(sessionId), "plans:calibration")
  );
}
