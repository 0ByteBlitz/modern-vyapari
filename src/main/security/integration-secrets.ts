/**
 * Per-integration secret storage with a declared auth scheme
 * (roadmap S2-9, `docs/ARCHITECTURE.md` §4 rule 4 and §9).
 *
 * The existing vault (`credentials.ts`) is **one venue's shape**: an Ed25519
 * keypair plus an API key, at fixed filenames. A venue authenticating by HMAC,
 * a bearer token or OAuth has nowhere to live, so a second integration would
 * either reuse fields that mean something else or bypass the vault entirely.
 * This is the shape that admits a second scheme.
 *
 * ## What this deliberately does NOT do
 *
 * **It does not migrate the existing Revolut X keys.** Those live at
 * `private.key.enc`, `public.pem` and `apikey.bin`, and they are the owner's
 * real credentials with no backup routine yet (roadmap L-3). Moving them buys
 * tidiness and risks the one thing that cannot be re-derived — an Ed25519
 * private key the venue has already been told about. Revolut X therefore
 * declares its scheme here and keeps reading through the legacy accessors; new
 * integrations use this store from the start. Migration, if ever wanted, is a
 * copy-then-verify operation and its own decision.
 *
 * ## Security properties
 *
 *  • **Encrypted at rest via `safeStorage`**, the same standard as the existing
 *    vault (DPAPI on Windows). If OS encryption is unavailable the store
 *    **refuses to write** rather than falling back to plaintext.
 *  • **Values never cross IPC.** `secretStatus()` returns booleans; there is no
 *    exported path that hands a secret to the renderer.
 *  • **Never logged.** No function here logs a value, and the log redactor is
 *    a second line of defence rather than the first.
 *  • **Field keys are validated** before touching the filesystem, so an
 *    integration id can never traverse out of the credentials directory.
 */

import * as fs from "fs";
import * as path from "path";
import { electronCipher, readEncrypted, writeEncrypted, type SecretCipher } from "./cipher";

/* ── Auth schemes ───────────────────────────────────────────────────── */

/**
 * How an integration proves who it is.
 *
 * This is an enumeration of what the app can actually *do*, not a catalogue of
 * what exists in the world — adding a member means adding the code that signs
 * or sends it, otherwise it is a capability that does not capabilitate.
 */
export type AuthScheme =
  /** Request signing with an Ed25519 keypair plus an API key header (Revolut X). */
  | "ed25519_signed"
  /** A single bearer/API key sent as a header. */
  | "api_key"
  /** Symmetric request signing: key id + shared secret (most CEX REST APIs). */
  | "hmac"
  /** Public data only — no credential at all. */
  | "none";

export interface SecretField {
  /** Stable key, used in the filename. Lowercase letters, digits, `_` only. */
  key: string;
  /** Shown in settings. */
  label: string;
  /** False for values that are not sensitive (an account id, a key *id*). */
  sensitive: boolean;
}

export interface IntegrationAuthSpec {
  integrationId: string;
  scheme: AuthScheme;
  fields: SecretField[];
  /**
   * True when this integration's secrets still live at the legacy fixed
   * filenames rather than in this store. Revolut X is the only one, and the
   * flag exists so the fact is visible in code rather than being folklore.
   */
  legacyStorage?: boolean;
}

/* ── Cipher seam ────────────────────────────────────────────────────── */

/* The cipher, its lazy safeStorage access and the refuse-rather-than-degrade
   rule now live in cipher.ts, shared with the main credential vault. Re-exported
   so existing importers of the interface are unchanged. */
export type { SecretCipher } from "./cipher";

let cipher: SecretCipher = electronCipher;
let baseDir = "";

export function initIntegrationSecrets(userDataPath: string): void {
  baseDir = path.join(userDataPath, "credentials", "integrations");
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
}

/** Test seam. Never called in production code. */
export function configureForTesting(dir: string, testCipher: SecretCipher): void {
  baseDir = dir;
  fs.mkdirSync(baseDir, { recursive: true });
  cipher = testCipher;
}

/* ── Paths ──────────────────────────────────────────────────────────── */

const SAFE_KEY = /^[a-z0-9_]+$/;

/**
 * Build the on-disk path, refusing anything that is not a plain key.
 *
 * The traversal this prevents is not hypothetical in shape: an integration id
 * is the kind of value that eventually comes from configuration, and
 * `../../..` in a filename is how a credentials directory stops containing
 * only credentials.
 */
function secretPath(integrationId: string, field: string): string {
  if (!SAFE_KEY.test(integrationId)) throw new Error(`Invalid integration id: ${integrationId}`);
  if (!SAFE_KEY.test(field)) throw new Error(`Invalid secret field: ${field}`);
  if (!baseDir) throw new Error("Integration secret store not initialised");
  return path.join(baseDir, `${integrationId}.${field}.bin`);
}

/* ── Read / write ───────────────────────────────────────────────────── */

export function hasSecret(integrationId: string, field: string): boolean {
  return fs.existsSync(secretPath(integrationId, field));
}

export async function saveSecret(integrationId: string, field: string, value: string): Promise<void> {
  /* Refuse rather than degrade. A credential written in plaintext because the
     keychain was briefly unavailable is a credential in plaintext forever, and
     nothing would ever notice. */
  await writeEncrypted(
    cipher,
    secretPath(integrationId, field),
    value,
    "OS encryption is unavailable — refusing to store a secret in plaintext."
  );
}

/** Main-process only. Never expose through IPC, a prompt, or a log line. */
export async function getSecret(integrationId: string, field: string): Promise<string | null> {
  const p = secretPath(integrationId, field);
  if (!fs.existsSync(p)) return null;
  return readEncrypted(cipher, p);
}

export function clearSecret(integrationId: string, field: string): void {
  const p = secretPath(integrationId, field);
  if (fs.existsSync(p)) fs.rmSync(p);
}

/* ── Status, for the UI ─────────────────────────────────────────────── */

export interface IntegrationSecretStatus {
  integrationId: string;
  scheme: AuthScheme;
  /** Per field: is something stored? **Presence only — never the value.** */
  fields: Array<{ key: string; label: string; present: boolean }>;
  /** Every sensitive field present, so the integration can actually be used. */
  complete: boolean;
}

/**
 * What the renderer is allowed to know: which fields are filled in.
 *
 * `present` booleans are the entire payload by design. This is the same rule
 * `setup:status` already follows for the Revolut X keys, made general.
 */
export function secretStatus(
  spec: IntegrationAuthSpec,
  isPresent: (field: string) => boolean = (f) => hasSecret(spec.integrationId, f)
): IntegrationSecretStatus {
  const fields = spec.fields.map((f) => ({
    key: f.key,
    label: f.label,
    present: isPresent(f.key),
  }));
  const required = spec.fields.filter((f) => f.sensitive).map((f) => f.key);
  return {
    integrationId: spec.integrationId,
    scheme: spec.scheme,
    fields,
    complete: required.every((k) => fields.find((f) => f.key === k)?.present ?? false),
  };
}
