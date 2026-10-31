/**
 * SELECT-only read models for the UI surfaces
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as queries from "../db/queries";
import { safe } from "./safe";

export function registerReadmodels(): void {
  /* ── Phase 3: read models for the redesigned surfaces ─────── */
ipcMain.handle("orders:list", (_e, sessionId: number, limit?: number) =>
    safe(() => queries.listOrders(sessionId, limit), "orders:list")
  );

ipcMain.handle("orders:approve", (_e, orderId: number) =>
    safe(() => {
      const db = require("./db/database").getDb();
      db.prepare(`UPDATE orders SET status = 'approved', updated_at = ? WHERE id = ?`).run(Date.now(), orderId);
      return { success: true };
    }, "orders:approve")
  );

ipcMain.handle("orders:reject", (_e, orderId: number) =>
    safe(() => {
      const db = require("./db/database").getDb();
      db.prepare(`UPDATE orders SET status = 'rejected', updated_at = ? WHERE id = ?`).run(Date.now(), orderId);
      return { success: true };
    }, "orders:reject")
  );

ipcMain.handle("journal:list", (_e, sessionId: number, opts?: { kind?: string; query?: string; limit?: number }) =>
    safe(() => queries.listJournal(sessionId, opts ?? {}), "journal:list")
  );

ipcMain.handle("journal:counts", (_e, sessionId: number) => safe(() => queries.journalCounts(sessionId), "journal:counts"));

ipcMain.handle("activity:list", (_e, limit?: number) => safe(() => queries.listActivity(limit), "activity:list"));

ipcMain.handle("portfolio:summary", (_e, includeArchived?: boolean) =>
    safe(() => queries.portfolioSummary(includeArchived ?? false), "portfolio:summary")
  );
}
