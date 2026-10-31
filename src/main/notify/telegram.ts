/**
 * Telegram delivery — the channel that reaches the owner when the app does not.
 *
 * Chosen over the notification-infrastructure category (Knock, Courier, Novu,
 * SuprSend) after checking it: those are built for **many recipients** —
 * preference centres, digests, per-user routing, in-app inboxes. There is one
 * recipient here. Telegram is a single HTTPS POST with a token, no dependency,
 * no account with a third party beyond the bot itself, and it arrives on a phone.
 *
 * **Zero new dependencies.** `fetch` is built in.
 *
 * The bot token and chat id go in the encrypted per-integration secret store —
 * the same `safeStorage`-backed vault as every other credential — so they never
 * cross IPC, never enter a log, and never reach a prompt.
 */
import { getSecret, hasSecret, type IntegrationAuthSpec } from "../security/integration-secrets";
import { appMode } from "../modes/app-mode";
import { isNetworkDisabled } from "../net-guard";
import { createLogger } from "../logger";

const log = createLogger("telegram");

export const TELEGRAM_ID = "telegram";

/**
 * Declared like any other integration, so the secret store validates the field
 * names and the settings surface can render presence without seeing values.
 */
export const TELEGRAM_AUTH: IntegrationAuthSpec = {
  integrationId: TELEGRAM_ID,
  scheme: "api_key",
  fields: [
    /* The token is the credential; the chat id is an address. Marking the id
       non-sensitive lets settings show it back, which matters — a wrong chat id
       fails silently from the owner's side otherwise. */
    { key: "bot_token", label: "Bot token", sensitive: true },
    { key: "chat_id", label: "Chat ID", sensitive: false },
  ],
};

export function telegramConfigured(): boolean {
  return hasSecret(TELEGRAM_ID, "bot_token") && hasSecret(TELEGRAM_ID, "chat_id");
}

export interface DeliveryResult {
  ok: boolean;
  /** Present on failure. Safe to store — never contains the token. */
  error?: string;
  /** True when the failure is permanent and retrying cannot help. */
  permanent?: boolean;
}

/**
 * Send one message.
 *
 * Returns a result rather than throwing: the outbox needs to distinguish "try
 * again later" from "this will never work", and an exception carries neither
 * distinction nor the ability to record it.
 */
export async function sendTelegram(title: string, body: string): Promise<DeliveryResult> {
  if (isNetworkDisabled()) {
    return { ok: false, error: "Network disabled in this process." };
  }
  const token = getSecret(TELEGRAM_ID, "bot_token");
  const chatId = getSecret(TELEGRAM_ID, "chat_id");
  if (!token || !chatId) {
    /* Permanent: retrying an unconfigured channel forever would burn attempts
       and then abandon a message that was never deliverable. */
    return { ok: false, error: "Telegram is not configured.", permanent: true };
  }

  /* Every message says which world it came from.
   *
   * This is the one place the titlebar badge cannot help: notifications exist
   * BECAUSE the owner is away, and away is exactly when they cannot glance at
   * the app to see which mode is running. Without it "ARB-USD triggered" reads
   * identically whether it was a simulation or real money — an ambiguous state,
   * delivered to a phone, about a trade. Simulated is what gets marked: a real
   * fill needs no qualifier, and an unlabelled message must never be the
   * simulated one. */
  const prefix = appMode() === "simulated" ? "[simulated] " : "";
  const text = body
    ? `*${escapeMarkdown(prefix + title)}*\n${escapeMarkdown(body)}`
    : escapeMarkdown(prefix + title);

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_notification: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) return { ok: true };

    /* 4xx that is not rate limiting means the token or chat id is wrong —
       retrying cannot fix it, and the owner needs to be told to fix the
       config rather than have the message quietly expire. */
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    /* The response body can echo the request; never let the token reach a log
       or the `last_error` column. */
    return { ok: false, error: `Telegram HTTP ${res.status}`, permanent };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("Telegram delivery failed.", msg);
    return { ok: false, error: redact(msg, token) };
  }
}

/** Telegram's MarkdownV2 reserves these; an unescaped one rejects the message. */
function escapeMarkdown(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

/** Belt and braces: a token in an error string would outlive the process. */
function redact(s: string, token: string): string {
  return token ? s.split(token).join("<token>") : s;
}
