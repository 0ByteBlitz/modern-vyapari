import * as fs from "fs";

/**
 * The one way secrets are encrypted to disk, shared by both stores
 * (`credentials.ts` for the venue / Anthropic / Browserbase keys and the
 * signing key, `integration-secrets.ts` for per-integration secrets).
 *
 * **Async, because Electron 46 removes the synchronous `safeStorage` methods**
 * (deprecated in 45, following Chromium's removal of the synchronous OSCrypt
 * backend). The async methods use the same per-platform key store, and data
 * written by the old `encryptString` decrypts with `decryptStringAsync`, so
 * existing key files keep working without a migration.
 *
 * `safeStorage` is reached lazily rather than imported, so a plain Node test
 * process — where `require("electron")` yields a path string — can load this
 * module and substitute a test cipher.
 */
export interface SecretCipher {
  isAvailable(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  /** `shouldReEncrypt`: the OS key rotated; the caller should rewrite the file. */
  decrypt(buf: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

function safeStorage(): Electron.SafeStorage {
  return (require("electron") as typeof import("electron")).safeStorage;
}

export const electronCipher: SecretCipher = {
  async isAvailable() {
    try {
      return Boolean(await safeStorage()?.isAsyncEncryptionAvailable());
    } catch {
      return false;
    }
  },
  encrypt(plain) {
    return safeStorage().encryptStringAsync(plain);
  },
  decrypt(buf) {
    return safeStorage().decryptStringAsync(buf);
  },
};

/**
 * Write via a temp file and rename, so a crash mid-write can never leave a
 * truncated key file — which would read as a key that exists and cannot be
 * decrypted, with nothing to recover from.
 */
function writeAtomic(file: string, data: Buffer): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Encrypt and store. **Refuses rather than degrades**: a secret written in
 * plaintext because the keychain was briefly unavailable is a secret in
 * plaintext forever, and nothing would ever notice.
 */
export async function writeEncrypted(cipher: SecretCipher, file: string, plain: string, refusal: string): Promise<void> {
  if (!(await cipher.isAvailable())) throw new Error(refusal);
  writeAtomic(file, await cipher.encrypt(plain));
}

/**
 * Read and decrypt. When the OS reports the key has rotated, the file is
 * re-encrypted under the new key — best effort, because the value already
 * decrypted correctly and a failed rewrite must not turn a working read into
 * a failure.
 */
export async function readEncrypted(
  cipher: SecretCipher,
  file: string,
  onRewriteFailed?: (err: unknown) => void
): Promise<string> {
  const { result, shouldReEncrypt } = await cipher.decrypt(fs.readFileSync(file));
  if (shouldReEncrypt) {
    try {
      writeAtomic(file, await cipher.encrypt(result));
    } catch (err) {
      onRewriteFailed?.(err);
    }
  }
  return result;
}
