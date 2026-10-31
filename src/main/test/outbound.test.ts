/**
 * The typed main → renderer channel (roadmap S2-7b).
 *
 * The property this layer exists for is that **`emitError` is the only way to
 * put a failure on a channel**, so sanitisation is enforced once instead of
 * remembered at seven call sites. Chat streaming rendered raw Anthropic API
 * errors into the transcript until that was fixed by hand — the leak arrived
 * through the one door `safe()` does not cover, because `safe()` guards request
 * handlers and nothing guarded the pushes.
 *
 * `emit`/`emitTo` need Electron's `BrowserWindow`, so the tests drive the parts
 * that do not: the destroyed-target guard and the sanitisation of the payload.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { emitTo, emitError } from "../events/outbound";
import { AppError } from "../../shared/errors";

/** Minimal stand-in for a WebContents — only what `emitTo` touches. */
function fakeTarget(destroyed = false) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  };
}

describe("emitTo", () => {
  test("delivers channel and payload unchanged", () => {
    const t = fakeTarget();
    emitTo(t as never, "chat:chunk", { text: "hello", conversation: 1 });
    assert.deepEqual(t.sent, [{ channel: "chat:chunk", payload: { text: "hello", conversation: 1 } }]);
  });

  test("a destroyed target is skipped, not thrown at", () => {
    /* The WS candle ingest can outlive a window and keeps ticking. Each old
       call site had to remember its own isDestroyed check; a background writer
       is exactly the one that forgets. */
    const t = fakeTarget(true);
    assert.doesNotThrow(() => emitTo(t as never, "chat:chunk", { text: "x", conversation: "general" }));
    assert.equal(t.sent.length, 0);
  });

  test("a null or undefined target is a no-op", () => {
    assert.doesNotThrow(() => emitTo(null, "agent:acting", true));
    assert.doesNotThrow(() => emitTo(undefined, "agent:acting", false));
  });
});

describe("emitError sanitises", () => {
  test("a raw Error never reaches the renderer verbatim", () => {
    /* The exact leak this module exists to close: an internal message — a
       SQLite string, a file path, a venue API body — rendered into the UI. */
    const t = fakeTarget();
    const internal = "ANTHROPIC 400 {\"error\":{\"message\":\"invalid x-api-key sk-ant-secret\"}}";
    emitError(t as never, "chat:error", new Error(internal));

    assert.equal(t.sent.length, 1);
    const payload = t.sent[0]!.payload as { error: string; code: string };
    assert.ok(!payload.error.includes("sk-ant-secret"), "the key must not survive");
    assert.ok(!payload.error.includes(internal), "the raw message must not survive");
    assert.equal(typeof payload.code, "string");
    assert.ok(payload.code.length > 0, "a stable code is always present");
  });

  test("an AppError's deliberate wording IS preserved", () => {
    /* Deliberate user-facing text goes through the same path rather than an
       escape hatch — the escape hatch is what let unsanitised strings in. */
    const t = fakeTarget();
    emitError(
      t as never,
      "chat:error",
      new AppError("CREDENTIALS", "The AI isn't configured yet.", {
        hint: "Add your Anthropic key in Settings › Integrations.",
      })
    );

    const payload = t.sent[0]!.payload as { error: string; code: string; hint?: string };
    assert.equal(payload.code, "CREDENTIALS");
    assert.match(payload.error, /isn't configured yet/);
    assert.match(payload.error, /Add your Anthropic key/, "the hint is folded into the message");
    assert.equal(payload.hint, "Add your Anthropic key in Settings › Integrations.");
  });

  test("returns the payload it sent, so a caller can log or reuse it", () => {
    const t = fakeTarget();
    const returned = emitError(t as never, "chat:error", new Error("boom"));
    assert.deepEqual(t.sent[0]!.payload, returned);
  });

  test("a destroyed target still yields a sanitised payload", () => {
    /* The caller may want to log it even when nobody is listening — and
       sanitising must not depend on delivery succeeding. */
    const t = fakeTarget(true);
    const returned = emitError(t as never, "chat:error", new Error("internal detail"));
    assert.equal(t.sent.length, 0);
    assert.ok(!returned.error.includes("internal detail"));
  });
});
