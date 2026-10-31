/**
 * Indicators, CVD and the volume profile
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as orderflow from "../insights/orderflow-service";
import { computeIndicatorBatch, listIndicators } from "../insights/indicators";
import { safe } from "./safe";

export function registerInsights(): void {
  /* ── Order flow: CVD + volume profile (S1-4) ──────────────── */
  /* Computed in main and rendered by the chart, never recomputed client-side —
     the chart must draw the numbers the engine would decide on. */
ipcMain.handle(
    "insights:cvd",
    (_e, symbol: string, intervalMin: number, opts?: { anchorMs?: number; limit?: number }) =>
      safe(() => orderflow.getCvdSeries(symbol, intervalMin, opts ?? {}), "insights:cvd")
  );

ipcMain.handle("insights:volumeProfile", (_e, req: orderflow.VolumeProfileRequest) =>
    safe(() => orderflow.getVolumeProfile(req), "insights:volumeProfile")
  );

  /* ── Phase 2: Indicators ──────────────────────────────────── */
ipcMain.handle("indicators:list", () => safe(() => listIndicators(), "indicators:list"));

ipcMain.handle("indicators:compute", (_e, symbol: string, intervalMin: number, indicators: any[], limit?: number) =>
    safe(() => computeIndicatorBatch(symbol, intervalMin, indicators, { limit: limit ?? 100 }), "indicators:compute")
  );
}
