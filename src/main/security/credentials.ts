import * as fs from "fs";
import * as path from "path";
import { generateEd25519KeyPair } from "../revx/signing";
import { electronCipher, readEncrypted, writeEncrypted, type SecretCipher } from "./cipher";
import { createLogger } from "../logger";

/**
 * Credential storage:
 * - Ed25519 private key: encrypted at rest via Electron safeStorage (DPAPI on
 *   Windows, Keychain on macOS, libsecret on Linux) — same standard as the
 *   API keys below. Older versions stored it as a raw PEM file with POSIX
 *   chmod 0600, which is largely cosmetic on Windows/NTFS: Node's fs `mode`
 *   only toggles the read-only DOS attribute there, it does not restrict
 *   other accounts on the machine the way it does on Linux/macOS. Any
 *   leftover plaintext file is transparently migrated to the encrypted
 *   format (see migrateLegacyPrivateKeyIfNeeded) and removed.
 * - API key / Anthropic key: encrypted with OS keychain via Electron safeStorage
 * Keys never cross IPC to the renderer; only the public key and boolean status do.
 *
 * Every read and write is async (see cipher.ts): Electron 46 removes the
 * synchronous safeStorage methods. `has*` checks stay synchronous because they
 * only test that a file exists — no secret is decrypted to answer them.
 */

const log = createLogger("credentials");

let credentialsDir = "";
let cipher: SecretCipher = electronCipher;

export function initCredentials(userDataPath: string): void {
  credentialsDir = path.join(userDataPath, "credentials");
  fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  /* Eager, so a legacy plaintext key does not sit on disk any longer than
     necessary; anything that needs the key awaits the same promise. */
  void migrateLegacyPrivateKeyIfNeeded().catch((err) => log.error("Private key migration failed", err));
}

/** Test seam. Never called in production code. */
export function configureCredentialsForTesting(dir: string, testCipher: SecretCipher): void {
  credentialsDir = dir;
  fs.mkdirSync(credentialsDir, { recursive: true });
  cipher = testCipher;
  migration = null;
}

const privateKeyPath = (): string => path.join(credentialsDir, "private.key.enc");
const legacyPrivatePemPath = (): string => path.join(credentialsDir, "private.pem");
const publicPemPath = (): string => path.join(credentialsDir, "public.pem");
const apiKeyPath = (): string => path.join(credentialsDir, "apikey.bin");
const anthropicKeyPath = (): string => path.join(credentialsDir, "anthropic.bin");
const browserbaseKeyPath = (): string => path.join(credentialsDir, "browserbase.bin");

const read = (file: string): Promise<string> =>
  readEncrypted(cipher, file, (err) => log.warn("Key rotated but re-encrypting the stored copy failed", err));

function refusal(what: string): string {
  return `OS encryption (safeStorage) unavailable — refusing to store ${what} in plaintext`;
}

/** One-time migration from the legacy plaintext private.pem to the encrypted
 *  format. Memoised, so concurrent callers share one migration instead of
 *  racing to write the same file. No-ops once migrated or if there was never a
 *  legacy file; if encryption is unavailable it leaves the file and retries on
 *  the next call. */
let migration: Promise<void> | null = null;
function migrateLegacyPrivateKeyIfNeeded(): Promise<void> {
  if (!migration) {
    migration = (async () => {
      if (fs.existsSync(privateKeyPath())) return;
      if (!fs.existsSync(legacyPrivatePemPath())) return;
      if (!(await cipher.isAvailable())) return;
      const pem = fs.readFileSync(legacyPrivatePemPath(), "utf-8");
      await writeEncrypted(cipher, privateKeyPath(), pem, refusal("the private key"));
      fs.rmSync(legacyPrivatePemPath());
    })().finally(() => {
      migration = null;
    });
  }
  return migration;
}

export function hasKeyPair(): boolean {
  const hasPrivate = fs.existsSync(privateKeyPath()) || fs.existsSync(legacyPrivatePemPath());
  return hasPrivate && fs.existsSync(publicPemPath());
}

export function hasApiKey(): boolean {
  return fs.existsSync(apiKeyPath());
}

export function hasAnthropicApiKey(): boolean {
  return fs.existsSync(anthropicKeyPath());
}

/** Generates a keypair if none exists. Returns the public key PEM (safe to display). */
export async function ensureKeyPair(): Promise<string> {
  await migrateLegacyPrivateKeyIfNeeded();
  if (!hasKeyPair()) {
    const pair = generateEd25519KeyPair();
    await writeEncrypted(cipher, privateKeyPath(), pair.privateKeyPem, refusal("the private key"));
    fs.writeFileSync(publicPemPath(), pair.publicKeyPem, { mode: 0o644 });
  }
  return fs.readFileSync(publicPemPath(), "utf-8");
}

export function getPublicKeyPem(): string | null {
  return hasKeyPair() ? fs.readFileSync(publicPemPath(), "utf-8") : null;
}

/** Main-process only. Never expose via IPC. */
export async function getPrivateKeyPem(): Promise<string> {
  await migrateLegacyPrivateKeyIfNeeded();
  if (!hasKeyPair()) throw new Error("No keypair generated yet");
  if (fs.existsSync(legacyPrivatePemPath()) && !fs.existsSync(privateKeyPath())) {
    // safeStorage was unavailable at migration time — fall back rather than crash.
    return fs.readFileSync(legacyPrivatePemPath(), "utf-8");
  }
  return read(privateKeyPath());
}

export async function saveApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!/^[A-Za-z0-9]{64}$/.test(trimmed)) {
    throw new Error("API key must be a 64-character alphanumeric string");
  }
  await writeEncrypted(cipher, apiKeyPath(), trimmed, refusal("API key"));
}

/** Main-process only. Never expose via IPC. */
export async function getApiKey(): Promise<string> {
  if (!hasApiKey()) throw new Error("API key not configured");
  return read(apiKeyPath());
}

export async function saveAnthropicApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith("sk-ant-")) {
    throw new Error("Invalid Anthropic API key format");
  }
  await writeEncrypted(cipher, anthropicKeyPath(), trimmed, refusal("API key"));
}

export async function getAnthropicApiKey(): Promise<string | null> {
  if (!hasAnthropicApiKey()) return process.env.ANTHROPIC_API_KEY || null;
  return read(anthropicKeyPath());
}

/* ── Browserbase (cloud browser for agent web research) ──────────────── */

export function hasBrowserbaseKey(): boolean {
  return fs.existsSync(browserbaseKeyPath()) || Boolean(process.env.BROWSERBASE_API_KEY);
}

export async function saveBrowserbaseKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith("bb_")) {
    throw new Error("Browserbase API keys start with 'bb_'");
  }
  await writeEncrypted(cipher, browserbaseKeyPath(), trimmed, refusal("the Browserbase key"));
}

/** Main-process only. Never expose via IPC, never log, never put in a prompt. */
export async function getBrowserbaseKey(): Promise<string | null> {
  if (!fs.existsSync(browserbaseKeyPath())) return process.env.BROWSERBASE_API_KEY || null;
  return read(browserbaseKeyPath());
}

export function clearBrowserbaseKey(): void {
  if (fs.existsSync(browserbaseKeyPath())) fs.rmSync(browserbaseKeyPath());
}
