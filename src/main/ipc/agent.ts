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
import { isLocked } from "../security/app-lock";
import { AppError } from "../../shared/errors";
import { getSelectedSessionId } from "../sessions/service";
import { buildUsageReport, setDailyLimitUsd } from "../agent/usage";
import { reviewModelStatus, setReviewModel } from "../agent/review";
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
ipcMain.handle("chat:history", (_e, sessionId: number | null) => safe(() => chat.getChatHistory(sessionId), "chat:history"));

  /* Is a reply still being written in this conversation? A remounted chat
     panel asks, so it shows "Thinking…" rather than an open composer. */
ipcMain.handle("chat:busy", (_e, sessionId: number | null) => safe(() => chat.isChatBusy(sessionId), "chat:busy"));

ipcMain.handle("chat:clear", (_e, sessionId: number | null) => safe(() => chat.clearChatHistory(sessionId), "chat:clear"));

ipcMain.handle("chat:compact", (_e, sessionId: number | null) => safe(() => chat.compactChatHistory(sessionId), "chat:compact"));

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

  /* The daily AI spending limit, in USD; null clears it. */
ipcMain.handle("usage:setDailyLimit", (_e, limit: number | null) =>
    safe(() => {
      setDailyLimitUsd(limit);
      const { backgroundScheduler } = require("../services/scheduler") as typeof import("../services/scheduler");
      void backgroundScheduler.retryPendingReviews();
      return { ok: true as const };
    }, "usage:setDailyLimit")
  );

  /* Which model writes post-trade reviews. Null returns to the provider's fast
     model; the status says which one will actually run. */
ipcMain.handle("agent:reviewModel", () => safe(() => reviewModelStatus(), "agent:reviewModel"));

ipcMain.handle("agent:setReviewModel", (_e, model: string | null) =>
    safe(() => {
      setReviewModel(model);
      return { ok: true as const };
    }, "agent:setReviewModel")
  );

ipcMain.on("chat:send", (e, sessionId: number | null, messages: any[], params?: { model: string; effort: string; capabilities?: { adaptive: boolean; extended: boolean } }) => {
    /* Fire and forget over `on`, not `handle` — the reply streams back on its
       own channels rather than resolving this call.
       
       Which makes this catch load-bearing. It used to ONLY log, so a throw
       before the streaming loop's own try/catch (a bad session read, a failure
       building the context) went to the main-process log and nowhere else: the
       renderer sat with `isStreaming` true, the composer disabled, and no
       error — indistinguishable from "the agent just doesn't answer". A
       fire-and-forget call still owes the caller a failure. */
    /* `on`, so `safe()` never sees it: the app lock is checked here instead. */
    if (isLocked()) {
      emitError(e.sender, "chat:error", new AppError("LOCKED"), { conversation: sessionId ? sessionId : "general" });
      return;
    }
    /* A session's agent runs only for the session that is open. The chat
       drawer is the one way a person starts a turn, and it exists only on the
       open session's surfaces; a turn for any other session was started by
       something that is not the owner at that screen, and would draft plans
       they never saw being drafted. A reply that outlives a session switch is
       unaffected — this checks the start of a turn, not its end. */
    if (sessionId && sessionId !== getSelectedSessionId()) {
      emitError(
        e.sender,
        "chat:error",
        new AppError("UNSUPPORTED", "That session isn't open.", { hint: "Open it to talk to its agent." }),
        { conversation: sessionId }
      );
      return;
    }
    chat
      .sendChatMessage(sessionId, messages, params || { model: "claude-3-5-sonnet-latest", effort: "high" }, e.sender)
      .catch((err) => {
        ipcLog.error("chat:send failed", err);
        emitError(e.sender, "chat:error", err, { conversation: sessionId ? sessionId : "general" });
      });
  });
}
