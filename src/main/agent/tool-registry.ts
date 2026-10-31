/**
 * What the agent is allowed to do, and who decides.
 *
 * The owner asked for this after hitting the web-search fallback: *"why not
 * have a menu which shows tools and check them off and on?"* Right question.
 * The agent's capabilities were a hardcoded array in `chat.ts` — invisible from
 * the app, and adjustable only by editing source.
 *
 * **Nothing here can cause harm, and that is by construction.** No tool in this
 * catalogue places, amends or cancels an order; there is no arming tool and no
 * `set_venue` tool. So the worst a toggle can do is make the agent less
 * capable, which is why every tool is switchable rather than only some. What a
 * toggle *is* good for is the two things that have a real cost:
 *
 *   • **money** — `web_search` is billed per use on top of tokens;
 *   • **exposure** — `fetch_url` and the browser tools pull untrusted text into
 *     a model that holds write tools, and the browser pair carries the
 *     TradingView ToS risk the owner accepted knowingly.
 *
 * Those are marked, so the menu says which switches matter.
 *
 * **A tool the model refuses is not a preference.** `web_search` is rejected
 * outright by some models; that is reported as unavailable with the reason,
 * never rendered as something the owner chose. Conflating "you turned this off"
 * with "this model can't" is the ambiguity rule again.
 */
import { getDb } from "../db/database";
import { createLogger } from "../logger";

const log = createLogger("agent-tools");

export type ToolGroup = "session" | "analysis" | "web" | "browser";

export interface ToolInfo {
  id: string;
  label: string;
  group: ToolGroup;
  /** One plain sentence. This reaches the UI. */
  description: string;
  /** Billed per use, over and above tokens. */
  costly?: boolean;
  /** Pulls untrusted external content into the conversation. */
  untrusted?: boolean;
  enabled: boolean;
  /** Set when the *model* refuses it, which is not the owner's choice. */
  unavailableReason?: string;
}

/** Everything the agent can be given. Ids match the tool names sent to the API. */
const CATALOGUE: Omit<ToolInfo, "enabled">[] = [
  { id: "read_candles", label: "Read candles", group: "session", description: "Read price history from the analysis feed." },
  { id: "query_trades", label: "Query trades", group: "session", description: "Look up this session's trades and positions." },
  { id: "read_session_memory", label: "Search journal", group: "session", description: "Search the session's journal and lessons." },
  { id: "write_journal", label: "Write journal", group: "session", description: "Add a note to the session journal." },
  { id: "get_execution_basis", label: "Execution basis", group: "session", description: "Measured spread between the venue and the analysis feed." },
  { id: "list_plans", label: "See your plans", group: "session", description: "List the plans on this session and their state." },
  { id: "get_plan", label: "Read a plan", group: "session", description: "One plan in full — assumptions, invalidation, branches." },
  { id: "list_level_references", label: "See your levels", group: "session", description: "List the named levels the engine can resolve." },
  { id: "create_level_reference", label: "Name a level", group: "session", description: "Save a price as a named level the engine and chart share." },
  { id: "draft_plan", label: "Draft a plan", group: "session", description: "Save a plan as a draft for you to review. It can never arm one." },
  { id: "get_app_capabilities", label: "Check capabilities", group: "session", description: "What the app can actually do right now, read from the adapter." },
  { id: "get_calibration", label: "Your track record", group: "session", description: "How your theses have actually played out, by assumption tag." },
  { id: "compute_indicators", label: "Compute indicators", group: "analysis", description: "Calculate any of the 24 technical indicators." },
  { id: "list_indicators", label: "List indicators", group: "analysis", description: "See which indicators exist and their parameters." },
  { id: "get_derivatives_metrics", label: "Derivatives", group: "analysis", description: "Open interest and funding across Binance and Hyperliquid." },
  { id: "get_order_flow", label: "Order flow", group: "analysis", description: "CVD and the volume profile — who is pressing, and where volume traded." },
  { id: "manage_alerts", label: "Manage alerts", group: "analysis", description: "Create, list and remove price alerts." },
  {
    id: "web_search",
    label: "Web search",
    group: "web",
    description: "Search the web for current information.",
    costly: true,
    untrusted: true,
  },
  {
    id: "fetch_url",
    label: "Fetch a page",
    group: "web",
    description: "Read one web page in an isolated headless window.",
    untrusted: true,
  },
  { id: "read_browser_page", label: "Read browser tab", group: "browser", description: "Read the page open in the Browser tab.", untrusted: true },
  { id: "screenshot_browser", label: "Screenshot browser", group: "browser", description: "Capture the Browser tab as an image.", untrusted: true },
  { id: "navigate_browser", label: "Open a page", group: "browser", description: "Point the Browser tab at a URL for you to look at." },
  { id: "read_research_chart", label: "Read Research chart", group: "browser", description: "Read the symbol, timeframe and range you're looking at." },
  { id: "screenshot_research", label: "Screenshot Research", group: "browser", description: "Capture the Research chart as an image." },
];

const SETTINGS_KEY = "agent_disabled_tools";

/**
 * Ids the owner has switched off.
 *
 * Stored as a disabled-list rather than an enabled-list on purpose: a tool
 * added in a later version is then **on by default**, instead of silently
 * missing for everyone who saved a preference before it existed.
 */
export function disabledToolIds(): Set<string> {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) return new Set();
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? new Set(parsed.filter((v) => typeof v === "string")) : new Set();
  } catch (e) {
    /* A corrupt preference must not disarm the agent silently — fall back to
       everything on, and say so in the log. */
    log.warn("Could not read tool preferences; enabling all tools.", e);
    return new Set();
  }
}

export function setToolEnabled(id: string, enabled: boolean): void {
  if (!CATALOGUE.some((t) => t.id === id)) throw new Error(`Unknown tool: ${id}`);
  const disabled = disabledToolIds();
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  getDb()
    .prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(SETTINGS_KEY, JSON.stringify([...disabled]));
  log.info(`Tool ${id} ${enabled ? "enabled" : "disabled"}.`);
}

export function resetTools(): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(SETTINGS_KEY);
  log.info("Tool preferences reset — all tools enabled.");
}

/** The catalogue with current state, for the UI. */
export function listTools(unsupported: string[] = []): ToolInfo[] {
  const disabled = disabledToolIds();
  const refused = new Set(unsupported);
  return CATALOGUE.map((t) => ({
    ...t,
    enabled: !disabled.has(t.id) && !refused.has(t.id),
    ...(refused.has(t.id) ? { unavailableReason: "This model doesn't support it." } : {}),
  }));
}

/** Is this tool available for a request right now? */
export function toolEnabled(id: string): boolean {
  return !disabledToolIds().has(id);
}
