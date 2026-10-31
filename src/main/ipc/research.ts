/**
 * Chart drawings and level references
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as levelRefs from "../plans/level-reference-service";
import * as queries from "../db/queries";
import { safe } from "./safe";

export function registerResearch(): void {
  /* ── Research: chart drawings ─────────────────────────────── */
ipcMain.handle("drawings:list", (_e, symbol: string, intervalMin?: number) =>
    safe(() => queries.listDrawings(symbol, intervalMin), "drawings:list")
  );

ipcMain.handle("drawings:save", (_e, d: Parameters<typeof queries.saveDrawing>[0]) =>
    safe(() => queries.saveDrawing(d), "drawings:save")
  );

  /* Deleting a drawing detaches any reference promoted from it FIRST, so the
     meaning survives the ink. A plan may already be armed against that level;
     losing it because the chart was tidied would be exactly the kind of silent
     failure this project keeps closing. */
ipcMain.handle("drawings:delete", (_e, id: number) =>
    safe(() => {
      levelRefs.detachDrawing(id);
      return queries.deleteDrawing(id);
    }, "drawings:delete")
  );

ipcMain.handle("drawings:clear", (_e, symbol: string) => safe(() => queries.clearDrawings(symbol), "drawings:clear"));

  /* ── Research: plan references (S2-2) ─────────────────────────
     The semantic layer over drawings. The chart renders from these and the
     engine resolves from them — one definition, two consumers. */
ipcMain.handle("levels:list", (_e, symbol: string, intervalMin?: number) =>
    safe(() => levelRefs.listLevelReferences(symbol, intervalMin), "levels:list")
  );

ipcMain.handle(
    "levels:promote",
    (_e, drawingId: number, opts?: Parameters<typeof levelRefs.promoteDrawingToReference>[1]) =>
      safe(() => levelRefs.promoteDrawingToReference(drawingId, opts ?? {}), "levels:promote")
  );

ipcMain.handle("levels:delete", (_e, id: number) =>
    safe(() => levelRefs.deleteLevelReference(id), "levels:delete")
  );
}
