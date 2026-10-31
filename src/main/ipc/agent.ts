/**
 * Chat, agent tools, and what the Research surface is showing
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as chat from "../agent/chat";
import * as toolRegistry from "../agent/tool-registry";
import { setResearchView, clearResearchView } from "../agent/research-view";
import { createLogger } from "../logger";
import { emitError } from "../events/outbound";
import { buildUsageReport } from "../agent/usage";
import { safe } from "./safe";

const ipcLog = createLogger("ipc");

export function registerAgent(): void {
  /* The Research surface reports what it's showing so the agent's chart
     tools read the same view the user sees, rather than a hardcoded default. */
ipcMain.on("research:view", (_e, v: { symbol: string; intervalMin: number; bounds: { x: number; y: number; width: number; height: number } | null }) => {
    setResearchView(v);
  });

ipcMain.on("research:closed", () => clearResearchView());

  /* ── Chat (Phase 1) ─────────────────────────────────────────────── */
ipcMain.handle("chat:history", (_e, sessionId: number) => safe(() => chat.getChatHistory(sessionId), "chat:history"));

ipcMain.handle("chat:clear", (_e, sessionId: number) => safe(() => chat.clearChatHistory(sessionId), "chat:clear"));

ipcMain.handle("chat:compact", (_e, sessionId: number) => safe(() => chat.compactChatHistory(sessionId), "chat:compact"));

ipcMain.handle("chat:models", () => safe(() => chat.listAiModels(), "chat:models"));

  /* Agent tool switches. None of these can place an order — the catalogue holds
     no order tool — so the worst a switch does is make the agent less capable. */
ipcMain.handle("agent:tools", (_e, model?: string) =>
    safe(() => toolRegistry.listTools(model ? chat.unsupportedToolsFor(model) : []), "agent:tools")
  );

ipcMain.handle("agent:setTool", (_e, id: string, enabled: boolean) =>
    safe(() => {
      toolRegistry.setToolEnabled(id, enabled);
      return { ok: true as const };
    }, "agent:setTool")
  );

ipcMain.handle("agent:resetTools", () =>
    safe(() => {
      toolRegistry.resetTools();
      return { ok: true as const };
    }, "agent:resetTools")
  );

ipcMain.handle("usage:report", () => safe(() => buildUsageReport(), "usage:report"));

ipcMain.on("chat:send", (e, sessionId: number, messages: any[], params?: { model: string; effort: string; capabilities?: { adaptive: boolean; extended: boolean } }) => {
    /* Fire and forget over `on`, not `handle` — the reply streams back on its
       own channels rather than resolving this call.
       
       Which makes this catch load-bearing. It used to ONLY log, so a throw
       before the streaming loop's own try/catch (a bad session read, a failure
       building the context) went to the main-process log and nowhere else: the
       renderer sat with `isStreaming` true, the composer disabled, and no
       error — indistinguishable from "the agent just doesn't answer". A
       fire-and-forget call still owes the caller a failure. */
    chat
      .sendChatMessage(sessionId, messages, params || { model: "claude-3-5-sonnet-latest", effort: "high" }, e.sender)
      .catch((err) => {
        ipcLog.error("chat:send failed", err);
        emitError(e.sender, "chat:error", err);
      });
  });
}
