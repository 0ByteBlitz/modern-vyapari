import { safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { generateEd25519KeyPair } from "../revx/signing";

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
 */

let credentialsDir = "";

export function initCredentials(userDataPath: string): void {
  credentialsDir = path.join(userDataPath, "credentials");
  fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  migrateLegacyPrivateKeyIfNeeded();
}

const privateKeyPath = (): string => path.join(credentialsDir, "private.key.enc");
const legacyPrivatePemPath = (): string => path.join(credentialsDir, "private.pem");
const publicPemPath = (): string => path.join(credentialsDir, "public.pem");
const apiKeyPath = (): string => path.join(credentialsDir, "apikey.bin");
const anthropicKeyPath = (): string => path.join(credentialsDir, "anthropic.bin");
const browserbaseKeyPath = (): string => path.join(credentialsDir, "browserbase.bin");

function writeEncryptedPrivateKey(pem: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS encryption (safeStorage) unavailable — refusing to store the private key in plaintext");
  }
  fs.writeFileSync(privateKeyPath(), safeStorage.encryptString(pem), { mode: 0o600 });
}

/** One-time migration from the legacy plaintext private.pem to the encrypted
 *  format. Safe to call repeatedly — no-ops once migrated or if there was
 *  never a legacy file. Runs eagerly at startup (initCredentials) so the
 *  plaintext copy doesn't sit on disk any longer than necessary. */
function migrateLegacyPrivateKeyIfNeeded(): void {
  if (fs.existsSync(privateKeyPath())) return;
  if (!fs.existsSync(legacyPrivatePemPath())) return;
  if (!safeStorage.isEncryptionAvailable()) return; // migrate next time encryption is available
  const pem = fs.readFileSync(legacyPrivatePemPath(), "utf-8");
  writeEncryptedPrivateKey(pem);
  fs.rmSync(legacyPrivatePemPath());
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
export function ensureKeyPair(): string {
  migrateLegacyPrivateKeyIfNeeded();
  if (!hasKeyPair()) {
    const pair = generateEd25519KeyPair();
    writeEncryptedPrivateKey(pair.privateKeyPem);
    fs.writeFileSync(publicPemPath(), pair.publicKeyPem, { mode: 0o644 });
  }
  return fs.readFileSync(publicPemPath(), "utf-8");
}

export function getPublicKeyPem(): string | null {
  return hasKeyPair() ? fs.readFileSync(publicPemPath(), "utf-8") : null;
}

/** Main-process only. Never expose via IPC. */
export function getPrivateKeyPem(): string {
  migrateLegacyPrivateKeyIfNeeded();
  if (!hasKeyPair()) throw new Error("No keypair generated yet");
  if (fs.existsSync(legacyPrivatePemPath()) && !fs.existsSync(privateKeyPath())) {
    // safeStorage was unavailable at migration time — fall back rather than crash.
    return fs.readFileSync(legacyPrivatePemPath(), "utf-8");
  }
  return safeStorage.decryptString(fs.readFileSync(privateKeyPath()));
}

export function saveApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!/^[A-Za-z0-9]{64}$/.test(trimmed)) {
    throw new Error("API key must be a 64-character alphanumeric string");
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS encryption (safeStorage) unavailable — refusing to store API key in plaintext");
  }
  fs.writeFileSync(apiKeyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 });
}

/** Main-process only. Never expose via IPC. */
export function getApiKey(): string {
  if (!hasApiKey()) throw new Error("API key not configured");
  return safeStorage.decryptString(fs.readFileSync(apiKeyPath()));
}

export function saveAnthropicApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith("sk-ant-")) {
    throw new Error("Invalid Anthropic API key format");
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS encryption (safeStorage) unavailable — refusing to store API key in plaintext");
  }
  fs.writeFileSync(anthropicKeyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 });
}

export function getAnthropicApiKey(): string | null {
  if (!hasAnthropicApiKey()) return process.env.ANTHROPIC_API_KEY || null;
  return safeStorage.decryptString(fs.readFileSync(anthropicKeyPath()));
}

/* ── Browserbase (cloud browser for agent web research) ──────────────── */

export function hasBrowserbaseKey(): boolean {
  return fs.existsSync(browserbaseKeyPath()) || Boolean(process.env.BROWSERBASE_API_KEY);
}

export function saveBrowserbaseKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith("bb_")) {
    throw new Error("Browserbase API keys start with 'bb_'");
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS encryption (safeStorage) unavailable — refusing to store the Browserbase key in plaintext");
  }
  fs.writeFileSync(browserbaseKeyPath(), safeStorage.encryptString(trimmed), { mode: 0o600 });
}

/** Main-process only. Never expose via IPC, never log, never put in a prompt. */
export function getBrowserbaseKey(): string | null {
  if (!fs.existsSync(browserbaseKeyPath())) return process.env.BROWSERBASE_API_KEY || null;
  return safeStorage.decryptString(fs.readFileSync(browserbaseKeyPath()));
}

export function clearBrowserbaseKey(): void {
  if (fs.existsSync(browserbaseKeyPath())) fs.rmSync(browserbaseKeyPath());
}
