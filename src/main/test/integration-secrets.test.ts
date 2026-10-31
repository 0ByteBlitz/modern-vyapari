/**
 * Per-integration secret storage (roadmap S2-9).
 *
 * Credential rules are exactly the ones worth testing, and until now they were
 * untestable: `credentials.ts` imports `safeStorage` at module load, so in a
 * plain Node test process importing it throws. This store reaches the cipher
 * lazily and accepts an injected one, so the rules can be asserted.
 *
 * The properties under test are refusals and containment:
 *
 *  • **no plaintext fallback** — if OS encryption is unavailable, writing is
 *    refused rather than degraded. A credential written in plaintext because
 *    the keychain was briefly unavailable stays in plaintext forever, and
 *    nothing would notice;
 *  • **no traversal** — an integration id is the kind of value that eventually
 *    comes from configuration, and `../..` in a filename is how a credentials
 *    directory stops containing only credentials;
 *  • **status leaks presence, never values** — the same rule `setup:status`
 *    already follows for the Revolut X keys, made general.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configureForTesting,
  hasSecret,
  saveSecret,
  getSecret,
  clearSecret,
  secretStatus,
  type SecretCipher,
  type IntegrationAuthSpec,
} from "../security/integration-secrets";
import { REVOLUTX_AUTH } from "../integrations/venue/revolutx";

/** Reversible stand-in for safeStorage. Not encryption — a test double whose
 *  only job is to prove the *rules* around the cipher, not the cipher. */
function fakeCipher(available = true): SecretCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decrypt: (buf) => buf.toString("utf8").replace(/^enc:/, ""),
  };
}

const SPEC: IntegrationAuthSpec = {
  integrationId: "somevenue",
  scheme: "hmac",
  fields: [
    { key: "key_id", label: "Key ID", sensitive: false },
    { key: "secret", label: "Secret", sensitive: true },
  ],
};

let dir = "";

describe("integration secrets", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyapari-sec-"));
    configureForTesting(dir, fakeCipher());
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("a saved secret round-trips, and the write goes through the cipher", () => {
    saveSecret("somevenue", "secret", "hunter2");
    assert.equal(hasSecret("somevenue", "secret"), true);
    assert.equal(getSecret("somevenue", "secret"), "hunter2");

    /* The double is not encryption, so "the file does not contain the value"
       is not a claim this test can honestly make — asserting it would certify
       nothing. What IS provable is that the store wrote the cipher's output
       rather than the plain value, which is the behaviour under test. Real
       confidentiality comes from safeStorage in production. */
    const onDisk = fs.readFileSync(path.join(dir, "somevenue.secret.bin"), "utf8");
    assert.equal(onDisk, "enc:hunter2");
  });

  test("a missing secret reads as null, not as an empty string", () => {
    /* null means "absent"; "" would be a value the caller might send as a
       header. Unknown must never become a usable-looking value. */
    assert.equal(getSecret("somevenue", "secret"), null);
    assert.equal(hasSecret("somevenue", "secret"), false);
  });

  test("writing is REFUSED when OS encryption is unavailable", () => {
    configureForTesting(dir, fakeCipher(false));
    assert.throws(() => saveSecret("somevenue", "secret", "hunter2"), /refusing to store a secret in plaintext/i);
    assert.equal(
      fs.existsSync(path.join(dir, "somevenue.secret.bin")),
      false,
      "nothing may be written when the cipher is unavailable"
    );
  });

  test("clearing removes the file", () => {
    saveSecret("somevenue", "secret", "x");
    clearSecret("somevenue", "secret");
    assert.equal(hasSecret("somevenue", "secret"), false);
    // Clearing something absent is not an error.
    assert.doesNotThrow(() => clearSecret("somevenue", "secret"));
  });

  test("path traversal in an id or field is refused before touching the disk", () => {
    for (const bad of ["../evil", "a/b", "..", "UPPER", "with space", "dot.dot"]) {
      assert.throws(() => saveSecret(bad, "secret", "x"), /Invalid integration id/, `id: ${bad}`);
      assert.throws(() => saveSecret("somevenue", bad, "x"), /Invalid secret field/, `field: ${bad}`);
    }
  });

  test("status reports presence only, and never a value", () => {
    saveSecret("somevenue", "key_id", "public-id");
    const status = secretStatus(SPEC);

    assert.deepEqual(
      status.fields.map((f) => ({ key: f.key, present: f.present })),
      [
        { key: "key_id", present: true },
        { key: "secret", present: false },
      ]
    );
    assert.equal(
      JSON.stringify(status).includes("public-id"),
      false,
      "a status payload must not carry a stored value"
    );
  });

  test("complete tracks the SENSITIVE fields only", () => {
    /* key_id is not sensitive and not required for completeness — an
       integration is usable once its secrets are present. */
    saveSecret("somevenue", "secret", "s");
    assert.equal(secretStatus(SPEC).complete, true);

    clearSecret("somevenue", "secret");
    saveSecret("somevenue", "key_id", "k");
    assert.equal(secretStatus(SPEC).complete, false);
  });
});

describe("Revolut X auth spec", () => {
  test("declares the scheme it actually uses", () => {
    assert.equal(REVOLUTX_AUTH.scheme, "ed25519_signed");
    assert.equal(REVOLUTX_AUTH.integrationId, "revolutx");
  });

  test("is flagged as still using legacy storage", () => {
    /* The existing keys were deliberately NOT migrated: an Ed25519 private key
       the venue already knows about cannot be re-derived, and there is no
       backup routine yet (roadmap L-3). The flag keeps that a fact in code
       rather than folklore. */
    assert.equal(REVOLUTX_AUTH.legacyStorage, true);
  });
});
