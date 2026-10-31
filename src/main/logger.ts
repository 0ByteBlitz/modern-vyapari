/**
 * Structured logging for the main process.
 *
 * Two audiences, two levels of detail:
 *   • The LOG FILE gets everything — stack traces, SQL, HTTP bodies, the lot.
 *     It lives on your machine and is what you read when something breaks.
 *   • The USER gets a short sentence with a code (see `shared/errors.ts`).
 *     Raw `err.message` used to go straight to the UI, which leaked SQLite
 *     text, absolute paths and venue API bodies into the interface.
 *
 * Not the audit log. `audit_log` records what the ENGINES DID and is evidence;
 * this records what the PROCESS SAW and is diagnostics. Keeping them apart
 * matters — a log full of HTTP noise would bury the record of a real order.
 *
 * Secrets are redacted on the way in, not on the way out: a key that reaches
 * the file is already leaked, since these files outlive the process and get
 * pasted into bug reports.
 */
import * as fs from "fs";
import * as path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keep this many rotated files. Enough to cover a weekend of unattended running. */
const MAX_FILES = 5;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB per file

let logDir = "";
let logFile = "";
let minLevel: LogLevel = process.env.NODE_ENV === "production" ? "info" : "debug";
let stream: fs.WriteStream | null = null;

/* ── Redaction ────────────────────────────────────────────────────────
   Belt and braces: these patterns cover every credential shape the app
   handles. If you add a new credential type, add its shape here FIRST. */
const REDACTIONS: { re: RegExp; replace: string }[] = [
  { re: /sk-ant-[A-Za-z0-9_-]+/g, replace: "sk-ant-[REDACTED]" },
  { re: /bb_(?:live|test)_[A-Za-z0-9_-]+/g, replace: "bb_[REDACTED]" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[REDACTED PRIVATE KEY]" },
  { re: /\b[A-Za-z0-9]{64}\b/g, replace: "[REDACTED-64]" }, // RevX API key shape
  { re: /("?(?:x-)?(?:api[-_]?key|authorization|x-bb-api-key|x-revx-api-key|x-revx-signature)"?\s*[:=]\s*)"?[^",\s}]+/gi, replace: '$1"[REDACTED]"' },
];

function redact(text: string): string {
  let out = text;
  for (const { re, replace } of REDACTIONS) out = out.replace(re, replace);
  return out;
}

/* ── File handling ───────────────────────────────────────────────────── */

function rotateIfNeeded(): void {
  try {
    if (!fs.existsSync(logFile)) return;
    if (fs.statSync(logFile).size < MAX_BYTES) return;

    stream?.end();
    stream = null;

    // vyapari.4.log is dropped; each file shifts up one.
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = path.join(logDir, `vyapari.${i}.log`);
      const to = path.join(logDir, `vyapari.${i + 1}.log`);
      if (fs.existsSync(from)) {
        if (i + 1 > MAX_FILES) fs.rmSync(from, { force: true });
        else fs.renameSync(from, to);
      }
    }
    fs.renameSync(logFile, path.join(logDir, "vyapari.1.log"));
  } catch {
    /* rotation must never break logging */
  }
}

function write(line: string): void {
  try {
    rotateIfNeeded();
    if (!stream) stream = fs.createWriteStream(logFile, { flags: "a" });
    stream.write(line + "\n");
  } catch {
    /* if the disk is full or locked, the console line below is all we get */
  }
}

/** Call once at startup, before anything that might log. */
export function initLogger(userDataPath: string): void {
  logDir = path.join(userDataPath, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  /* One file for both modes, deliberately — a single place to look when
     something went wrong, and the owner does not think in database files. But
     that makes the entries interleave across launches in different modes, so
     each line carries the mode. Without it "plan triggered" in the log is the
     same ambiguity the Telegram messages had. */
  logFile = path.join(logDir, "vyapari.log");

  log("info", "app", "Logger started", { logFile, minLevel });

  // A crash that vanishes silently is the worst kind for an app that runs
  // unattended — capture both, then let the default handling proceed.
  process.on("uncaughtException", (err) => {
    log("error", "process", "Uncaught exception", err);
  });
  process.on("unhandledRejection", (reason) => {
    log("error", "process", "Unhandled promise rejection", reason);
  });
}

export function getLogFilePath(): string {
  return logFile;
}

export function getLogDir(): string {
  return logDir;
}

/** Most recent lines, newest last. For the in-app diagnostics view. */
export function readRecentLogs(maxLines = 200): string[] {
  try {
    if (!fs.existsSync(logFile)) return [];
    const text = fs.readFileSync(logFile, "utf8");
    return text.split("\n").filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

/* ── Core ────────────────────────────────────────────────────────────── */

function serialiseDetail(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) {
    return ` ${detail.name}: ${detail.message}${detail.stack ? `\n${detail.stack}` : ""}`;
  }
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
}

export function log(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;

  const line = redact(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${serialiseDetail(detail)}`);

  // Console keeps working for `npm start`; the file is the durable record.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  if (logFile) write(line);
}

/** Scoped logger so call sites read as `logger.warn("...")`. */
export function createLogger(scope: string) {
  return {
    debug: (message: string, detail?: unknown) => log("debug", scope, message, detail),
    info: (message: string, detail?: unknown) => log("info", scope, message, detail),
    warn: (message: string, detail?: unknown) => log("warn", scope, message, detail),
    error: (message: string, detail?: unknown) => log("error", scope, message, detail),
  };
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}
