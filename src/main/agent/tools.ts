import { getDb, auditLog } from "../db/database";
import { ftsQuery } from "../db/queries";
import { getSessionById } from "../sessions/service";
import { computeIndicatorBatch, listIndicators } from "../insights/indicators";
import { getAnalysisCandles } from "../data/analysis-candles";
import { getBasisStats } from "../data/basis-monitor";
import * as strategyService from "../strategy/strategy-service";
import { validateSpec } from "../strategy/strategy-spec";
import type { StrategySpec, EvalInterval } from "../strategy/strategy-spec";
import * as backtestService from "../backtest/backtest-service";
import { alertEngine } from "../insights/alert-engine";
import * as planService from "../plans/plan-service";
import { buildCalibration } from "../plans/calibration";
import * as levelRefService from "../plans/level-reference-service";
import { getCvdSeries, getVolumeProfile } from "../insights/orderflow-service";
import { venueCapabilities } from "../integrations/venue/registry";
import { describeThreshold, formatLevel } from "../../shared/levels";
import type { PriceLevel } from "../../shared/levels";
import type { Condition } from "../strategy/strategy-spec";
import { createLogger } from "../logger";
import { agentActor } from "./tool-audit";

/** Bar sizes a plan can be checked on — `EvalInterval`, as a list for the tool schemas. */
const EVAL_INTERVALS: EvalInterval[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];

const log = createLogger("tools");

/**
 * Agent tools (plan §8): read_candles, query_trades, read_session_memory,
 * write_journal (Phase 1), plus compute_indicators, list_indicators,
 * manage_alerts, plan reads/drafts, order flow (see PLAN_TOOLS / CONTEXT_TOOLS).
 *
 * Every call is scoped to the session's own pair/id, never cross-session.
 *
 * Hard rule (plan §1): these tools never place, modify, or cancel orders.
 * Order placement code does not exist anywhere in this codebase yet — the
 * risk engine (Phase 4 gate) must land first.
 */

const VALID_INTERVALS = [1, 5, 15, 30, 60, 240, 1440];
const VALID_JOURNAL_KINDS = ["trade_review", "backtest_review", "strategy_note", "observation", "lesson"] as const;
type JournalKind = (typeof VALID_JOURNAL_KINDS)[number];
/* What the agent may WRITE. `backtest_review` is readable (old entries stay
   searchable) but no longer written: backtests belong to the frozen strategy
   path, and the Journal dropped its Backtests filter (2026-11-02). */
const WRITABLE_JOURNAL_KINDS = VALID_JOURNAL_KINDS.filter((k) => k !== "backtest_review");

/** Anthropic tool definitions — passed verbatim into the messages.stream() call. */
export const SESSION_TOOLS = [
  {
    name: "read_candles",
    description:
      "Read recent OHLCV candles for the session's pair (or an explicit symbol) from the Binance " +
      "analysis feed — the same cached history the indicators, backtester, and paper engine use, so " +
      "your analysis always matches what the engine traded on. Auto-backfills from Binance if the " +
      "local cache is short. Use this for price/volume analysis — never guess or recall prices from " +
      "memory. Note: Revolut X is the execution venue, so its book may differ from these prices on " +
      "thin pairs; this tool is not a source of executable quotes.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair, e.g. BTC-USD. Defaults to the current session's pair if omitted.",
        },
        interval_minutes: {
          type: "number",
          description: "Candle interval in minutes. One of 1, 5, 15, 30, 60, 240, 1440. Defaults to 60.",
        },
        limit: {
          type: "number",
          description: "Number of most recent candles to return (max 300). Defaults to 100.",
        },
      },
      required: [],
    },
  },
  {
    name: "query_trades",
    description:
      "Query this session's own trade history (fills), most recent first. Returns only trades belonging " +
      "to this session — never other pairs or sessions.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max number of trades to return (max 200). Defaults to 20.",
        },
        mode: {
          type: "string",
          enum: ["paper", "live", "all"],
          description: "Filter by paper or live trades. Defaults to all.",
        },
      },
      required: [],
    },
  },
  {
    name: "read_session_memory",
    description:
      "Search or list this session's journal (past observations, trade reviews, strategy notes, lessons). " +
      "Use `query` for full-text search, or omit it to get the most recent entries. This is how you recall " +
      "what happened before in this session instead of assuming.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Full-text search terms. Omit to list recent entries instead." },
        kind: {
          type: "string",
          enum: VALID_JOURNAL_KINDS,
          description: "Optional filter by entry kind.",
        },
        limit: { type: "number", description: "Max entries to return (max 50). Defaults to 10." },
      },
      required: [],
    },
  },
  {
    name: "write_journal",
    description:
      "Record an observation, trade review, strategy note, or lesson to this session's journal. This is " +
      "append-only persistent memory for the pair — write here whenever something worth remembering happens " +
      "(a thesis, a conclusion, a mistake to avoid next time). Be specific; future you will read this.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "The journal entry text." },
        kind: {
          type: "string",
          enum: WRITABLE_JOURNAL_KINDS,
          description: "Entry category.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional short tags for later filtering/search, e.g. ['rsi', 'stop-too-tight'].",
        },
      },
      required: ["content", "kind"],
    },
  },
];

/**
 * Plan tools — READ ONLY, and that is the whole design.
 *
 * The agent could not see a plan at all before these existed: sixteen tools,
 * none of which touched `trade_plans`. So when asked to "paper
 * trade the armed plan" it was not merely missing the vocabulary — it could not
 * observe that the plan existed. It answered about the product it could see.
 *
 * **Read before write, deliberately.** The draft tools (J-1's second half) are
 * worse than useless without these: an agent that can author a plan but cannot
 * list the ones already armed will cheerfully draft a duplicate of the plan it
 * cannot see.
 *
 * Nothing here mutates. There is no arming tool and there will not be one —
 * a plan's licence to risk money is the owner's signature, and the tool not
 * existing is a stronger guarantee than a check that can be forgotten.
 */
export const PLAN_TOOLS = [
  {
    name: "list_plans",
    description:
      "List the scenario plans on this session with their state, thesis, expiry and branch count. " +
      "Call this BEFORE discussing, drafting or critiquing a plan — it is the only way to see what the " +
      "owner has already authored. States: draft (being written), planned (ARMED — the engine watches it " +
      "every closed bar), triggered (a branch fired), and closed/expired/invalidated/cancelled (finished). " +
      "Read-only: you cannot create, edit or arm a plan.",
    input_schema: {
      type: "object" as const,
      properties: {
        states: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional filter, e.g. [\"planned\",\"triggered\"] for plans the engine is actively watching. " +
            "Omit for all plans on the session.",
        },
      },
      required: [] as string[],
    },
  },
  {
    name: "get_plan",
    description:
      "Full detail of one plan: thesis, every stated assumption, the thesis invalidation, expiry, risk " +
      "budget, and each branch's trigger, entry, stop and targets. Use this before critiquing a plan or " +
      "answering a question about what it will do — list_plans gives the summary, this gives what the " +
      "owner actually committed to. Read-only.",
    input_schema: {
      type: "object" as const,
      properties: {
        plan_id: { type: "number", description: "Row id from list_plans." },
      },
      required: ["plan_id"],
    },
  },
  {
    name: "list_level_references",
    description:
      "List the named price levels on this pair that the ENGINE can resolve — the vocabulary a plan is " +
      "written in. Each has an id you can pass to draft_plan so the plan and the chart read one definition " +
      "instead of two. Call this before drafting: a plan built on a typed number when a reference already " +
      "exists creates a second definition of the same level.",
    input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "create_level_reference",
    description:
      "Name a price level so the engine and the chart share one definition of it. Use this when your " +
      "analysis lands on a level that matters (e.g. 72,400 is the shelf) — otherwise your conclusion stays " +
      "prose the owner has to retype. Creates a STATIC level at a specific price. It changes nothing that " +
      "trades; it only makes the level nameable.",
    input_schema: {
      type: "object" as const,
      properties: {
        label: { type: "string", description: "What this level is, in plain language, e.g. June supply shelf." },
        price: { type: "number", description: "The price." },
        interval_minutes: {
          type: "number",
          description:
            "Optional. The timeframe the level was read on. Omit for a level that holds on every timeframe, " +
            "which is the normal case for a horizontal price level.",
        },
      },
      required: ["label", "price"],
    },
  },
  {
    name: "draft_plan",
    description:
      "Save a scenario plan as a DRAFT for the owner to review and arm. You can never arm it — that is the " +
      "owner's signature, by design. Draft when the conversation has produced a real thesis: what you expect, " +
      "what must be true for it, what would prove it wrong, and by when. " +
      "A draft saves even if incomplete, so it is a place to think — but tell the owner what is still missing, " +
      "because arming refuses without ALL of: at least one assumption, a thesis invalidation, a future expiry " +
      "under 180 days, and a risk budget. " +
      "The invalidation is NOT the stop: a stop is where the trade is wrong, invalidation is where the THESIS " +
      "is, and it can fire while the position is in profit.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Short kebab-case name, e.g. range-break. Must be unique on this session." },
        thesis: { type: "string", description: "One sentence: what you expect to happen." },
        assumptions: {
          type: "array",
          items: { type: "string" },
          description: "What must be true for the thesis to work. At least one, or it cannot be armed.",
        },
        invalidation_price: {
          type: "number",
          description:
            "REQUIRED. Price at which the THESIS is wrong — not the stop. Ask the owner what would prove " +
            "this wrong before drafting; a plan cannot be stored without it.",
        },
        invalidation_direction: {
          type: "string",
          enum: ["below", "above"],
          description: "Whether the thesis dies below or above that price.",
        },
        expires_in_days: { type: "number", description: "Hard expiry. Under 180 — further out is a forecast, not a plan." },
        eval_interval: {
          type: "string",
          enum: EVAL_INTERVALS,
          description:
            "How often the plan is checked: one decision per closed bar of this size. Use the timeframe the " +
            "owner's conditions are written in — a 1m close trigger checked on 4h bars never fires. Defaults to 4h.",
        },
        risk_budget_quote: {
          type: "number",
          description: "Most this plan may risk, in quote currency. Ask the owner — there is no default, and a draft without one cannot arm.",
        },
        branches: {
          type: "array",
          description: "How the market might resolve. One per path. OCO by default: the first to fire cancels the rest.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "e.g. breakout, or rejection retest." },
              trigger_price: { type: "number", description: "Price that arms this path." },
              trigger_direction: {
                type: "string",
                enum: ["crosses_above", "crosses_below", "above", "below"],
                description: "How price must meet the trigger.",
              },
              entry_price: { type: "number", description: "Where the position opens. Omit if using entry_reference_id." },
              entry_reference_id: { type: "number", description: "Id from list_level_references, instead of a typed price." },
              stop_price: { type: "number", description: "Where the TRADE is wrong." },
              target_price: { type: "number", description: "Where it takes profit." },
              budget_share_pct: { type: "number", description: "Share of the plan budget, 0-100. OCO branches share one budget." },
            },
            required: ["label", "trigger_price", "trigger_direction", "stop_price", "target_price"],
          },
        },
      },
      required: ["name", "thesis", "invalidation_price"],
    },
  },
  {
    name: "update_draft",
    description:
      "Change a plan that is still a DRAFT — fill in a risk budget, fix a level, add an assumption. Use this " +
      "instead of drafting again: names are unique per session, so a second draft leaves the first behind. " +
      "Only the fields you pass change; the rest keep their stored value. Passing branches replaces them all. " +
      "It cannot arm, and it refuses any plan that is not a draft — armed terms are the owner's signature. " +
      "Change only what the owner asked for.",
    input_schema: {
      type: "object" as const,
      properties: {
        plan_id: { type: "number", description: "The draft's id from list_plans." },
        thesis: { type: "string", description: "One sentence: what you expect to happen." },
        assumptions: {
          type: "array",
          items: { type: "string" },
          description: "Replaces the whole list. What must be true for the thesis to work.",
        },
        invalidation_price: { type: "number", description: "Price at which the THESIS is wrong — not the stop." },
        invalidation_direction: { type: "string", enum: ["below", "above"] },
        expires_in_days: { type: "number", description: "Hard expiry, counted from now. Under 180." },
        eval_interval: { type: "string", enum: EVAL_INTERVALS, description: "How often the plan is checked." },
        risk_budget_quote: { type: "number", description: "Most this plan may risk, in quote currency." },
        branches: {
          type: "array",
          description: "Replaces every branch. Same shape as draft_plan's branches.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              trigger_price: { type: "number" },
              trigger_direction: { type: "string", enum: ["crosses_above", "crosses_below", "above", "below"] },
              entry_price: { type: "number" },
              entry_reference_id: { type: "number" },
              stop_price: { type: "number" },
              target_price: { type: "number" },
              budget_share_pct: { type: "number" },
            },
            required: ["label", "trigger_price", "trigger_direction", "stop_price", "target_price"],
          },
        },
      },
      required: ["plan_id"],
    },
  },
  {
    name: "get_calibration",
    description:
      "The owner's own track record, grouped by assumption tag, across every session. " +
      "Call this before drafting or critiquing a plan: it says how often theses of this kind actually " +
      "fired, how often the thesis was disproved after firing, and what share of the forecast move was " +
      "typically captured. " +
      "This is calibration of the PLANNER, not validation of a plan — a plan is a one-shot bet with no " +
      "sample and is never backtested. " +
      "Rates are null when too few plans have finished to quote one; say so plainly rather than " +
      "computing a percentage yourself from the counts. " +
      "Plans reported as unwatched are excluded because the app was closed for part of their life — " +
      "they are not misses and must never be described as such.",
    input_schema: {
      type: "object" as const,
      properties: {
        this_session_only: {
          type: "boolean",
          description: "Default false. The cross-session record is the useful one — a thesis type recurs across pairs.",
        },
      },
      required: [] as string[],
    },
  },
];

/** Order-flow and capability tools — what the app measures that indicators do not. */
export const CONTEXT_TOOLS = [
  {
    name: "get_order_flow",
    description:
      "Cumulative volume delta (CVD) and/or the volume profile (POC, VAH, VAL) for this pair — the " +
      "aggressor and volume-at-price picture that ordinary indicators cannot give you. Use it when the " +
      "question is about who is pressing (CVD slope versus price = divergence) or where volume actually " +
      "traded (POC/VAH/VAL as levels a thesis can be written on). " +
      "CVD coverage below 100% means the aggressor split is UNKNOWN for those bars, not that aggression " +
      "went flat — say so rather than reading the gap as data. The profile is candle-derived and " +
      "approximate: volume is spread across each bar range by a rule, not placed where it actually traded.",
    input_schema: {
      type: "object" as const,
      properties: {
        what: {
          type: "string",
          enum: ["cvd", "volume_profile", "both"],
          description: "Which measure to return. Defaults to both.",
        },
        interval_minutes: { type: "number", description: "1, 5, 15, 30, 60, 240 or 1440. Defaults to 240 (4H)." },
        bars: { type: "number", description: "How many recent bars to cover. Defaults to 200." },
      },
      required: [] as string[],
    },
  },
  {
    name: "get_app_capabilities",
    description:
      "What this app can and cannot actually do right now — venue connection, whether live orders are " +
      "possible, whether a stop can rest on the exchange, and whether plan execution is wired. " +
      "Call this BEFORE telling the owner what will happen when something triggers, or before describing " +
      "a capability as available. Answering from assumption is how the owner ends up believing a position " +
      "is protected when it is not.",
    input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
];

/** Phase 2 tools — indicators, strategies, backtests, alerts. */
export const PHASE2_TOOLS = [
  {
    name: "get_execution_basis",
    description:
      "Measured trading cost on the EXECUTION venue (Revolut X) versus the analysis feed (Binance), in " +
      "basis points. Candles and indicators are Binance prices, but orders fill on Revolut X — this tool " +
      "reports the real spread you would cross there, how far Revolut X's mid sits from Binance's, and how " +
      "many samples back the numbers. Consult it before claiming a strategy is profitable, especially for " +
      "short-hold or small-edge strategies: a 40bps round-trip cost destroys an edge that looked fine on " +
      "Binance mid prices. Returns sample_count 0 when the pair has not been measured yet — in that case say " +
      "so rather than assuming the cost is negligible.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair, e.g. BTC-USD. Defaults to the current session's pair if omitted.",
        },
        days: {
          type: "number",
          description: "Look-back window in days (default 30).",
        },
      },
      required: [] as string[],
    },
  },
  {
    name: "compute_indicators",
    description:
      "Compute one or more TA indicators for the session's pair (or an explicit symbol). Returns numeric values " +
      "aligned with candle timestamps. This is the primary way to read market state — always use this instead of " +
      "guessing indicator values. Supports RSI, MACD, Bollinger Bands, SMA, EMA, ATR, Stochastic, ADX, and many more.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair, e.g. BTC-USD. Defaults to the current session's pair.",
        },
        interval_minutes: {
          type: "number",
          description: "Candle interval in minutes. One of 1, 5, 15, 30, 60, 240, 1440. Defaults to 60.",
        },
        indicators: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Indicator name, e.g. 'rsi', 'macd', 'bbands', 'sma'." },
              params: {
                type: "object",
                description: "Indicator parameters, e.g. { period: 14 } for RSI. Use list_indicators to see available params.",
              },
            },
            required: ["name"],
          },
          description: "List of indicators to compute. Each needs a name and optional params (defaults used if omitted).",
        },
        limit: {
          type: "number",
          description: "Number of most recent values to return per indicator (max 200). Defaults to 50.",
        },
      },
      required: ["indicators"],
    },
  },
  {
    name: "list_indicators",
    description:
      "Returns the full catalog of available TA indicators with their parameter schemas, descriptions, and " +
      "categories. Use this to discover what indicators are available before computing them or writing strategy specs.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "manage_alerts",
    description:
      "Add, remove, or list alert conditions on the live data stream. Alerts use the same condition format as " +
      "strategy specs (indicator thresholds, price levels, volume spikes). They trigger once and notify the user. " +
      "Alerts are replayable in backtests (same evaluation path).",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["add", "remove", "list"],
          description: "What to do: add a new alert, remove one by ID, or list active alerts.",
        },
        alert_id: {
          type: "number",
          description: "Alert ID to remove (required for 'remove' action).",
        },
        label: {
          type: "string",
          description: "Human-readable label for the alert (required for 'add' action).",
        },
        condition: {
          type: "object",
          description:
            "Alert condition (required for 'add'). Must include:\n" +
            '- indicator: string (e.g. "rsi", "price", "volume", "macd")\n' +
            '- params: object (e.g. { period: 14 }), use {} for price/volume\n' +
            '- field?: string (for multi-output indicators, e.g. "histogram" for MACD; for price, one of open/high/low/close — defaults to close)\n' +
            '- operator: "above"|"below"|"crosses_above"|"crosses_below"|"between"\n' +
            '- value: number (or [low, high] for "between")',
        },
        symbol: {
          type: "string",
          description:
            "Trading pair the alert evaluates against, e.g. BTC-USD (for 'add'). Defaults to the session's pair. " +
            "Alerts only fire on candles for this exact pair — an RSI alert on BTC-USD never evaluates against ETH-USD ticks.",
        },
        interval_minutes: {
          type: "number",
          description:
            "Candle interval in minutes the condition is evaluated on (for 'add'). One of 1, 5, 15, 30, 60, 240, 1440. Defaults to 60.",
        },
      },
      required: ["action"],
    },
  },
];

/* ── executors ────────────────────────────────────────────────────── */

async function toolReadCandles(sessionId: number, input: Record<string, unknown>): Promise<unknown> {
  const session = getSessionById(sessionId);
  const symbol = (typeof input.symbol === "string" && input.symbol) || session?.pair;
  if (!symbol) throw new Error("No symbol provided and no session pair to default to");
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(symbol)) throw new Error("Invalid symbol format (expected e.g. BTC-USD)");

  const intervalMin =
    typeof input.interval_minutes === "number" && VALID_INTERVALS.includes(input.interval_minutes)
      ? input.interval_minutes
      : 60;
  const limit = Math.min(typeof input.limit === "number" ? input.limit : 100, 300);

  // Single analysis feed: Binance cache, auto-backfilled from Binance REST
  // when short. This used to fall back to a live Revolut X fetch when the
  // cache was empty, which meant the agent could reason about RevX prices
  // while the engine traded on Binance prices — the exact mixed-feed problem
  // the feed-roles rule exists to prevent.
  const candles = await getAnalysisCandles(symbol, intervalMin, limit);

  return {
    source: "binance (analysis feed)",
    symbol,
    interval_minutes: intervalMin,
    candles,
    note:
      candles.length === 0
        ? "No cached history and the Binance backfill returned nothing — check the symbol exists as a USDT pair."
        : undefined,
  };
}

function toolGetExecutionBasis(sessionId: number, input: Record<string, unknown>): unknown {
  const session = getSessionById(sessionId);
  const symbol = (typeof input.symbol === "string" && input.symbol) || session?.pair;
  if (!symbol) throw new Error("No symbol provided and no session pair to default to");

  const days = typeof input.days === "number" && input.days > 0 ? Math.min(input.days, 365) : 30;
  const stats = getBasisStats(symbol, Date.now() - days * 24 * 60 * 60 * 1000);

  return {
    ...stats,
    window_days: days,
    interpretation:
      stats.sampleCount === 0
        ? "No samples yet for this pair — the execution cost is UNMEASURED. Do not assume it is small."
        : `Round-trip cost of crossing Revolut X's book is roughly ${(stats.medianRevxSpreadBps ?? 0).toFixed(1)}bps ` +
          `(median spread), on top of fees. Binance's spread on the same pair is ` +
          `${(stats.medianBinSpreadBps ?? 0).toFixed(1)}bps, so backtests priced on Binance understate the real cost.`,
  };
}

function toolQueryTrades(sessionId: number, input: Record<string, unknown>): unknown {
  const limit = Math.min(typeof input.limit === "number" ? input.limit : 20, 200);
  const mode = typeof input.mode === "string" ? input.mode : "all";

  const modeClause = mode === "paper" || mode === "live" ? "AND mode = ?" : "";
  const params: (string | number)[] = [sessionId];
  if (modeClause) params.push(mode);
  params.push(limit);

  const trades = getDb()
    .prepare(
      `SELECT symbol, side, price, quantity, fee, fee_currency, mode, executed_at
       FROM trades WHERE session_id = ? ${modeClause}
       ORDER BY executed_at DESC LIMIT ?`
    )
    .all(...params);

  return { session_id: sessionId, mode, count: trades.length, trades };
}

function toolReadSessionMemory(sessionId: number, input: Record<string, unknown>): unknown {
  const limit = Math.min(typeof input.limit === "number" ? input.limit : 10, 50);
  const kind = typeof input.kind === "string" && (VALID_JOURNAL_KINDS as readonly string[]).includes(input.kind) ? input.kind : null;
  const query = typeof input.query === "string" && input.query.trim() ? input.query.trim() : null;

  if (query) {
    // FTS5 search scoped to this session (journal_fts has no session_id column,
    // so join back to journal and filter there).
    const kindClause = kind ? "AND j.kind = ?" : "";
    const params: (string | number)[] = [ftsQuery(query), sessionId];
    if (kind) params.push(kind);
    params.push(limit);

    const rows = getDb()
      .prepare(
        `SELECT j.kind, j.content, j.tags, j.created_at
         FROM journal_fts f JOIN journal j ON j.id = f.rowid
         WHERE journal_fts MATCH ? AND j.session_id = ? ${kindClause}
         ORDER BY j.created_at DESC LIMIT ?`
      )
      .all(...params);
    return { session_id: sessionId, query, count: rows.length, entries: rows };
  }

  const kindClause = kind ? "AND kind = ?" : "";
  const params: (string | number)[] = [sessionId];
  if (kind) params.push(kind);
  params.push(limit);

  const rows = getDb()
    .prepare(
      `SELECT kind, content, tags, created_at FROM journal
       WHERE session_id = ? ${kindClause} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params);
  return { session_id: sessionId, count: rows.length, entries: rows };
}

function toolWriteJournal(sessionId: number, input: Record<string, unknown>): unknown {
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) throw new Error("content is required");
  const kind = typeof input.kind === "string" ? (input.kind as JournalKind) : null;
  if (!kind || !(WRITABLE_JOURNAL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind must be one of: ${WRITABLE_JOURNAL_KINDS.join(", ")}`);
  }
  const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === "string").join(",") : "";

  const now = Date.now();
  const result = getDb()
    .prepare(`INSERT INTO journal (session_id, kind, content, tags, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(sessionId, kind, content, tags, now);

  auditLog("journal_written_by_agent", { sessionId, kind, journalId: result.lastInsertRowid });
  return { ok: true, id: result.lastInsertRowid, kind, created_at: now };
}

/* ── Phase 2 executors ───────────────────────────────────────────── */

async function toolComputeIndicators(sessionId: number, input: Record<string, unknown>): Promise<unknown> {
  const session = getSessionById(sessionId);
  const symbol = (typeof input.symbol === "string" && input.symbol) || session?.pair;
  if (!symbol) throw new Error("No symbol and no session pair");

  const intervalMin =
    typeof input.interval_minutes === "number" && VALID_INTERVALS.includes(input.interval_minutes)
      ? input.interval_minutes
      : 60;

  const limit = Math.min(typeof input.limit === "number" ? input.limit : 50, 200);

  if (!Array.isArray(input.indicators) || input.indicators.length === 0) {
    throw new Error("indicators must be a non-empty array");
  }

  const configs = (input.indicators as any[]).map((ind: any) => ({
    name: typeof ind.name === "string" ? ind.name : "",
    params: (typeof ind.params === "object" && ind.params) || {},
  }));

  const results = await computeIndicatorBatch(symbol, intervalMin, configs, { limit });

  // Trim to the last `limit` values for each result
  const trimmed = results.map((r) => ({
    name: r.name,
    params: r.params,
    values: r.values.slice(-limit),
    timestamps: r.timestamps.slice(-limit),
  }));

  return { symbol, interval_minutes: intervalMin, indicators: trimmed };
}

function toolListIndicators(): unknown {
  return { indicators: listIndicators() };
}

/**
 * A stored level → something the model can reason about.
 *
 * Derived levels report `resolvedAtArm` **labelled as the value at arming**,
 * never as the current price. Same rule the renderer follows: a stale number
 * presented as live is how a reader concludes the wrong thing, and the model is
 * a reader. Resolving live here would also mean the agent computing its own
 * answer for a level the resolver owns — two definitions of one value.
 */
function describeLevel(level: unknown): unknown {
  if (!level || typeof level !== "object") return null;
  const l = level as Record<string, unknown>;
  if (l.kind === "static" && typeof l.price === "number") {
    return { kind: "price", value: l.price };
  }
  let source: string | null = null;
  try {
    source = formatLevel(level as PriceLevel);
  } catch {
    /* Unknown shape: report the number without a name rather than nothing. */
  }
  return {
    kind: "derived",
    source,
    value_at_arm: typeof l.resolvedAtArm === "number" ? l.resolvedAtArm : null,
    note: "Value measured when the plan was armed, not the current value. A developing level has moved since.",
  };
}

/** Plans on this session. Summary only — `get_plan` carries the detail. */
function toolListPlans(sessionId: number, input: Record<string, unknown>): unknown {
  const states = Array.isArray(input.states)
    ? (input.states.filter((v) => typeof v === "string") as string[])
    : undefined;
  const plans = planService.listPlans(sessionId, states as never);
  /* Which branches hold an open position right now. "Triggered" alone said
     nothing about it, and the agent told the owner that plans whose entries the
     kill switch had refused were "in a paper position, managed by the engine". */
  const openBranches = new Set(
    (getDb()
      .prepare(`SELECT plan_branch_id FROM paper_positions WHERE status = 'open' AND session_id = ? AND plan_branch_id IS NOT NULL`)
      .all(sessionId) as Array<{ plan_branch_id: number }>).map((r) => r.plan_branch_id)
  );
  return {
    session_id: sessionId,
    count: plans.length,
    /* Said explicitly because the state name alone does not carry it, and the
       distinction decides what the honest answer to "paper trade this" is. */
    watched_states_note:
      "'planned' means ARMED: the engine evaluates expiry, thesis invalidation and drift on every closed bar. " +
      "When a branch triggers, the engine opens a paper position with that branch's stop and target, unless the " +
      "entry is refused (kill switch, paused session, price already past the stop or target, no paper cash). " +
      "So a 'triggered' plan may hold no position: read each branch's position field. There is no real-money order path.",
    plans: plans.map((p) => ({
      plan_id: p.rowId,
      name: p.slug,
      state: p.state,
      pair: p.pair,
      thesis: p.thesis,
      assumption_count: p.assumptions.length,
      expires_at: p.expiresAt,
      /* Readable, and relative: a model given only ms epoch reported the raw number. */
      expires_local: new Date(p.expiresAt).toLocaleString(),
      minutes_until_expiry: Math.round((p.expiresAt - Date.now()) / 60_000),
      expired: p.expiresAt <= Date.now(),
      risk_budget_quote: p.risk?.maxQuote ?? null,
      eval_interval: p.evalInterval,
      oco_exclusive: p.ocoExclusive,
      branches: p.branches.map((b) => ({
        id: b.id,
        status: b.status,
        position:
          b.status !== "triggered"
            ? "none"
            : b.positionId === null
              ? "none — the entry was refused when it triggered"
              : openBranches.has(b.rowId)
                ? "open"
                : "closed",
      })),
      armed_at: p.armedAt,
      outcome_reason: p.outcomeReason,
    })),
  };
}

/** One plan, in full — what the owner actually committed to. */
function toolGetPlan(sessionId: number, input: Record<string, unknown>): unknown {
  const planId = typeof input.plan_id === "number" ? input.plan_id : NaN;
  if (!Number.isFinite(planId)) throw new Error("get_plan needs a numeric plan_id from list_plans.");

  const plan = planService.getPlan(planId);
  if (!plan) throw new Error(`No plan with id ${planId}.`);
  /* Session-scoped like every other tool here: a plan belongs to one session's
     epoch, and reading across sessions would let context from an archived pair
     leak into a live conversation. */
  if (plan.sessionId !== sessionId) {
    throw new Error(`Plan ${planId} belongs to a different session.`);
  }

  return {
    plan_id: plan.rowId,
    name: plan.slug,
    state: plan.state,
    pair: plan.pair,
    thesis: plan.thesis,
    assumptions: plan.assumptions.map((a) => a.text),
    /* The distinction the owner most needs held: a stop is where the TRADE is
       wrong, invalidation is where the THESIS is. It can fire in profit. */
    thesis_invalidation: describeThreshold(triggerValueOf(plan.invalidation)),
    expires_at: plan.expiresAt,
    /* Readable, and relative: a model given only ms epoch reported the raw number. */
    expires_local: new Date(plan.expiresAt).toLocaleString(),
    minutes_until_expiry: Math.round((plan.expiresAt - Date.now()) / 60_000),
    expired: plan.expiresAt <= Date.now(),
    risk_budget_quote: plan.risk?.maxQuote ?? null,
    oco_exclusive: plan.ocoExclusive,
    eval_interval: plan.evalInterval,
    armed_at: plan.armedAt,
    outcome_reason: plan.outcomeReason,
    branches: plan.branches.map((b) => ({
      id: b.id,
      label: b.label,
      status: b.status,
      triggered_at: b.triggeredAt ?? null,
      /* Null on a fired branch is a real state, not missing data: the
         trigger fired but no position opened (refused — e.g. not enough
         paper cash — and audited as a refusal). */
      position_id: b.positionId ?? null,
      budget_share_pct: b.budgetSharePct,
      trigger: describeThreshold(triggerValueOf(b.trigger)),
      entry: describeLevel(b.entry),
      stop: describeLevel(b.stop),
      targets: (b.targets ?? []).map(describeLevel),
    })),
  };
}

/** Pull the comparison value out of a stored ConditionGroup for description.
 *  Reading the engine's shape is fine; constructing it here would not be. */
function triggerValueOf(group: unknown): unknown {
  const g = group as { conditions?: Array<{ value?: unknown }> } | null;
  return g?.conditions?.[0]?.value ?? null;
}

/** Named levels on this session's pair — the vocabulary a plan is written in. */
function toolListLevelReferences(sessionId: number): unknown {
  const session = getSessionById(sessionId);
  if (!session) throw new Error("Session not found.");
  const refs = levelRefService.listLevelReferences(session.pair);
  return {
    pair: session.pair,
    count: refs.length,
    note:
      "Pass a reference id to draft_plan instead of typing the price again — the chart and the engine then " +
      "read one definition of the level rather than two.",
    references: refs.map((r) => ({
      reference_id: r.id,
      label: r.label,
      level: describeLevel(r.level),
      interval_minutes: r.interval_min,
      has_drawing: r.drawing_id !== null,
    })),
  };
}

/**
 * Name a level so the engine and the chart share one definition.
 *
 * Static only, deliberately. A derived level (anchored VWAP, volume profile)
 * carries a window, a drift tolerance and an `onDrift` policy that decide
 * whether an armed plan keeps trading as the level moves — choices with real
 * money behind them, and not ones to infer from a sentence in chat. The owner
 * promotes those from a drawing on Research, where the window is visible.
 */
function toolCreateLevelReference(sessionId: number, input: Record<string, unknown>): unknown {
  const session = getSessionById(sessionId);
  if (!session) throw new Error("Session not found.");

  const label = typeof input.label === "string" ? input.label.trim() : "";
  const price = typeof input.price === "number" ? input.price : NaN;
  if (!label) throw new Error("create_level_reference needs a label.");
  if (!Number.isFinite(price)) throw new Error("create_level_reference needs a finite price.");

  const intervalMin =
    typeof input.interval_minutes === "number" && Number.isFinite(input.interval_minutes)
      ? input.interval_minutes
      : null;

  const ref = levelRefService.saveLevelReference({
    symbol: session.pair,
    intervalMin,
    label,
    level: { kind: "static", price },
    drawingId: null,
  });

  auditLog("agent_created_level_reference", { sessionId, referenceId: ref.id, label, price });
  return {
    reference_id: ref.id,
    label: ref.label,
    price,
    pair: session.pair,
    note: "Created. It is now selectable when authoring a plan, and drawn on Charts as a locked line.",
  };
}

/** A branch as the model describes it, before compilation. */
interface DraftBranchInput {
  label?: unknown;
  trigger_price?: unknown;
  trigger_direction?: unknown;
  entry_price?: unknown;
  entry_reference_id?: unknown;
  stop_price?: unknown;
  target_price?: unknown;
  budget_share_pct?: unknown;
}

const DAY_MS = 86_400_000;

/**
 * Branches as the agent wrote them → branches as `PlanInput` takes them.
 *
 * A reference id becomes the reference's own level, so the plan and the chart
 * stay one definition. An unknown id is refused rather than silently falling
 * back to a typed price — a plan quietly built on a different level than the
 * agent named is the failure this whole layer exists to prevent.
 */
function parseDraftBranches(rawBranches: DraftBranchInput[]): planService.PlanInput["branches"] {
  const levelFor = (price: unknown, refId: unknown): Record<string, unknown> | null => {
    if (typeof refId === "number") {
      const ref = levelRefService.getLevelReference(refId);
      if (!ref) throw new Error(`No level reference with id ${refId}.`);
      return ref.level as unknown as Record<string, unknown>;
    }
    return typeof price === "number" && Number.isFinite(price)
      ? { kind: "static", price }
      : null;
  };

  return rawBranches.map((b, i) => {
    const label = typeof b.label === "string" && b.label.trim() ? b.label.trim() : `branch ${i + 1}`;
    const op =
      b.trigger_direction === "crosses_below" || b.trigger_direction === "above" || b.trigger_direction === "below"
        ? (b.trigger_direction as "crosses_below" | "above" | "below")
        : "crosses_above";
    return {
      id: `branch-${i + 1}`,
      label,
      trigger: {
        subject: "price" as const,
        operator: op,
        value: typeof b.trigger_price === "number" ? b.trigger_price : NaN,
      },
      entry: (levelFor(b.entry_price, b.entry_reference_id) ?? {}) as never,
      stop: (levelFor(b.stop_price, undefined) ?? {}) as never,
      targets: [levelFor(b.target_price, undefined)].filter(Boolean) as never,
      budgetSharePct:
        typeof b.budget_share_pct === "number" && Number.isFinite(b.budget_share_pct)
          ? b.budget_share_pct
          : rawBranches.length > 0
            ? Math.floor(100 / rawBranches.length)
            : 100,
    };
  });
}

/** A bar size the monitor knows, or null. An unknown value is refused rather
 *  than coerced: the check interval is a term the owner signs. */
function parseEvalInterval(v: unknown): EvalInterval | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && (EVAL_INTERVALS as string[]).includes(v)) return v as EvalInterval;
  throw new Error(`eval_interval must be one of ${EVAL_INTERVALS.join(", ")}.`);
}

/**
 * Save a plan as a DRAFT. Never armed — that is the owner's signature.
 *
 * The gate deliberately does not run here: `createPlan` stores anything, and
 * `armPlan` is where falsifiability is enforced. A draft is where thinking
 * happens, and refusing to save an incomplete thought pushes authoring back
 * into a text file. What this DOES do is report what is still missing, so the
 * agent can tell the owner rather than leaving them to discover it at the gate.
 */
function toolDraftPlan(sessionId: number, input: Record<string, unknown>): unknown {
  const session = getSessionById(sessionId);
  if (!session) throw new Error("Session not found.");

  const name = typeof input.name === "string" ? input.name.trim() : "";
  const thesis = typeof input.thesis === "string" ? input.thesis.trim() : "";
  if (!name) throw new Error("draft_plan needs a name.");
  if (!thesis) throw new Error("draft_plan needs a thesis.");

  const assumptions = Array.isArray(input.assumptions)
    ? input.assumptions.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : [];

  /* Required, and the storage layer is why: `createPlan` compiles every
     authored condition up front and refuses a non-numeric one rather than
     storing an empty ConditionGroup — the S2-8 fix, because an empty group
     would later read as a *missing* invalidation three steps from its cause.
     So there is no such thing as a saved plan without one.

     That constraint is a feature here. "What would prove this wrong?" is the
     question the gate exists to force, and refusing at the tool with a reason
     makes the agent ask it rather than saving something that cannot arm. */
  const invalidationPrice =
    typeof input.invalidation_price === "number" && Number.isFinite(input.invalidation_price)
      ? input.invalidation_price
      : null;
  if (invalidationPrice === null) {
    throw new Error(
      "draft_plan needs invalidation_price — the price at which the THESIS is wrong. " +
        "It is not the stop: a stop is where the trade is wrong, and an invalidation can fire while the " +
        "position is in profit. Ask the owner what would prove this thesis wrong, then draft it."
    );
  }
  const invalidationDir = input.invalidation_direction === "above" ? "above" : "below";

  const expiresInDays =
    typeof input.expires_in_days === "number" && Number.isFinite(input.expires_in_days)
      ? input.expires_in_days
      : 14;

  const riskBudget =
    typeof input.risk_budget_quote === "number" && Number.isFinite(input.risk_budget_quote)
      ? input.risk_budget_quote
      : 0;

  const rawBranches: DraftBranchInput[] = Array.isArray(input.branches)
    ? (input.branches as DraftBranchInput[])
    : [];
  const branches = parseDraftBranches(rawBranches);
  /* Defaults the owner did not choose. Each is a term they will sign at
     arming, so the agent is told to name them rather than let them pass as
     agreed. The risk budget has no default: an absent one stays absent, and
     the gate lists it. */
  const defaults: string[] = [];
  if (!(typeof input.expires_in_days === "number" && Number.isFinite(input.expires_in_days))) {
    defaults.push("expiry 14 days from now");
  }
  if (rawBranches.length > 1 && rawBranches.some((b) => typeof b.budget_share_pct !== "number")) {
    defaults.push("branch budget shares split evenly");
  }
  const evalInterval = parseEvalInterval(input.eval_interval);
  if (evalInterval === null) defaults.push("checked every 4h bar");

  const res = planService.createPlan({
    sessionId,
    slug: name,
    pair: session.pair,
    thesis,
    assumptions: assumptions.map((text) => ({ text })),
    invalidation: {
      subject: "price",
      operator: invalidationDir,
      value: invalidationPrice ?? NaN,
    },
    expiresAt: Date.now() + expiresInDays * DAY_MS,
    risk: { maxQuote: riskBudget },
    ocoExclusive: true,
    evalInterval: evalInterval ?? "4h",
    branches,
  } as never);

  if (!res.ok) return { created: false, reason: res.reason };

  /* The gate arming will run, run now — the same list the Plans page shows on
     the draft, so the agent and the owner read one answer. */
  const missing = res.plan.missingBeforeArming ?? [];

  auditLog("agent_drafted_plan", { sessionId, planId: res.plan.rowId, slug: name, missing, defaults });

  return {
    created: true,
    plan_id: res.plan.rowId,
    name,
    state: "draft",
    missing_before_arming: missing,
    defaults_applied: defaults,
    note:
      (missing.length === 0
        ? "Saved as a draft. Only the owner can arm it — tell them it is ready to review on the Plans page."
        : `Saved as a draft, but it cannot be armed until: ${missing.join(" ")} Tell the owner what is missing, ` +
          "and use update_draft to fill it in once they say.") +
      ` Tell the owner these terms were defaulted, not chosen: ${defaults.join("; ")}.`,
  };
}

/**
 * Change a DRAFT the agent or the owner wrote. Never arms, and refuses any plan
 * that is not a draft — `updatePlan` enforces that, so an armed plan stays the
 * terms that were signed.
 *
 * Exists because names are unique per session: without it a fix meant a second
 * draft under a new name, leaving the broken one behind on the Plans page.
 * Fields left out keep their stored value.
 */
function toolUpdateDraft(sessionId: number, input: Record<string, unknown>): unknown {
  const planId = typeof input.plan_id === "number" ? input.plan_id : NaN;
  if (!Number.isFinite(planId)) throw new Error("update_draft needs a numeric plan_id from list_plans.");
  const plan = planService.getPlan(planId);
  if (!plan) throw new Error(`No plan with id ${planId}.`);
  if (plan.sessionId !== sessionId) throw new Error(`Plan ${planId} belongs to a different session.`);
  if (plan.state !== "draft") {
    throw new Error(
      `Plan ${planId} is ${plan.state}, not a draft. Armed terms were signed by the owner and cannot be edited.`
    );
  }
  const base = planService.toPlanInput(plan);
  if (!base) throw new Error(`Plan ${planId} has a condition this tool cannot represent. Ask the owner to edit it.`);

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const changed: string[] = [];
  const next = { ...base };

  if (typeof input.thesis === "string" && input.thesis.trim()) {
    next.thesis = input.thesis.trim();
    changed.push("thesis");
  }
  if (Array.isArray(input.assumptions)) {
    next.assumptions = input.assumptions
      .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
      .map((text) => ({ text: text.trim() }));
    changed.push("assumptions");
  }
  const invPrice = num(input.invalidation_price);
  if (invPrice !== null || input.invalidation_direction !== undefined) {
    next.invalidation = {
      subject: "price",
      operator:
        input.invalidation_direction === "above" || input.invalidation_direction === "below"
          ? input.invalidation_direction
          : base.invalidation.operator,
      value: invPrice ?? base.invalidation.value,
    };
    changed.push("invalidation");
  }
  const days = num(input.expires_in_days);
  if (days !== null) {
    next.expiresAt = Date.now() + days * DAY_MS;
    changed.push("expiry");
  }
  const interval = parseEvalInterval(input.eval_interval);
  if (interval !== null) {
    next.evalInterval = interval;
    changed.push("check interval");
  }
  const budget = num(input.risk_budget_quote);
  if (budget !== null) {
    next.risk = { ...base.risk, maxQuote: budget };
    changed.push("risk budget");
  }
  if (Array.isArray(input.branches)) {
    next.branches = parseDraftBranches(input.branches as DraftBranchInput[]);
    changed.push("branches");
  }
  if (changed.length === 0) throw new Error("update_draft was given nothing to change.");

  const res = planService.updatePlan(planId, next);
  if (!res.ok) return { updated: false, reason: res.reason };

  const missing = planService.getPlan(planId)?.missingBeforeArming ?? [];
  auditLog("agent_updated_draft", { sessionId, planId, slug: plan.slug, changed, missing });

  return {
    updated: true,
    plan_id: planId,
    name: plan.slug,
    state: "draft",
    changed,
    missing_before_arming: missing,
    note:
      missing.length === 0
        ? "Draft updated. Only the owner can arm it — tell them it is ready to review on the Plans page."
        : `Draft updated, but it cannot be armed until: ${missing.join(" ")} Tell the owner what is missing.`,
  };
}

/** CVD and the volume profile — the order-flow picture indicators cannot give. */
function toolGetOrderFlow(sessionId: number, input: Record<string, unknown>): unknown {
  const session = getSessionById(sessionId);
  if (!session) throw new Error("Session not found.");

  const what = typeof input.what === "string" ? input.what : "both";
  const intervalMin =
    typeof input.interval_minutes === "number" && Number.isFinite(input.interval_minutes)
      ? input.interval_minutes
      : 240;
  const bars = typeof input.bars === "number" && Number.isFinite(input.bars) ? input.bars : 200;

  const out: Record<string, unknown> = { pair: session.pair, interval_minutes: intervalMin };

  if (what === "cvd" || what === "both") {
    const cvd = getCvdSeries(session.pair, intervalMin, { limit: bars });
    const points = cvd.points ?? [];
    const known = points.filter((pt) => pt.cvd !== null);
    const first = known[0]?.cvd ?? null;
    const last = known[known.length - 1]?.cvd ?? null;
    out.cvd = {
      coverage: cvd.coverage,
      /* Stated rather than left to inference: a gap is missing knowledge, not
         an observation of flat aggression. */
      coverage_note:
        cvd.coverage >= 0.999
          ? "Every bar has a known aggressor split."
          : "Some bars have an UNKNOWN aggressor split. The gap is missing data, not flat aggression — say so, and point at Settings › Analysis feed to repair it.",
      bars: points.length,
      first_known: first,
      last_known: last,
      change: first !== null && last !== null ? last - first : null,
      direction: first !== null && last !== null ? (last > first ? "buyers pressing" : "sellers pressing") : "unknown",
      note: "Binance SPOT flow. It says nothing about the execution venue's own book. Only slope and divergence against price carry information — the absolute value is arbitrary.",
    };
  }

  if (what === "volume_profile" || what === "both") {
    const profile = getVolumeProfile({ symbol: session.pair, intervalMin });
    out.volume_profile = {
      poc: profile.poc,
      vah: profile.vah,
      val: profile.val,
      bin_width: profile.binWidth,
      bin_width_was_suggested: profile.binWidthWasSuggested,
      approximate: true,
      note: "Candle-derived: volume is spread across each bar's range by a rule, not placed where it actually traded. The rule materially moves the POC — never present these as exact.",
    };
  }

  return out;
}

/**
 * What the app can actually do, read from the adapter rather than asserted.
 *
 * Exists because the agent had no way to check and would otherwise answer from
 * assumption — and the assumption that a stop is protecting a position when it
 * is not is the most expensive thing it could get wrong.
 */
/**
 * The owner's track record, for the agent to reason with.
 *
 * Returned with the honesty rules attached rather than as bare numbers: a
 * withheld rate and an unwatched plan are both easy to paper over in prose, and
 * a model left to itself will helpfully compute the percentage from the counts.
 */
function toolGetCalibration(sessionId: number, input: any) {
  const rec = buildCalibration(input?.this_session_only ? sessionId : undefined);
  return {
    scope: input?.this_session_only ? "this session" : "all sessions",
    finished_plans: rec.overall.resolved,
    still_running: rec.stillOpen,
    min_sample_for_a_rate: rec.minSample,
    by_tag: rec.tags.map((t) => ({
      tag: t.tag ?? "untagged",
      finished: t.resolved,
      triggered: t.triggered,
      disproved_after_triggering: t.invalidatedAfterTrigger,
      expired_without_firing: t.expiredUnfired,
      reached_target: t.reachedTarget,
      stopped_out: t.stoppedOut,
      trigger_rate: t.triggerRate,
      invalidation_rate: t.invalidationRate,
      typical_share_of_forecast_move_captured: t.capturedShare,
      excluded_unwatched: t.unwatched,
    })),
    note:
      "Calibration of the planner, not validation of a plan. A null rate means too few plans have " +
      "finished to quote one — do not compute it from the counts. Plans counted as excluded_unwatched " +
      "were running while the app was closed; they are not misses.",
  };
}

function toolGetAppCapabilities(): unknown {
  const venue = venueCapabilities();
  return {
    venue: {
      name: venue.displayName,
      can_place_orders: venue.canPlaceOrders,
      stop_can_rest_on_exchange: venue.venueSideProtectiveOrders,
      oco_on_exchange: venue.venueSideOco,
      daily_order_limit: venue.dailyOrderLimit,
    },
    analysis_feed: "Binance (spot). Charts, indicators and every level the engine resolves.",
    /* Hardcoded because they are facts about this build, not about the venue,
       and stating them wrongly is what produced the strategy answer. */
    plan_execution:
      "Armed plans ARE monitored every closed bar — expiry, thesis invalidation and drift all act and " +
      "transition the plan. A triggered branch opens a PAPER position carrying that branch's stop and target; " +
      "stops and targets are managed intrabar and the close is reviewed. There is no real-money order path.",
    paper_trading:
      "The paper engine executes plan positions with one fill model (shared with the frozen backtester). Paper only.",
    you_cannot:
      "Place, amend or cancel any order; arm a plan; choose the venue. Those are the owner's signature or pure code, by design.",
    never_mix:
      "Analysis prices come from the feed, execution truth from the venue. Never blend them in one number.",
  };
}

function toolManageAlerts(sessionId: number, input: Record<string, unknown>): unknown {
  const action = typeof input.action === "string" ? input.action : "";

  switch (action) {
    case "add": {
      const label = typeof input.label === "string" ? input.label : "Unnamed alert";
      const condition = input.condition as Condition;
      if (!condition || typeof condition !== "object" || !condition.indicator) {
        throw new Error(
          'condition must be a valid Condition object: { indicator: string, params: {}, operator: "above"|"below"|"crosses_above"|"crosses_below"|"between", value: number }'
        );
      }
      const VALID_OPERATORS = ["above", "below", "crosses_above", "crosses_below", "between"];
      if (!condition.operator || !VALID_OPERATORS.includes(condition.operator)) {
        throw new Error(`condition.operator must be one of: ${VALID_OPERATORS.join(", ")}`);
      }
      if (condition.operator === "between") {
        if (!Array.isArray(condition.value) || condition.value.length !== 2) {
          throw new Error('condition.value must be [low, high] for "between" operator');
        }
      } else if (typeof condition.value !== "number") {
        throw new Error(`condition.value must be a number for "${condition.operator}" operator`);
      }
      if (!condition.params || typeof condition.params !== "object") {
        condition.params = {};
      }
      const session = getSessionById(sessionId);
      const symbol = (typeof input.symbol === "string" && input.symbol) || session?.pair;
      if (!symbol) throw new Error("No symbol provided and no session pair to default to");
      if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(symbol)) throw new Error("Invalid symbol format (expected e.g. BTC-USD)");
      const intervalMin =
        typeof input.interval_minutes === "number" && VALID_INTERVALS.includes(input.interval_minutes)
          ? input.interval_minutes
          : 60;
      const alert = alertEngine.addAlert(condition, label, symbol, intervalMin, sessionId, agentActor(sessionId));
      return {
        ok: true,
        alert: { id: alert.id, label: alert.label, symbol: alert.symbol, interval_minutes: alert.intervalMin, status: alert.status },
      };
    }
    case "remove": {
      const alertId = typeof input.alert_id === "number" ? input.alert_id : 0;
      if (!alertId) throw new Error("alert_id is required for remove action");
      /* Only this session's alerts, and only one that exists: "removed" for an
         id that matched nothing is a success the log would record as fact. */
      if (!alertEngine.getSessionAlerts(sessionId).some((a) => a.id === alertId)) {
        return { error: `No alert ${alertId} in this session. Call manage_alerts with action "list" for the ids.` };
      }
      if (!alertEngine.removeAlert(alertId, agentActor(sessionId))) {
        return { error: `Alert ${alertId} was already removed.` };
      }
      return { ok: true, removed: alertId };
    }
    case "list": {
      const alerts = alertEngine.getSessionAlerts(sessionId);
      return {
        session_id: sessionId,
        count: alerts.length,
        alerts: alerts.map((a) => ({
          id: a.id,
          label: a.label,
          symbol: a.symbol,
          interval_minutes: a.intervalMin,
          condition: a.condition,
          status: a.status,
          created_at: a.created_at,
        })),
      };
    }
    default:
      throw new Error('action must be "add", "remove", or "list"');
  }
}

/** Dispatches a tool_use call by name. Throws on unknown tool or bad input. */
export async function executeSessionTool(
  name: string,
  input: Record<string, unknown>,
  sessionId: number
): Promise<unknown> {
  switch (name) {
    case "read_candles":
      return toolReadCandles(sessionId, input);
    case "query_trades":
      return toolQueryTrades(sessionId, input);
    case "read_session_memory":
      return toolReadSessionMemory(sessionId, input);
    case "write_journal":
      return toolWriteJournal(sessionId, input);
    case "get_execution_basis":
      return toolGetExecutionBasis(sessionId, input);
    case "compute_indicators":
      return toolComputeIndicators(sessionId, input);
    case "list_indicators":
      return toolListIndicators();
    case "manage_alerts":
      return toolManageAlerts(sessionId, input);
    case "list_plans":
      return toolListPlans(sessionId, input);
    case "get_plan":
      return toolGetPlan(sessionId, input);
    case "list_level_references":
      return toolListLevelReferences(sessionId);
    case "create_level_reference":
      return toolCreateLevelReference(sessionId, input);
    case "draft_plan":
      return toolDraftPlan(sessionId, input);
    case "update_draft":
      return toolUpdateDraft(sessionId, input);
    case "get_order_flow":
      return toolGetOrderFlow(sessionId, input);
    case "get_app_capabilities":
      return toolGetAppCapabilities();
    case "get_calibration":
      return toolGetCalibration(sessionId, input);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Tools that act on one session's data. In the general conversation — the
 * agent with no session open — they are not offered, and refused if called
 * anyway (`chat.ts`), because they would read or write against session 0.
 * Everything else (web, browser, derivatives, indicator catalogue, app
 * capabilities, the cross-session calibration record) works without one.
 */
export const SESSION_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  "read_candles",
  "query_trades",
  "read_session_memory",
  "write_journal",
  "get_execution_basis",
  "compute_indicators",
  "manage_alerts",
  "list_plans",
  "get_plan",
  "list_level_references",
  "create_level_reference",
  "draft_plan",
  "update_draft",
  "get_order_flow",
]);
