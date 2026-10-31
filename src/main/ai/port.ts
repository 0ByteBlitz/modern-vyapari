/**
 * The AI provider port — what the app needs from a model vendor, and nothing
 * vendor-shaped.
 *
 * Same idea as `integrations/venue/port.ts`: the app is not locked to one
 * vendor. Everything a vendor owns — its SDK, its key, its message format, its
 * server-side tools, prompt caching, reasoning knobs, model naming — lives in an
 * adapter under `src/main/ai/`. Nothing outside this folder imports a vendor
 * SDK; `vendor-boundary.test.ts` enforces it.
 *
 * **The safety model does not depend on the vendor.** The agent's tools are the
 * app's own (`agent/tools.ts`), and none of them can arm a plan, place an order or
 * choose the venue. A different model behind this port reaches exactly the same
 * tools, so a provider swap cannot widen what the agent is able to do.
 */
import type { AiModelInfo } from "../../shared/ipc-types";
import type { TokenUsage } from "../agent/usage";

export type { AiModelInfo };

/** What a provider can do. Declared, never assumed — the venue rule applied to AI. */
export interface AiProviderCapabilities {
  /** The provider runs web search itself (Anthropic's server tool). Without it,
   *  the agent finds pages through the app's own tools (`fetch_url`). */
  serverWebSearch: boolean;
  /** Prompt-prefix caching that this adapter actually uses. */
  promptCaching: boolean;
  /** Accepts image input (pasted charts, screenshots). */
  vision: boolean;
  /** How far the agent loop can rely on tool calling. Local models are often
   *  "basic": they call tools, but less reliably — the UI should say so. */
  toolCalling: "reliable" | "basic" | "none";
}

export interface AiProviderInfo {
  /** Stable id, persisted in settings: `"anthropic"`, `"openai-compatible"`, … */
  id: string;
  displayName: string;
  capabilities: AiProviderCapabilities;
}

/* ── Messages, in the app's own format ──────────────────────────────── */

export type AiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface AiMessage {
  role: "user" | "assistant";
  content: string | AiContentBlock[];
}

/** One of the app's tools, as JSON Schema. Adapters translate to their wire shape. */
export interface AiToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AiToolResult {
  callId: string;
  content: string | AiContentBlock[];
  isError?: boolean;
}

/* ── One-shot completion (reviews, lessons, compaction) ─────────────── */

export interface CompletionRequest {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface CompletionResult {
  /** Text blocks in order; callers join them as they need. */
  textParts: string[];
  usage: TokenUsage;
}

/* ── The agent loop: one model step at a time ───────────────────────── */

/**
 * The conversation in the provider's native format. Opaque to the loop: only
 * the adapter that created it reads or extends it, so a vendor's message shape
 * never leaks into the loop.
 */
export interface AgentConversation {
  readonly providerId: string;
}

export interface AgentStepRequest {
  model: string;
  /** Two parts on purpose: `stable` is identical across sessions (cacheable),
   *  `volatile` changes per call. An adapter with caching puts its breakpoint
   *  between them. */
  system: { stable: string; volatile: string };
  tools: AiToolSpec[];
  /** Offer provider-side web search if the provider has it. */
  webSearch: boolean;
  /** Reasoning effort chosen in the UI (`low` … `max`), or null for none. */
  effort: string | null;
  /** The chosen model's reasoning style, as reported by `listModels`. */
  reasoning: { adaptive: boolean; extended: boolean };
  onText(delta: string): void;
  /** A provider-side tool started (e.g. web search), so the transcript shows it. */
  onServerTool(name: string): void;
}

export interface AgentStepResult {
  /** Tool calls the app must execute. Empty means the model has finished. */
  toolCalls: AiToolCall[];
  usage: TokenUsage;
}

export interface AiProvider {
  readonly info: AiProviderInfo;

  /** Whether a key (or a local endpoint) is configured. Synchronous and
   *  decrypts nothing — a presence check, never a getter. */
  isConfigured(): boolean;

  /** Models this key can use. Throws on failure, so a rejected key reaches the
   *  user as an error rather than as an empty list that looks like loading. */
  listModels(): Promise<AiModelInfo[]>;

  complete(req: CompletionRequest): Promise<CompletionResult>;

  createConversation(history: AiMessage[]): AgentConversation;
  /** Run one model call; appends the assistant's turn to `conv`. */
  step(conv: AgentConversation, req: AgentStepRequest): Promise<AgentStepResult>;
  /** Append the results of the tool calls from the last step. */
  addToolResults(conv: AgentConversation, results: AiToolResult[]): void;

  /** True when `err` means this model refused provider-side web search. The
   *  adapter remembers the refusal, so the next step for `model` omits it. */
  rejectedWebSearch(err: unknown, model: string): boolean;
  /** Tools this model cannot use, so the UI says "unavailable" not "off". */
  unsupportedTools(model: string): string[];
}
