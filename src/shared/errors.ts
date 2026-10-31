/**
 * The error contract between main and renderer.
 *
 * Rule: **the renderer never sees an internal error message.** It gets a
 * `code` and a short sentence written for a human. The full error — stack,
 * SQL, HTTP body, file path — goes to the log file only.
 *
 * Why this matters in this app specifically:
 *   • Venue and Anthropic responses can echo request material back in error
 *     bodies; surfacing those verbatim risks putting credentials on screen.
 *   • SQLite messages leak table and column names, and absolute paths leak
 *     the user's directory layout.
 *   • A wall of stack trace in the UI teaches you nothing about what to do
 *     next, which is the only thing an error message is for.
 *
 * Type-only + pure functions: this file compiles into both bundles.
 */

export type ErrorCode =
  | "NETWORK"           // couldn't reach a remote service
  | "VENUE"             // Revolut X said no
  | "MARKET_DATA"       // Binance / analysis feed problem
  | "AI"                // Anthropic API problem
  | "CREDENTIALS"       // missing, malformed, or rejected key
  | "NOT_FOUND"         // asked for something that doesn't exist
  | "VALIDATION"        // bad input (usually the user's, sometimes ours)
  | "DATABASE"          // local storage failure
  | "UNSUPPORTED"       // deliberately not allowed (e.g. non-USD analysis)
  | "NOT_IMPLEMENTED"   // not built yet — distinct from "not allowed"
  | "INTERNAL";         // anything we didn't anticipate

export interface UserFacingError {
  /** Stable, machine-readable. Safe to branch on in the UI. */
  code: ErrorCode;
  /** One sentence, plain language, no internals. Safe to render. */
  message: string;
  /** Where to look, when the log file would actually help. */
  hint?: string;
}

/** Default copy per code. Deliberately short: an error should say what
 *  happened and what to do, not narrate the implementation. */
const MESSAGES: Record<ErrorCode, { message: string; hint?: string }> = {
  NETWORK: {
    message: "Couldn't reach the network.",
    hint: "Check your connection — charts and balances need it.",
  },
  /* Venue-neutral wording: this file compiles into both bundles and cannot
     reach the adapter registry, so naming one exchange here would go stale the
     moment a second adapter exists. */
  VENUE: {
    message: "The exchange rejected the request.",
    hint: "If this repeats, check your API key in Settings.",
  },
  MARKET_DATA: {
    message: "Market data is unavailable right now.",
    hint: "Charts may be stale until this clears.",
  },
  AI: {
    message: "The AI service didn't respond.",
    hint: "Check your Anthropic key and usage limits in Settings.",
  },
  CREDENTIALS: {
    message: "Credentials are missing or invalid.",
    hint: "Add or replace the key in Settings › Credentials.",
  },
  NOT_FOUND: { message: "That item no longer exists." },
  VALIDATION: { message: "That input isn't valid." },
  DATABASE: {
    message: "Couldn't read or write local data.",
    hint: "Details are in the log file.",
  },
  UNSUPPORTED: { message: "That isn't supported." },
  /* Separate from UNSUPPORTED on purpose: "not built yet" and "deliberately not
     allowed" are different facts, and a stub that borrows the wrong one reads as
     a permanent refusal instead of missing work. */
  NOT_IMPLEMENTED: { message: "That part of the app isn't built yet." },
  INTERNAL: {
    message: "Something went wrong.",
    hint: "Details are in the log file (Settings › Diagnostics).",
  },
};

/**
 * An error whose user-facing text is deliberate.
 *
 * Throw this when the message is genuinely useful to the user — a validation
 * failure, an unsupported pair. Everything else should throw normally and be
 * classified by `toUserFacing`.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, userMessage?: string, options?: { cause?: unknown; hint?: string; internal?: string }) {
    // `message` is the INTERNAL text — it goes to the log, never to the UI.
    super(options?.internal ?? userMessage ?? MESSAGES[code].message);
    this.name = "AppError";
    this.code = code;
    this.userMessage = userMessage ?? MESSAGES[code].message;
    this.hint = options?.hint ?? MESSAGES[code].hint;
    if (options?.cause) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Classify an unknown error by inspecting it — used when we didn't throw it. */
function classify(err: unknown): ErrorCode {
  const text = (err instanceof Error ? `${err.name} ${err.message}` : String(err)).toLowerCase();

  if (/enotfound|econnrefused|etimedout|econnreset|network|fetch failed|getaddrinfo/.test(text)) return "NETWORK";
  if (/sqlite|database|no such table|constraint/.test(text)) return "DATABASE";
  if (/api key|unauthorized|401|403|invalid signature|credential/.test(text)) return "CREDENTIALS";
  if (/anthropic|claude|rate.?limit|overloaded/.test(text)) return "AI";
  if (/binance|klines|analysis feed/.test(text)) return "MARKET_DATA";
  if (/revolut|revx/.test(text)) return "VENUE";
  if (/not found|no such|missing/.test(text)) return "NOT_FOUND";
  if (/invalid|must be|expected|unsupported/.test(text)) return "VALIDATION";
  return "INTERNAL";
}

/**
 * Convert any thrown value into something safe to send to the renderer.
 * The caller is responsible for logging the original first.
 */
export function toUserFacing(err: unknown): UserFacingError {
  if (err instanceof AppError) {
    return { code: err.code, message: err.userMessage, ...(err.hint ? { hint: err.hint } : {}) };
  }
  const code = classify(err);
  const { message, hint } = MESSAGES[code];
  return { code, message, ...(hint ? { hint } : {}) };
}

/** Type guard for the renderer's `Result<T>` union. */
export function isUserFacingError(v: unknown): v is UserFacingError {
  return typeof v === "object" && v !== null && "code" in v && "message" in v;
}
