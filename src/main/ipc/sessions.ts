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
import { emit, emitTo } from "../events/outbound";
import { venue, venueCapabilities } from "../integrations/venue/registry";
import { appMode } from "../modes/app-mode";
import { tradablePairs } from "./venue";
import { safe } from "./safe";
import { AppError } from "../../shared/errors";

export function registerSessions(): void {
  /* ── Sessions (Phase 1) ─────────────────────────────────────── */
ipcMain.handle("sessions:list", (_e, includeArchived?: boolean) =>
    safe(() => sessions.listSessions(includeArchived ?? false), "sessions:list")
  );

ipcMain.handle("sessions:create", (_e, pair: string) =>
    safe(async () => {
      // Validate against the venue's live pair list (renderer filtering is
      // convenience only — main must not trust it). Fail open when the list
      // is unreachable (offline/setup-incomplete): the format check still applies.
      /* The SAME universe the picker offers. Validating against the venue
         while the picker listed feed symbols is how simulated mode ended up
         offering pairs it then refused to create. */
      let known: Set<string> | null = null;
      try {
        const tradable = await tradablePairs();
        known = new Set(Object.keys(tradable).map((k) => k.replace("/", "-")));
      } catch {
        // unreachable — proceed with format-only validation
      }
      /* Refused OUTSIDE the try. The refusal used to be thrown inside it and
         rethrown only if its message contained "not traded" — the simulated
         wording ("has no analysis feed") didn't, so it was swallowed and the
         pair was created anyway. (2026-11-02) */
      if (known && !known.has(pair)) {
        throw new AppError(
          "VALIDATION",
          appMode() === "simulated"
            ? `${pair} has no analysis feed, so nothing could chart or trade it.`
            : `${pair} isn't traded on ${venueCapabilities().displayName}.`
        );
      }
      return sessions.createSession(pair);
    }, "sessions:create")
  );

ipcMain.handle("sessions:select", (_e, id: number | null) => safe(() => sessions.selectSession(id), "sessions:select"));

ipcMain.handle("sessions:getSelected", () => safe(() => sessions.getSelectedSession(), "sessions:getSelected"));

ipcMain.handle("sessions:getLast", () => safe(() => sessions.getLastSession(), "sessions:getLast"));

ipcMain.handle("sessions:setStatus", (_e, id: number, status: "active" | "paused" | "archived") =>
    safe(() => {
      const result = sessions.setSessionStatus(id, status);
      /* Pausing changes whether a plan's trigger can open a position, and a
         plan's watch line is open on other surfaces than the one that paused. */
      emit("data:updated", { kind: "session" });
      return result;
    }, "sessions:setStatus")
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
