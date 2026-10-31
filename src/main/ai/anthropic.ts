/**
 * Anthropic adapter for the AI provider port.
 *
 * Everything Anthropic-specific that `agent/chat.ts` and `agent/review.ts` used
 * to do inline lives here: the SDK client and key, content-block messages,
 * `tool_use` / `tool_result`, the server-side `web_search` tool, prompt caching,
 * and the effort / extended-thinking knobs. Behaviour is unchanged from before
 * the port existed; the code moved, the decisions did not.
 */
import Anthropic from "@anthropic-ai/sdk";
import * as credentials from "../security/credentials";
import { AppError } from "../../shared/errors";
import type {
  AgentConversation,
  AgentStepRequest,
  AgentStepResult,
  AiMessage,
  AiModelInfo,
  AiProvider,
  AiToolResult,
  CompletionRequest,
  CompletionResult,
} from "./port";

/**
 * Anthropic's server-side web search.
 *
 * Before this the agent had no search tool at all, so to find anything it had
 * to invent a URL like `duckduckgo.com/html/?q=…` and feed it to `fetch_url`.
 * Search-results pages are exactly the kind that return a JS shell or a block
 * page, which then triggered the Browserbase fallback — burning cloud-browser
 * minutes on a *search* rather than on a hard page.
 *
 * This runs on Anthropic's side and returns results with citations. It does NOT
 * replace `fetch_url`: that still reads specific pages in an isolated,
 * cookie-less session the user's browsing can't leak into. Search to find,
 * fetch to read.
 *
 * `max_uses` is a cost cap — each search is billed on top of tokens, and an
 * agentic loop with 15 tool rounds could otherwise run a lot of them per turn.
 */
const WEB_SEARCH_TOOL = {
  type: "web_search_20260318" as const,
  name: "web_search" as const,
  max_uses: 5,
  /**
   * `allowed_callers: ["direct"]` — the model calls search itself.
   *
   * Recent `web_search` versions default to allowing the **code-execution**
   * caller as well ("dynamic filtering"), which requires *programmatic tool
   * calling*. Models without it reject the whole request rather than degrading:
   *
   *   '…' does not support programmatic tool calling. The following tools have
   *   `allowed_callers` that require it: web_search.
   *
   * Set unconditionally: the cost (unfiltered results on models that could
   * filter) is accepted for search that works on every model, including the
   * cheap one the review agent runs on.
   */
  allowed_callers: ["direct"] as const,
};

/**
 * Models that rejected the server-side search tool. A refusal 400s the whole
 * request, so it is remembered and the tool dropped for that model from then
 * on — the user's next message just works, without search.
 */
const noWebSearch = new Set<string>();

/** Thinking budget for the extended-thinking path. The API requires
 *  budget_tokens >= 1024 and strictly less than max_tokens. */
function thinkingBudget(effort: string | null): number {
  if (effort === "low") return 1024;
  if (effort === "medium") return 4096;
  if (effort === "high") return 8192;
  return 0;
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

interface AnthropicConversation extends AgentConversation {
  providerId: "anthropic";
  messages: Anthropic.MessageParam[];
  client?: Anthropic;
}

async function newClient(): Promise<Anthropic> {
  const apiKey = await credentials.getAnthropicApiKey();
  if (!apiKey) throw new AppError("CREDENTIALS", "Add your Anthropic key to use the agent.");
  return new Anthropic({ apiKey });
}

function toModelInfo(m: Anthropic.ModelInfo): AiModelInfo {
  return {
    id: m.id,
    display_name: m.display_name,
    provider: "anthropic",
    capabilities: {
      effort: { supported: Boolean(m.capabilities?.effort?.supported) },
      thinking: { supported: Boolean(m.capabilities?.thinking?.supported) },
    },
  };
}

function asConversation(conv: AgentConversation): AnthropicConversation {
  if (conv.providerId !== "anthropic") {
    throw new Error(`Conversation belongs to provider "${conv.providerId}", not "anthropic"`);
  }
  return conv as AnthropicConversation;
}

export const anthropicProvider: AiProvider = {
  info: {
    id: "anthropic",
    displayName: "Anthropic",
    capabilities: {
      serverWebSearch: true,
      promptCaching: true,
      vision: true,
      toolCalling: "reliable",
    },
  },

  isConfigured() {
    return credentials.hasAnthropicApiKey() || Boolean(process.env.ANTHROPIC_API_KEY);
  },

  async listModels() {
    const anthropic = await newClient();
    const models: AiModelInfo[] = [];
    for await (const m of anthropic.models.list({ limit: 100 })) models.push(toModelInfo(m));
    /* Default to the most cost-efficient family — Haiku, else Sonnet. */
    const pick = models.find((m) => m.id.includes("haiku")) ?? models.find((m) => m.id.includes("sonnet"));
    if (pick) pick.recommended = true;
    return models;
  },

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const anthropic = await newClient();
    const res = await anthropic.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    });
    const textParts = res.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
    return { textParts, usage: res.usage };
  },

  createConversation(history: AiMessage[]): AgentConversation {
    /* The app's content blocks are Anthropic's text/image shapes, so history
       maps across unchanged. */
    const conv: AnthropicConversation = {
      providerId: "anthropic",
      messages: history.map((m) => ({ role: m.role, content: m.content as Anthropic.MessageParam["content"] })),
    };
    return conv;
  },

  async step(convIn: AgentConversation, req: AgentStepRequest): Promise<AgentStepResult> {
    const conv = asConversation(convIn);
    conv.client ??= await newClient();

    const budgetTokens = thinkingBudget(req.effort);
    const effort: EffortLevel | null = (EFFORT_LEVELS as readonly string[]).includes(req.effort ?? "")
      ? (req.effort as EffortLevel)
      : null;

    const requestParams: Anthropic.MessageStreamParams = {
      model: req.model,
      /* With extended thinking, max_tokens is the budget PLUS room for the
         visible answer, and must be strictly greater than budget_tokens. */
      max_tokens: req.reasoning.extended && budgetTokens > 0 ? budgetTokens + 4096 : 4096,
      /* Caching is a PREFIX match in render order tools → system → messages.
         The breakpoint sits on the stable half so the volatile session context
         after it cannot invalidate the cached tools and base prompt. */
      system: [
        { type: "text", text: req.system.stable, cache_control: { type: "ephemeral" } },
        { type: "text", text: req.system.volatile },
      ],
      messages: conv.messages,
      tools: [
        ...req.tools,
        ...(req.webSearch && !noWebSearch.has(req.model) ? [WEB_SEARCH_TOOL] : []),
      ] as Anthropic.ToolUnion[],
    };

    /* Effort and extended thinking are alternative ways to spend reasoning
       tokens, never both. Effort lives in `output_config`, not at top level. */
    if (req.reasoning.adaptive && effort) {
      requestParams.output_config = { effort };
    } else if (req.reasoning.extended && budgetTokens > 0) {
      requestParams.thinking = { type: "enabled", budget_tokens: budgetTokens };
    }

    const stream = conv.client.messages.stream(requestParams);
    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        req.onText(chunk.delta.text);
      }
      /* Server-side tools execute on Anthropic's side and never reach the app's
         dispatcher; surface them so the transcript shows the search happening. */
      if (chunk.type === "content_block_start" && chunk.content_block.type === "server_tool_use") {
        req.onServerTool(chunk.content_block.name);
      }
    }

    const finalMessage = await stream.finalMessage();
    conv.messages.push({ role: "assistant", content: finalMessage.content });

    if (finalMessage.stop_reason !== "tool_use") return { toolCalls: [], usage: finalMessage.usage };
    const toolCalls = finalMessage.content.flatMap((b) =>
      b.type === "tool_use" ? [{ id: b.id, name: b.name, input: (b.input as Record<string, unknown>) ?? {} }] : []
    );
    return { toolCalls, usage: finalMessage.usage };
  },

  addToolResults(convIn: AgentConversation, results: AiToolResult[]) {
    const conv = asConversation(convIn);
    conv.messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.callId,
        content: r.content as Anthropic.ToolResultBlockParam["content"],
        ...(r.isError ? { is_error: true } : {}),
      })),
    });
  },

  rejectedWebSearch(err: unknown, model: string) {
    const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const rejected = text.includes("web_search") || (text.includes("tools") && text.includes("type"));
    if (rejected) noWebSearch.add(model);
    return rejected;
  },

  unsupportedTools(model: string) {
    return noWebSearch.has(model) ? ["web_search"] : [];
  },
};
