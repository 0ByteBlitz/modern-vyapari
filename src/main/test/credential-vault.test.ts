/**
 * The credential vault (`security/credentials.ts`) — Revolut X key, signing
 * key, Anthropic and Browserbase keys.
 *
 * Untestable until it moved onto the async cipher seam: it imported
 * `safeStorage` at load, and in a plain Node process `require("electron")` is a
 * path string. These tests pin the RULES around the cipher, not the cipher —
 * the double below is reversible on purpose, and real confidentiality comes
 * from safeStorage in production.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SecretCipher } from "../security/cipher";
import {
  configureCredentialsForTesting,
  saveApiKey,
  getApiKey,
  hasApiKey,
  saveAnthropicApiKey,
  getAnthropicApiKey,
  saveBrowserbaseKey,
  getBrowserbaseKey,
  ensureKeyPair,
  getPrivateKeyPem,
  hasKeyPair,
} from "../security/credentials";

const API_KEY = "a".repeat(64);

/** Reversible double. `version` lets a test simulate an OS key rotation:
 *  data written under an older version decrypts, but asks to be re-encrypted. */
function fakeCipher(opts: { available?: boolean; version?: number; failEncrypt?: boolean } = {}): SecretCipher {
  const { available = true, version = 1 } = opts;
  return {
    isAvailable: async () => available,
    encrypt: async (plain) => {
      if (opts.failEncrypt) throw new Error("keychain locked");
      return Buffer.from(`enc:v${version}:${plain}`, "utf8");
    },
    decrypt: async (buf) => {
      const m = /^enc:v(\d+):([\s\S]*)$/.exec(buf.toString("utf8"));
      if (!m) throw new Error("not ciphertext");
      return { result: m[2]!, shouldReEncrypt: Number(m[1]) < version };
    },
  };
}

let dir = "";
const file = (name: string) => path.join(dir, name);

describe("credential vault", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyapari-vault-"));
    configureCredentialsForTesting(dir, fakeCipher());
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("every key round-trips, and what reaches disk is the cipher's output", async () => {
    await saveApiKey(API_KEY);
    await saveAnthropicApiKey("sk-ant-test");
    await saveBrowserbaseKey("bb_test");

    assert.equal(await getApiKey(), API_KEY);
    assert.equal(await getAnthropicApiKey(), "sk-ant-test");
    assert.equal(await getBrowserbaseKey(), "bb_test");
    assert.equal(fs.readFileSync(file("apikey.bin"), "utf8"), `enc:v1:${API_KEY}`);
  });

  test("writing is REFUSED when OS encryption is unavailable — no plaintext fallback", async () => {
    configureCredentialsForTesting(dir, fakeCipher({ available: false }));
    await assert.rejects(saveApiKey(API_KEY), /refusing to store API key in plaintext/);
    await assert.rejects(saveAnthropicApiKey("sk-ant-x"), /refusing/);
    await assert.rejects(saveBrowserbaseKey("bb_x"), /refusing/);
    await assert.rejects(ensureKeyPair(), /refusing to store the private key/);
    assert.deepEqual(fs.readdirSync(dir), [], "nothing may be written when the cipher is unavailable");
  });

  test("a missing Revolut X key: hasApiKey answers, getApiKey rejects", async () => {
    /* The basis monitor used the getter as a presence check and crashed every
       fresh install. Presence is hasApiKey's job; it touches no secret. */
    assert.equal(hasApiKey(), false);
    await assert.rejects(getApiKey(), /not configured/);
  });

  test("a rotated OS key re-encrypts the stored copy, and the read still succeeds", async () => {
    await saveApiKey(API_KEY); // written under v1
    configureCredentialsForTesting(dir, fakeCipher({ version: 2 }));
    assert.equal(await getApiKey(), API_KEY);
    assert.equal(fs.readFileSync(file("apikey.bin"), "utf8"), `enc:v2:${API_KEY}`, "rewritten under the new key");
  });

  test("a failed re-encryption never turns a good read into a failure", async () => {
    await saveApiKey(API_KEY);
    configureCredentialsForTesting(dir, fakeCipher({ version: 2, failEncrypt: true }));
    assert.equal(await getApiKey(), API_KEY);
    assert.equal(fs.readFileSync(file("apikey.bin"), "utf8"), `enc:v1:${API_KEY}`, "old copy left intact");
  });

  test("writes leave no temp file behind", async () => {
    await saveApiKey(API_KEY);
    await ensureKeyPair();
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  });

  test("a generated keypair stores the private key encrypted and returns it intact", async () => {
    const publicPem = await ensureKeyPair();
    assert.match(publicPem, /BEGIN PUBLIC KEY/);
    assert.equal(hasKeyPair(), true);
    assert.match(fs.readFileSync(file("private.key.enc"), "utf8"), /^enc:v1:-----BEGIN PRIVATE KEY/);
    assert.match(await getPrivateKeyPem(), /^-----BEGIN PRIVATE KEY/);
  });

  test("a legacy plaintext private.pem is migrated once and removed, even under concurrent reads", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nlegacy\n-----END PRIVATE KEY-----\n";
    fs.writeFileSync(file("private.pem"), pem);
    fs.writeFileSync(file("public.pem"), "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n");

    const reads = await Promise.all([getPrivateKeyPem(), getPrivateKeyPem(), getPrivateKeyPem()]);
    assert.deepEqual(reads, [pem, pem, pem]);
    assert.equal(fs.existsSync(file("private.pem")), false, "plaintext copy removed");
    assert.equal(fs.readFileSync(file("private.key.enc"), "utf8"), `enc:v1:${pem}`);
  });
});
