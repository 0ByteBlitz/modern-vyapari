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
 * This lives in the **shared** store. An AI bill is a fact about the provider
 * account, not about simulated or live trading, and keeping it per mode meant
 * the readout under-reported by whatever the other mode had cost — a number
 * labelled "what I have spent" that was really "what I spent in this world".
 * The `mode` column keeps attribution without splitting the total.
 *
 * ## An unpriced model costs `null`, never zero
 *
 * A model its provider cannot price records its tokens with no cost. Zero would
 * be indistinguishable from "free" and would quietly under-report the total;
 * null lets the UI say "3 calls not priced" instead of lying by omission.
 *
 * ## Every provider, not one
 *
 * Each row names the provider that made the call, and that provider's adapter
 * prices it (`AiProvider.pricing`). Rows written before the column existed were
 * all Anthropic — the only adapter there has been — and are labelled so.
 */

import { getSharedStore } from "../db/shared-store";
import { appMode } from "../modes/app-mode";
import { aiProvider, listAiProviders } from "../ai/registry";
import type { ModelPrice } from "../ai/port";
import type { UsageTotals, UsageReport } from "../../shared/ipc-types";
import { createLogger } from "../logger";

const log = createLogger("usage");

/** What the call was for, so a bill can be attributed rather than just totalled. */
export type UsagePurpose = "chat" | "trade_review" | "plan_review" | "lessons" | "other";

/* Prices come from the adapter that made the call (`AiProvider.pricing`), never
   from a table here: one shared table priced every other provider's calls as
   unknown. It is the price *at the time of the call* that matters, so it is
   stored with the row rather than looked up later. Where a provider states no
   cache price, reads are ~0.1× input and writes ~1.25× (5-minute TTL). */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Null when the provider can't price the model — unknown is a value, not zero. */
export function estimateCostUsd(row: ModelPrice | null, u: TokenUsage): number | null {
  if (!row) return null;
  const inTok = u.input_tokens ?? 0;
  const outTok = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const promptTokens = inTok + cacheRead + cacheWrite;
  const long = row.longPrompt && promptTokens > row.longPrompt.overTokens ? row.longPrompt : null;
  const inputPerM = long?.inputPerM ?? row.inputPerM;
  const outputPerM = long?.outputPerM ?? row.outputPerM;
  const cacheReadPerM = row.cacheReadPerM ?? inputPerM * CACHE_READ_MULTIPLIER;
  const cacheWritePerM = row.cacheWritePerM ?? inputPerM * CACHE_WRITE_MULTIPLIER;
  return (inTok * inputPerM + cacheRead * cacheReadPerM + cacheWrite * cacheWritePerM + outTok * outputPerM) / 1_000_000;
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
    /* The provider that made the call prices it, and is recorded with it, so
       the readout can say what each provider cost. */
    const provider = aiProvider();
    const cost = estimateCostUsd(provider.pricing?.(model) ?? null, u);
    getSharedStore()
      .prepare(
        `INSERT INTO api_usage (mode, provider, model, purpose, input_tokens, output_tokens,
                                cache_read_tokens, cache_write_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        appMode(),
        provider.info.id,
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

export type { UsageTotals, UsageReport };

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

  /* What caching saved against paying full input price. Priced per row's own
     provider and model, which is why it is a query rather than one
     multiplication over the total. */
  const providers = new Map(listAiProviders().map((p) => [p.info.id, p]));
  const saved = db
    .prepare(
      `SELECT provider, model, COALESCE(SUM(cache_read_tokens), 0) AS tok FROM api_usage GROUP BY provider, model`
    )
    .all() as unknown as Array<{ provider: string; model: string; tok: number }>;
  let cacheSavedUsd = 0;
  for (const s of saved) {
    const price = providers.get(s.provider)?.pricing?.(s.model);
    if (!price) continue;
    const readPerM = price.cacheReadPerM ?? price.inputPerM * CACHE_READ_MULTIPLIER;
    cacheSavedUsd += (s.tok * (price.inputPerM - readPerM)) / 1_000_000;
  }

  /* Per provider, named as the user knows it. A provider no longer in this
     build keeps its stored id rather than vanishing from the bill. */
  const byProvider = (
    db
      .prepare(
        `SELECT provider, COUNT(*) AS calls,
                COALESCE(SUM(CAST(cost_usd AS REAL)), 0) AS costUsd,
                SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM api_usage GROUP BY provider ORDER BY costUsd DESC`
      )
      .all() as unknown as Array<{ provider: string; calls: number; costUsd: number; unpriced: number }>
  ).map((r) => ({ ...r, provider: providers.get(r.provider)?.info.displayName ?? r.provider }));

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
    byProvider,
    cacheSavedUsd,
    /* The UI must never render this as a balance. Provider-neutral: measured
       per call, whoever bills it. */
    scope: "Measured from each call, across both modes. This is what was spent, not an account balance.",
  };
}
