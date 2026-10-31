/**
 * What the agent has cost, measured from what the API actually returned.
 *
 * ## Why this is spend and not "credit remaining"
 *
 * There is no balance endpoint for a normal API key. Anthropic's cost and usage
 * reports live on the **Admin API** and need an admin key (`sk-ant-admin…`),
 * which this app does not hold and should not ask for — an admin key can read
 * and change the whole organisation, which is a far larger blast radius than
 * "show me a number".
 *
 * So the honest thing to show is **what this app spent**, which it can measure
 * exactly: every response carries a `usage` block. A "credit remaining" figure
 * would have to be inferred from a starting balance the app was told once and
 * cannot verify, and it would drift silently the moment anything else on the
 * account spent a token. A number that looks authoritative and is quietly wrong
 * is this project's recurring defect; a number that is exactly right about a
 * narrower thing is worth more.
 *
 * ## Cost is frozen at write time
 *
 * The dollar figure is computed when the row is written, not when it is read.
 * Prices change — Sonnet 5 has an introductory rate that ends — and recomputing
 * history at today's prices would silently rewrite what was actually paid.
 *
 * ## One bill, not one per mode
 *
 * This lives in the **shared** store. The Anthropic bill is a fact about the
 * account, not about simulated or live trading, and keeping it per mode meant
 * the readout under-reported by whatever the other mode had cost — a number
 * labelled "what I have spent" that was really "what I spent in this world".
 * The `mode` column keeps attribution without splitting the total.
 *
 * ## An unpriced model costs `null`, never zero
 *
 * A model missing from the table records its tokens with no cost. Zero would be
 * indistinguishable from "free" and would quietly under-report the total; null
 * lets the UI say "3 calls not priced" instead of lying by omission.
 */

import { getSharedStore } from "../db/shared-store";
import { appMode } from "../modes/app-mode";
import { createLogger } from "../logger";

const log = createLogger("usage");

/** What the call was for, so a bill can be attributed rather than just totalled. */
export type UsagePurpose = "chat" | "trade_review" | "plan_review" | "lessons" | "other";

/**
 * USD per million tokens, as published. Cache reads are ~0.1× input and cache
 * writes ~1.25× (5-minute TTL), which is what the arithmetic below applies.
 *
 * Deliberately a plain table rather than a lookup against the Models API: it is
 * the price *at the time of the call* that matters, and a live lookup would
 * reprice history. Prefix matching, so a dated snapshot id resolves to its
 * family without needing a row per release.
 */
const PRICES: Array<{ prefix: string; inputPerM: number; outputPerM: number }> = [
  { prefix: "claude-fable-5", inputPerM: 10, outputPerM: 50 },
  { prefix: "claude-mythos-5", inputPerM: 10, outputPerM: 50 },
  { prefix: "claude-opus-5", inputPerM: 5, outputPerM: 25 },
  { prefix: "claude-opus-4", inputPerM: 5, outputPerM: 25 },
  { prefix: "claude-sonnet-5", inputPerM: 3, outputPerM: 15 },
  { prefix: "claude-sonnet-4", inputPerM: 3, outputPerM: 15 },
  { prefix: "claude-haiku-4", inputPerM: 1, outputPerM: 5 },
];

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Null when the model is not in the table — unknown is a value, not zero. */
export function estimateCostUsd(model: string, u: TokenUsage): number | null {
  const price = PRICES.find((p) => model.startsWith(p.prefix));
  if (!price) return null;
  const inTok = u.input_tokens ?? 0;
  const outTok = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return (
    (inTok * price.inputPerM +
      cacheRead * price.inputPerM * CACHE_READ_MULTIPLIER +
      cacheWrite * price.inputPerM * CACHE_WRITE_MULTIPLIER +
      outTok * price.outputPerM) /
    1_000_000
  );
}

/**
 * Record one API call.
 *
 * Never throws: accounting must not be able to take down the thing it is
 * accounting for. A dropped row understates the total, which is visible; an
 * exception mid-stream would lose the owner's answer.
 */
export function recordUsage(
  model: string,
  purpose: UsagePurpose,
  u: TokenUsage | null | undefined,
  /* Accepted and ignored. Session ids are mode-local, so one in a shared table
     would point at a different session in each database file — the `mode`
     column carries the attribution that is actually meaningful. */
  _sessionId?: number | null
): void {
  if (!u) return;
  try {
    const cost = estimateCostUsd(model, u);
    getSharedStore()
      .prepare(
        `INSERT INTO api_usage (mode, model, purpose, input_tokens, output_tokens,
                                cache_read_tokens, cache_write_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        appMode(),
        model,
        purpose,
        u.input_tokens ?? 0,
        u.output_tokens ?? 0,
        u.cache_read_input_tokens ?? 0,
        u.cache_creation_input_tokens ?? 0,
        cost === null ? null : cost.toString(),
        Date.now()
      );
  } catch (err) {
    log.error("Could not record API usage", err);
  }
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Calls whose model had no published price here. Reported, not hidden. */
  unpricedCalls: number;
}

export interface UsageReport {
  today: UsageTotals;
  last30Days: UsageTotals;
  allTime: UsageTotals;
  byModel: Array<{ model: string; calls: number; costUsd: number; unpriced: number }>;
  byPurpose: Array<{ purpose: string; calls: number; costUsd: number }>;
  /** What the cache has saved, in dollars, against paying full input price. */
  cacheSavedUsd: number;
  /** Per mode, so a cost can be attributed without splitting the total. */
  byMode: Array<{ mode: string; calls: number; costUsd: number }>;
  /** Stated so the UI never implies this is an account balance. */
  scope: string;
}

const EMPTY: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
};

function totalsSince(sinceMs: number): UsageTotals {
  const row = getSharedStore()
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)       AS inputTokens,
              COALESCE(SUM(output_tokens), 0)      AS outputTokens,
              COALESCE(SUM(cache_read_tokens), 0)  AS cacheReadTokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
              COALESCE(SUM(CAST(cost_usd AS REAL)), 0) AS costUsd,
              SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedCalls
       FROM api_usage WHERE created_at >= ?`
    )
    .get(sinceMs) as UsageTotals | undefined;
  return row ? { ...EMPTY, ...row, unpricedCalls: row.unpricedCalls ?? 0 } : { ...EMPTY };
}

export function buildUsageReport(): UsageReport {
  const db = getSharedStore();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const byModel = db
    .prepare(
      `SELECT model,
              COUNT(*) AS calls,
              COALESCE(SUM(CAST(cost_usd AS REAL)), 0) AS costUsd,
              SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM api_usage GROUP BY model ORDER BY costUsd DESC LIMIT 12`
    )
    .all() as unknown as UsageReport["byModel"];

  const byPurpose = db
    .prepare(
      `SELECT purpose, COUNT(*) AS calls, COALESCE(SUM(CAST(cost_usd AS REAL)), 0) AS costUsd
       FROM api_usage GROUP BY purpose ORDER BY costUsd DESC`
    )
    .all() as unknown as UsageReport["byPurpose"];

  /* What caching saved: cached input billed at ~0.1x, so the other 0.9x is the
     saving. Priced per row's own model, which is why it is a query rather than
     one multiplication over the total. */
  const saved = db
    .prepare(`SELECT model, COALESCE(SUM(cache_read_tokens), 0) AS tok FROM api_usage GROUP BY model`)
    .all() as unknown as Array<{ model: string; tok: number }>;
  let cacheSavedUsd = 0;
  for (const s of saved) {
    const price = PRICES.find((p) => s.model.startsWith(p.prefix));
    if (price) cacheSavedUsd += (s.tok * price.inputPerM * (1 - CACHE_READ_MULTIPLIER)) / 1_000_000;
  }

  const byMode = db
    .prepare(
      `SELECT mode, COUNT(*) AS calls, COALESCE(SUM(CAST(cost_usd AS REAL)), 0) AS costUsd
       FROM api_usage GROUP BY mode ORDER BY costUsd DESC`
    )
    .all() as unknown as UsageReport["byMode"];

  return {
    today: totalsSince(startOfDay.getTime()),
    last30Days: totalsSince(Date.now() - 30 * 86_400_000),
    allTime: totalsSince(0),
    byModel,
    byPurpose,
    byMode,
    cacheSavedUsd,
    /* The UI must never render this as a balance. */
    scope: "What this app has spent, across both modes — one Anthropic bill. Anthropic exposes no account balance to a normal API key.",
  };
}
