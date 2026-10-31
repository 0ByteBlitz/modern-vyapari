/**
 * Sessions and the archive wind-down
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as sessionArchive from "../sessions/archive";
import * as sessions from "../sessions/service";
import { emitTo } from "../events/outbound";
import { venue, venueCapabilities } from "../integrations/venue/registry";
import { appMode } from "../modes/app-mode";
import { tradablePairs } from "./venue";
import { safe } from "./safe";

export function registerSessions(): void {
  /* ── Sessions (Phase 1) ─────────────────────────────────────── */
ipcMain.handle("sessions:list", (_e, includeArchived?: boolean) =>
    safe(() => sessions.listSessions(includeArchived ?? false), "sessions:list")
  );

ipcMain.handle("sessions:create", (_e, pair: string) =>
    safe(async () => {
      // Validate against the venue's live pair list (renderer filtering is
      // convenience only — main must not trust it). Fail open when the venue
      // config is unreachable (offline/setup-incomplete): regex still applies.
      try {
        /* The SAME universe the picker offers. Validating against the venue
           while the picker listed feed symbols is how simulated mode ended up
           offering pairs it then refused to create. */
        const tradable = await tradablePairs();
        const known = new Set(Object.keys(tradable).map((k) => k.replace("/", "-")));
        if (!known.has(pair)) {
          throw new Error(
            appMode() === "simulated"
              ? `${pair} has no analysis feed, so nothing could chart or trade it.`
              : `Pair ${pair} is not traded on ${venueCapabilities().displayName}`
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("not traded")) throw err;
        // venue unreachable — proceed with format-only validation
      }
      return sessions.createSession(pair);
    }, "sessions:create")
  );

ipcMain.handle("sessions:select", (_e, id: number | null) => safe(() => sessions.selectSession(id), "sessions:select"));

ipcMain.handle("sessions:getSelected", () => safe(() => sessions.getSelectedSession(), "sessions:getSelected"));

ipcMain.handle("sessions:getLast", () => safe(() => sessions.getLastSession(), "sessions:getLast"));

ipcMain.handle("sessions:setStatus", (_e, id: number, status: "active" | "paused" | "archived") =>
    safe(() => sessions.setSessionStatus(id, status), "sessions:setStatus")
  );

  /* Archiving is a wind-down, not a status flip — see sessions/archive.ts.
     The plan is computed here so the confirmation screen states facts. */
ipcMain.handle("sessions:archivePlan", (_e, id: number) =>
    safe(() => sessionArchive.planArchive(id), "sessions:archivePlan")
  );

ipcMain.handle("sessions:archive", (e, id: number) =>
    safe(
      () =>
        sessionArchive.archiveSession(id, (step, status, detail) => {
          /* Progress is pushed as each step really completes. This channel
             bypasses `safe()`, so it must never carry an internal message —
             `detail` is user-facing copy chosen at the throw site. */
          if (!e.sender.isDestroyed()) {
            emitTo(e.sender, "sessions:archiveStep", { sessionId: id, step, status, ...(detail ? { detail } : {}) });
          }
        }),
      "sessions:archive"
    )
  );
}
