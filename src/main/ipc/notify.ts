/**
 * Telegram and the notification outbox
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as chat from "../agent/chat";
import * as outbox from "../notify/outbox";
import { auditLog } from "../db/database";
import { saveSecret, clearSecret, getSecret, hasSecret } from "../security/integration-secrets";
import { sendTelegram, telegramConfigured, TELEGRAM_ID } from "../notify/telegram";
import { AppError } from "../../shared/errors";
import { safe } from "./safe";

export function registerNotify(): void {
  /* ── Notifications ──────────────────────────────────────────────
     The bot token NEVER crosses IPC back to the renderer — presence only,
     the same rule every other credential follows. The chat id is an address
     rather than a secret and is returned, because a wrong one fails silently
     from the owner's side and they need to be able to see what is stored. */
ipcMain.handle("notify:status", () =>
    safe(
      () => ({
        configured: telegramConfigured(),
        chatId: getSecret(TELEGRAM_ID, "chat_id"),
        stats: outbox.outboxStats(),
        /* Abandoned messages are surfaced, not swallowed: by definition the
           owner was never told about them any other way. */
        abandoned: outbox.abandoned(10).map((n) => ({
          kind: n.kind,
          title: n.title,
          attempts: n.attempts,
        })),
      }),
      "notify:status"
    )
  );

ipcMain.handle("notify:saveTelegram", (_e, botToken: string, chatId: string) =>
    safe(() => {
      const token = (botToken ?? "").trim();
      const chat = (chatId ?? "").trim();
      if (!chat) throw new AppError("VALIDATION", "Enter the chat ID.");
      /* The token field is write-only: it comes back blank even when one is
         stored, because the secret never crosses IPC. So a blank token means
         "leave the stored one alone", not "clear it" — otherwise changing the
         chat ID would be impossible without re-typing the token, which is what
         the first version demanded. Only insist on a token when there is none. */
      const alreadyHasToken = hasSecret(TELEGRAM_ID, "bot_token");
      if (!token && !alreadyHasToken) {
        throw new AppError("VALIDATION", "Enter the bot token from @BotFather.");
      }
      if (token) saveSecret(TELEGRAM_ID, "bot_token", token);
      saveSecret(TELEGRAM_ID, "chat_id", chat);
      /* Never log the token itself — the audit log outlives the process and
         ends up in bug reports. */
      auditLog("telegram_configured", { chatId: chat });
      return { ok: true as const };
    }, "notify:saveTelegram")
  );

ipcMain.handle("notify:clearTelegram", () =>
    safe(() => {
      clearSecret(TELEGRAM_ID, "bot_token");
      clearSecret(TELEGRAM_ID, "chat_id");
      auditLog("telegram_disconnected", {});
      return { ok: true as const };
    }, "notify:clearTelegram")
  );

  /* Sends immediately rather than through the outbox: this is a connectivity
     check, not an event, and queuing it would make a failure look like a
     delivery problem rather than a configuration one. */
ipcMain.handle("notify:test", async () =>
    safe(async () => {
      const res = await sendTelegram(
        "Modern Vyapari",
        "Notifications are working. You will get a message here when a plan triggers, expires or is invalidated."
      );
      return res.ok ? { ok: true as const } : { ok: false as const, reason: res.error ?? "Send failed." };
    }, "notify:test")
  );
}
