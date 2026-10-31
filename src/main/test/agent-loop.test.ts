/**
 * The agent loop in `agent/chat.ts`, against a scripted fake AI provider.
 *
 * Since the AI provider port, the loop is vendor-neutral: it runs the app's own
 * tools, broadcasts, transcript markers and the iteration cap, and asks the
 * provider only for one model step at a time. That makes the loop testable
 * without a network or an API key — and it is the contract every future adapter
 * (OpenAI-compatible, Gemini, local models) has to satisfy.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { setupTestDb, cleanupTestDb, createTestSession } from "./test-helper";
import { getDb } from "../db/database";
import { setAiProviderForTesting } from "../ai/registry";
import type { AgentStepRequest, AgentStepResult, AiProvider, AiToolResult } from "../ai/port";

/* chat.ts lazily requires the app entry point to flag "agent acting"; the real
   one starts Electron. Stand in a window-less one, the way a test process is. */
const mainPath = require.resolve(path.join(__dirname, "..", "main"));
require.cache[mainPath] = { id: mainPath, filename: mainPath, loaded: true, exports: { mainWindow: null } } as NodeJS.Module;

// Imported after the stub so nothing reaches the real entry point.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendChatMessage } = require("../agent/chat") as typeof import("../agent/chat");

type Step = (req: AgentStepRequest, n: number) => AgentStepResult | Promise<AgentStepResult>;

function fakeProvider(steps: Step[], opts: { configured?: boolean; refuseSearchOnce?: boolean } = {}) {
  const calls = { steps: [] as AgentStepRequest[], toolResults: [] as AiToolResult[][], conversations: 0 };
  let refused = false;
  const provider: AiProvider = {
    info: {
      id: "fake",
      displayName: "FakeAI",
      capabilities: { serverWebSearch: false, promptCaching: false, vision: false, toolCalling: "reliable" },
    },
    isConfigured: () => opts.configured ?? true,
    listModels: async () => [],
    complete: async () => ({ textParts: [], usage: {} }),
    createConversation: () => {
      calls.conversations++;
      return { providerId: "fake" };
    },
    async step(_conv, req) {
      calls.steps.push(req);
      if (opts.refuseSearchOnce && !refused) {
        throw new Error("400: tools.0: web_search is not supported by this model");
      }
      const n = calls.steps.length - 1;
      const s = steps[Math.min(n, steps.length - 1)]!;
      return s(req, n);
    },
    addToolResults: (_conv, results) => void calls.toolResults.push(results),
    rejectedWebSearch: (err) => {
      const hit = String((err as Error).message).includes("web_search");
      if (hit) refused = true;
      return hit;
    },
    unsupportedTools: () => [],
  };
  return { provider, calls };
}

function fakeSender() {
  const events: Array<{ channel: string; payload: any }> = [];
  const sender = { isDestroyed: () => false, send: (channel: string, payload: unknown) => events.push({ channel, payload }) };
  return { sender: sender as any, events };
}

const text = (events: Array<{ channel: string; payload: any }>) =>
  events.filter((e) => e.channel === "chat:chunk").map((e) => e.payload.text).join("");

function savedAssistant(sessionId: number): string[] {
  return (
    getDb()
      .prepare("SELECT content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id")
      .all(sessionId) as Array<{ content: string }>
  ).map((r) => r.content);
}

const PARAMS = { model: "fake-model", effort: "low", capabilities: { adaptive: false, extended: false } };

describe("agent loop (provider-neutral)", () => {
  let sessionId = 0;
  beforeEach(() => {
    setupTestDb();
    sessionId = createTestSession().id;
  });
  afterEach(() => {
    setAiProviderForTesting(null);
    cleanupTestDb();
  });

  test("a text reply streams, is persisted, and completes", async () => {
    const { provider, calls } = fakeProvider([
      (req) => {
        req.onText("Hello ");
        req.onText("world");
        return { toolCalls: [], usage: { input_tokens: 10, output_tokens: 2 } };
      },
    ]);
    setAiProviderForTesting(provider);
    const { sender, events } = fakeSender();

    await sendChatMessage(sessionId, [{ role: "user", content: "hi" }], PARAMS, sender);

    assert.equal(text(events), "Hello world");
    assert.ok(events.some((e) => e.channel === "chat:complete"));
    assert.deepEqual(savedAssistant(sessionId), ["Hello world"]);
    assert.equal(calls.steps.length, 1);
    assert.ok(calls.steps[0]!.system.stable.length > 0 && calls.steps[0]!.system.volatile.length > 0);
    assert.ok(calls.steps[0]!.tools.length > 0, "the app's tools are offered to the provider");
  });

  test("a failing tool is reported in the transcript and returned to the model as an error", async () => {
    const { provider, calls } = fakeProvider([
      () => ({ toolCalls: [{ id: "t1", name: "no_such_tool", input: {} }], usage: {} }),
      (req) => {
        req.onText("Recovered.");
        return { toolCalls: [], usage: {} };
      },
    ]);
    setAiProviderForTesting(provider);
    const { sender, events } = fakeSender();

    await sendChatMessage(sessionId, [{ role: "user", content: "do it" }], PARAMS, sender);

    assert.equal(calls.toolResults.length, 1);
    const [result] = calls.toolResults[0]!;
    assert.equal(result!.callId, "t1");
    assert.equal(result!.isError, true);
    assert.match(String(result!.content), /Unknown tool: no_such_tool/);
    assert.match(text(events), /\[\[toolerror:no_such_tool:/);
    assert.match(text(events), /Recovered\.$/);
  });

  test("the app's tools are never offered when the owner switched them off… and no order tool exists at all", async () => {
    const { provider, calls } = fakeProvider([() => ({ toolCalls: [], usage: {} })]);
    setAiProviderForTesting(provider);
    await sendChatMessage(sessionId, [{ role: "user", content: "hi" }], PARAMS, fakeSender().sender);
    const names = calls.steps[0]!.tools.map((t) => t.name);
    /* Provider-independent: whichever model is behind the port, it reaches only
       these tools, and none of them can place, arm or route an order. */
    for (const forbidden of ["place_order", "arm_plan", "set_venue", "cancel_order"]) {
      assert.equal(names.includes(forbidden), false, forbidden);
    }
  });

  test("a model that refuses web search is retried once without it, and the user is told", async () => {
    const { provider, calls } = fakeProvider(
      [
        (req) => {
          req.onText("Answer without search.");
          return { toolCalls: [], usage: {} };
        },
      ],
      { refuseSearchOnce: true }
    );
    setAiProviderForTesting(provider);
    const { sender, events } = fakeSender();

    await sendChatMessage(sessionId, [{ role: "user", content: "news?" }], PARAMS, sender);

    assert.equal(events.filter((e) => e.channel === "chat:notice").length, 1);
    assert.equal(events.filter((e) => e.channel === "chat:error").length, 0);
    assert.equal(calls.conversations, 1, "the retry reuses the unchanged conversation");
    assert.deepEqual(savedAssistant(sessionId), ["Answer without search."]);
  });

  test("the loop stops after 15 tool rounds and says so", async () => {
    const { provider, calls } = fakeProvider([() => ({ toolCalls: [{ id: "x", name: "no_such_tool", input: {} }], usage: {} })]);
    setAiProviderForTesting(provider);
    const { sender, events } = fakeSender();

    await sendChatMessage(sessionId, [{ role: "user", content: "loop" }], PARAMS, sender);

    assert.equal(calls.steps.length, 15);
    assert.match(text(events), /Stopped after 15 tool-call rounds/);
  });

  test("an unconfigured provider reports CREDENTIALS, naming that provider", async () => {
    const { provider, calls } = fakeProvider([() => ({ toolCalls: [], usage: {} })], { configured: false });
    setAiProviderForTesting(provider);
    const { sender, events } = fakeSender();

    await sendChatMessage(sessionId, [{ role: "user", content: "hi" }], PARAMS, sender);

    const err = events.find((e) => e.channel === "chat:error");
    assert.ok(err);
    assert.equal(err!.payload.code, "CREDENTIALS");
    assert.match(err!.payload.error, /FakeAI/);
    assert.equal(calls.steps.length, 0);
  });

  test("a provider failure reaches the user sanitised — never the raw body", async () => {
    const { provider } = fakeProvider([
      () => {
        throw new Error('401 {"error":"invalid x-api-key sk-ant-SECRET123"}');
      },
    ]);
    setAiProviderForTesting(provider);
    const { sender, events } = fakeSender();

    await sendChatMessage(sessionId, [{ role: "user", content: "hi" }], PARAMS, sender);

    const err = events.find((e) => e.channel === "chat:error");
    assert.ok(err);
    assert.equal(JSON.stringify(err!.payload).includes("SECRET123"), false);
    assert.deepEqual(savedAssistant(sessionId), [], "a failed turn persists no empty assistant row");
  });
});
