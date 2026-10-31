/**
 * Post-trade review agent (plan §5, Phase 3 memory loop).
 *
 * Runs *after* a paper position has already closed and been persisted. It
 * reads the closed position, the strategy spec that produced it, and the
 * surrounding candles, then writes a structured `trade_review` journal entry.
 *
 * Hard boundary: this is a consumer of completed history only. It has no
 * ability to open, close, size, or veto a trade — `paper-exchange.ts` has
 * already finished executing by the time this is called. Keeping the review
 * agent strictly downstream is what preserves the "AI proposes, code
 * executes" rule while still letting the bot learn from its own trades.
 *
 * A separate pass (`distillLessons`) periodically folds recent reviews into a
 * small number of durable `lesson` entries, which `context.ts` injects into
 * every chat system prompt.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "../db/database";
import { recordUsage } from "./usage";
import { getLessonsForPair, replaceLessonsForPair, type LessonDraft } from "../db/shared-store";
import { appMode } from "../modes/app-mode";
import { classifyRegime, type TrendRegime } from "../insights/regime";
import { dbCandleSource } from "../insights/level-resolver";
import { buildCalibration } from "../plans/calibration";
import * as credentials from "../security/credentials";
import { getStrategy } from "../strategy/strategy-service";
import { getPlan } from "../plans/plan-service";
import { getSessionById } from "../sessions/service";
import type { StrategySpec } from "../strategy/strategy-spec";
import { resolveFastModel } from "./chat";
import { isAdministrativeExit } from "../paper/paper-exchange";
import { createLogger } from "../logger";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

const log = createLogger("review");

/** Bars of context either side of the trade handed to the reviewer. */
const CONTEXT_BARS = 60;

async function reviewModel(): Promise<string | null> {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'review_model'").get() as
      | { value: string }
      | undefined;
    if (row?.value) return row.value;
  } catch {
    // fallback below
  }
  return resolveFastModel();
}

interface ClosedPositionRow {
  id: number;
  session_id: number;
  /** NULL when a plan branch owns this position (schema v15). Exactly one of
   *  `strategy_id` and `plan_branch_id` is set — the database enforces it. */
  strategy_id: number | null;
  plan_branch_id: number | null;
  symbol: string;
  entry_price: string;
  exit_price: string;
  quantity: string;
  stop_price: string | null;
  target_price: string | null;
  exit_reason: string;
  realized_pnl: string;
  fees_total: string;
  opened_at: number;
  closed_at: number;
  reviewed: number;
  /** Derived `PriceLevel`s as resolved at entry vs. their armed values (v12).
   *  NULL for positions opened on purely numeric thresholds. */
  entry_levels_json: string | null;
}

function getClosedPosition(positionId: number): ClosedPositionRow | null {
  return (getDb()
    .prepare(`SELECT * FROM paper_positions WHERE id = ? AND status = 'closed'`)
    .get(positionId) as ClosedPositionRow | undefined) ?? null;
}

/** Price action around the trade, so the reviewer can see whether the exit
 *  was early, late, or well-timed rather than only scoring the PnL sign.
 *
 *  Scoped to ONE interval — the strategy's own evaluation interval. Without the
 *  `interval_min` filter this read every cached timeframe for the symbol at
 *  once, then took the first 60 rows in ascending time order. On a pair with 1m
 *  candles cached that window was consumed entirely by the hour before the
 *  trade opened, so `best_price_seen` / `worst_price_seen` could describe price
 *  action from before the entry and never look at the trade at all. The
 *  reviewer was then asked how much of the favourable move was captured, from
 *  bars that predate the position. */
function tradeWindowCandles(symbol: string, intervalMin: number, openedAt: number, closedAt: number) {
  const span = Math.max(closedAt - openedAt, 60_000);
  return getDb()
    .prepare(
      `SELECT start_ms, open, high, low, close FROM candles
       WHERE symbol = ? AND ${FEED_SCOPE_SQL} AND interval_min = ?
         AND start_ms BETWEEN ? AND ?
       ORDER BY start_ms ASC LIMIT ?`
    )
    .all(symbol, intervalMin, openedAt - span, closedAt + span, CONTEXT_BARS) as any[];
}

const INTERVAL_MINUTES: Record<string, number> = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440,
};

/** Recent trades on the same strategy — lets the reviewer spot a repeating
 *  failure mode instead of treating every trade as a one-off. */
function recentTradeHistory(strategyId: number, excludeId: number) {
  return getDb()
    .prepare(
      `SELECT exit_reason, realized_pnl, opened_at, closed_at FROM paper_positions
       WHERE strategy_id = ? AND status = 'closed' AND id != ?
       ORDER BY closed_at DESC LIMIT 10`
    )
    .all(strategyId, excludeId) as { exit_reason: string; realized_pnl: string }[];
}

/**
 * Other closed positions belonging to the same PLAN.
 *
 * Normally empty: a plan is a one-shot bet and its branches are OCO by default,
 * so at most one fires. Reporting the empty truth beats borrowing another
 * plan's trades to make the field look populated — what accumulates across
 * plans is S3-6's calibration record, not this.
 */
function planTradeHistory(planId: number, excludeId: number) {
  return getDb()
    .prepare(
      `SELECT p.exit_reason, p.realized_pnl FROM paper_positions p
         JOIN plan_branches b ON b.id = p.plan_branch_id
        WHERE b.plan_id = ? AND p.status = 'closed' AND p.id != ?
        ORDER BY p.closed_at DESC LIMIT 10`
    )
    .all(planId, excludeId) as { exit_reason: string; realized_pnl: string }[];
}

/** The timeframe a plan is evaluated on, for the price window. */
function planEvalInterval(branchRowId: number | null): string {
  if (branchRowId === null) return "";
  const row = getDb()
    .prepare(
      `SELECT p.eval_interval AS iv FROM plan_branches b
         JOIN trade_plans p ON p.id = b.plan_id
        WHERE b.id = ?`
    )
    .get(branchRowId) as { iv: string } | undefined;
  return row?.iv ?? "";
}

/**
 * Rules that hold whatever opened the position.
 *
 * Split from the owner-specific block below because a strategy and a plan are
 * judged against **different things** — a strategy against the spec it was
 * meant to execute, a plan against the thesis and assumptions it was authored
 * on — while the arithmetic, the exit-reason rule and the derived-level
 * question are identical. One shared base means the shared rules cannot drift
 * apart; two tails mean neither review asks the wrong question.
 */
const REVIEW_SHARED_RULES = `Rules:
- The trade is already closed. You are not deciding anything; you are recording what happened so future decisions are better informed.
- Be specific and quantitative. Cite the actual prices, the stop/target distance, how much of the favourable move was captured, and what fees cost as a share of the result.
- Say plainly when a single trade tells you nothing. Do not manufacture a pattern from one sample. If the honest conclusion is "too early to say", write that.
- IF \`derived_levels_at_entry\` IS PRESENT, ask the question the PnL cannot answer: did the trigger fire because PRICE moved to the level, or because the LEVEL moved to price? Compare each level's \`armed\` value against \`atEntry\`. A developing level — an anchored profile's POC especially — migrates toward price as volume accumulates, so a setup can look like it was caught when it actually walked in. If a level moved materially, say so and treat the setup as weaker evidence than the result suggests, whether the trade won or lost. If \`drifted\` is true the level had left the geometry that was approved entirely. If the levels barely moved, say that too — it is the case that makes the entry trustworthy.
- CHECK exit_reason BEFORE JUDGING. \`exit_signal\`, \`stop_loss\` and \`take_profit\` are decisions the system made — review those normally. \`manual\` and \`session_archived\` are the OPERATOR closing the position for reasons outside the setup (\`session_archived\` = the whole session was wound down). The trade was interrupted, not concluded: do not call it a win or a loss, do not draw any conclusion about edge from it, and say explicitly that the exit was administrative. Reviewing it is still useful — note where price was relative to the stop and target at the moment it was cut, since that is the one thing the interruption tells you.
- No hedging filler, no motivational language, no emoji.`;

const STRATEGY_PROMPT = `You are the post-trade reviewer for a personal crypto trading bot.

A paper trade opened by a STRATEGY has just closed. A strategy is a repeating rule, so it is judged against the spec it was meant to execute.

${REVIEW_SHARED_RULES}
- Judge the PROCESS, not just the outcome. A losing trade that followed the spec correctly is a good trade with a bad outcome; a winning trade that fired on a condition the spec did not intend is a lucky accident and should be flagged as one.
- Never recommend changing the strategy on the basis of one trade. If you see a possible issue, phrase it as a hypothesis to watch across more trades.

Format your reply as plain prose, 120 words maximum, in three parts:
WHAT HAPPENED: one or two sentences.
PROCESS: did execution match the spec's intent?
WATCH: one concrete thing to check on future trades, or "nothing yet".`;

/**
 * A plan is judged against its THESIS, not against a spec.
 *
 * This is the whole reason the review had to be split rather than parameterised.
 * A plan is a one-shot bet on a path; it is never backtested, and what it staked
 * its licence on was **falsifiability** — stated assumptions, an invalidation
 * separate from the stop, a hard expiry. So the useful question is not "did
 * execution match the rule" but **"were the assumptions true, and did the
 * outcome follow from them?"**
 *
 * The four cases that matter are enumerated explicitly, because the interesting
 * ones are the diagonals: right for the wrong reason, and wrong for the right
 * reason. A reviewer left to its own devices scores the PnL and calls the
 * assumptions vindicated, which is exactly the self-flattery the calibration
 * record exists to prevent.
 */
const PLAN_PROMPT = `You are the post-trade reviewer for a personal crypto trading bot.

A paper position opened by a scenario PLAN has just closed. A plan is a one-shot bet on a path, authored by the owner and never backtested. It is judged against its thesis and its stated assumptions — NOT against a mechanical rule.

${REVIEW_SHARED_RULES}
- Work through the assumptions one at a time. For each, say whether the price action supports it, contradicts it, or says nothing yet. "Says nothing yet" is a common and useful answer; do not force a verdict.
- SEPARATE being right from being profitable. All four combinations happen and the diagonals are the informative ones: right thesis and a profit; right thesis and a loss (usually sizing, timing or a stop too tight); WRONG thesis and a profit — say this loudly, because it is the case most likely to be misread as success; wrong thesis and a loss.
- The thesis invalidation is not the stop. If the position was stopped out while the thesis was still intact, say so — that is a trade-management observation, not a disproved thesis. If the thesis was invalidated while the position was in profit, that is the plan working as designed.
- Do not tell the owner to re-author the plan. One plan is one sample; what accumulates across plans is the calibration record, not this entry.

Format your reply as plain prose, 130 words maximum, in three parts:
WHAT HAPPENED: one or two sentences.
ASSUMPTIONS: which held, which did not, which are still unproven.
WATCH: one concrete thing to carry into the next plan of this kind, or "nothing yet".`;

/**
 * Who opened this position, and what should it be judged against?
 *
 * Schema v15 made ownership exclusive at the database — a position belongs to a
 * strategy or to a plan branch, never both and never neither. Before this the
 * reviewer assumed the first case and called `getStrategy(pos.strategy_id)`
 * with a NULL, so a plan-opened position would have closed and never been
 * reviewed at all. Silent, and it would have taken the calibration record's
 * only input with it.
 */
type ReviewOwner =
  | { kind: "strategy"; name: string; strategyId: number; planId: null; payload: unknown; prompt: string }
  | { kind: "plan"; name: string; strategyId: null; planId: number; payload: unknown; prompt: string };

function resolveOwner(pos: ClosedPositionRow): ReviewOwner | null {
  if (pos.strategy_id !== null) {
    const strat = getStrategy(pos.strategy_id);
    if (!strat) return null;
    let spec: StrategySpec | null = null;
    try {
      spec = JSON.parse(strat.spec_json) as StrategySpec;
    } catch {
      /* review can still proceed without the parsed spec */
    }
    return {
      kind: "strategy",
      name: strat.name,
      strategyId: strat.id,
      planId: null,
      prompt: STRATEGY_PROMPT,
      payload: {
        strategy: { name: strat.name, version: strat.version, state: strat.state },
        spec_intent: spec
          ? {
              entry: spec.entry,
              exit: spec.exit,
              sizing: spec.sizing,
              risk: spec.risk,
              eval_interval: spec.schedule?.eval_interval,
            }
          : "unavailable",
      },
    };
  }

  if (pos.plan_branch_id === null) return null;
  const branchRow = getDb()
    .prepare(`SELECT plan_id, slug, label FROM plan_branches WHERE id = ?`)
    .get(pos.plan_branch_id) as { plan_id: number; slug: string; label: string } | undefined;
  if (!branchRow) return null;
  const plan = getPlan(branchRow.plan_id);
  if (!plan) return null;

  return {
    kind: "plan",
    name: plan.slug,
    strategyId: null,
    planId: plan.rowId,
    prompt: PLAN_PROMPT,
    payload: {
      plan: {
        name: plan.slug,
        state: plan.state,
        thesis: plan.thesis,
        /* The thing being judged. Sent as the authored text, not a summary —
           the reviewer's job is to check these against price, and a paraphrase
           would be checking the paraphrase. */
        assumptions: plan.assumptions.map((a: { text: string }) => a.text),
        thesis_invalidation: plan.invalidation,
        expires_at: plan.expiresAt,
        risk_budget_quote: plan.risk.maxQuote,
        branch: { id: branchRow.slug, label: branchRow.label },
      },
    },
  };
}

/**
 * Review a single closed position and append a `trade_review` journal entry.
 * Idempotent: a position already marked `reviewed` is skipped.
 * Never throws — a failed review must not disturb the engine that called it.
 */
export async function reviewClosedPosition(positionId: number): Promise<void> {
  try {
    const pos = getClosedPosition(positionId);
    if (!pos) return;
    if (pos.reviewed) return;

    const apiKey = credentials.getAnthropicApiKey();
    if (!apiKey) {
      log.info("No Anthropic API key configured — skipping trade review.");
      return;
    }

    const session = getSessionById(pos.session_id);
    if (!session) return;

    const owner = resolveOwner(pos);
    if (!owner) {
      log.warn(`Position #${pos.id} has no resolvable owner — skipping review.`);
      return;
    }

    const entry = parseFloat(pos.entry_price);
    const exit = parseFloat(pos.exit_price);
    const pnl = parseFloat(pos.realized_pnl);
    const fees = parseFloat(pos.fees_total);
    const holdMinutes = Math.round((pos.closed_at - pos.opened_at) / 60_000);
    const returnPct = ((exit - entry) / entry) * 100;

    /* Recorded at entry (schema v12) because it is only true at that instant:
       by now a developing level has moved on and the comparison is gone. */
    let entryLevels: unknown = null;
    if (pos.entry_levels_json) {
      try {
        entryLevels = JSON.parse(pos.entry_levels_json);
      } catch {
        /* A malformed snapshot must not cost the whole review. */
      }
    }

    /* The interval the owner was actually looking at. Without this the window
       is read from every cached timeframe at once and can be consumed by bars
       that predate the entry entirely. */
    const evalInterval =
      owner.kind === "strategy"
        ? ((owner.payload as { spec_intent?: { eval_interval?: string } }).spec_intent?.eval_interval ?? "")
        : planEvalInterval(pos.plan_branch_id);
    const intervalMin = INTERVAL_MINUTES[evalInterval] ?? 15;
    const candles = tradeWindowCandles(pos.symbol, intervalMin, pos.opened_at, pos.closed_at);
    const highs = candles.map((c) => parseFloat(c.high));
    const lows = candles.map((c) => parseFloat(c.low));
    const maxFavourable = highs.length ? Math.max(...highs) : exit;
    const maxAdverse = lows.length ? Math.min(...lows) : exit;

    /* A strategy repeats, so its own prior trades are the comparison. A plan is
       one-shot: its "history" is other branches of the same plan, which for an
       OCO plan is normally empty — and that is the honest answer rather than
       borrowing another plan's trades to fill the field. What accumulates
       across plans is S3-6's calibration record, not this. */
    const history =
      owner.kind === "strategy" ? recentTradeHistory(owner.strategyId, pos.id) : planTradeHistory(owner.planId, pos.id);
    const wins = history.filter((h) => parseFloat(h.realized_pnl) > 0).length;

    const payload = {
      pair: pos.symbol,
      opened_by: owner.kind,
      ...(owner.payload as Record<string, unknown>),
      trade: {
        entry_price: entry,
        exit_price: exit,
        quantity: parseFloat(pos.quantity),
        stop_price: pos.stop_price ? parseFloat(pos.stop_price) : null,
        target_price: pos.target_price ? parseFloat(pos.target_price) : null,
        exit_reason: pos.exit_reason,
        /* Spelled out rather than left for the model to infer from a string —
           the whole point is that it must not score an operator wind-down as
           the strategy's result. */
        exit_decided_by: isAdministrativeExit(pos.exit_reason) ? "operator" : "strategy",
        realized_pnl_usd: pnl,
        return_pct: returnPct,
        fees_usd: fees,
        fees_as_pct_of_gross: Math.abs(pnl + fees) > 0 ? (fees / Math.abs(pnl + fees)) * 100 : null,
        hold_minutes: holdMinutes,
      },
      /* The question no PnL figure can answer: did the trigger fire because
         PRICE moved, or because the LEVEL moved toward price? An anchored
         profile's POC migrates toward price as volume accumulates, so a
         strategy can appear to be catching setups while the setups are
         walking into it. Absent for specs with purely numeric thresholds. */
      derived_levels_at_entry: entryLevels,
      price_action_during_trade: {
        best_price_seen: maxFavourable,
        worst_price_seen: maxAdverse,
        unrealized_peak_pct: ((maxFavourable - entry) / entry) * 100,
        worst_drawdown_pct: ((maxAdverse - entry) / entry) * 100,
      },
      [owner.kind === "strategy" ? "prior_trades_this_strategy" : "prior_trades_this_plan"]: {
        count: history.length,
        wins,
        losses: history.length - wins,
        recent_exit_reasons: history.map((h) => h.exit_reason),
      },
    };

    const model = await reviewModel();
    if (!model) {
      log.warn("Trade review skipped: Could not resolve model from Anthropic API.");
      return;
    }

    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model,
      max_tokens: 500,
      system: owner.prompt,
      messages: [{ role: "user", content: JSON.stringify(payload, null, 2) }],
    });
    recordUsage(model, "trade_review", res.usage);

    const text = res.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    if (!text) return;

    const tags = ["paper", owner.kind, pos.exit_reason, pnl >= 0 ? "win" : "loss", owner.name].join(",");
    const header =
      `[${pos.symbol}] ${owner.name} — ${pos.exit_reason}, ` +
      `PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD (${returnPct.toFixed(2)}%), held ${holdMinutes}m\n\n`;

    const db = getDb();
    db.exec("BEGIN TRANSACTION;");
    try {
      /* Linked to whichever object owned the trade. `ref_plan_id` (v16) exists
         because the review IS the record — S3-6 derives its figures from these
         entries, so a plan's review has to be findable by plan rather than by
         searching tag text. */
      db.prepare(
        `INSERT INTO journal (session_id, kind, content, tags, ref_strategy_id, ref_plan_id, created_at)
         VALUES (?, 'trade_review', ?, ?, ?, ?, ?)`
      ).run(pos.session_id, header + text, tags, owner.strategyId, owner.planId, Date.now());

      db.prepare(`UPDATE paper_positions SET reviewed = 1 WHERE id = ?`).run(pos.id);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }

    log.info(`Wrote trade review for position #${pos.id}.`);
  } catch (err) {
    // A broken review must never take down the paper engine.
    log.error(`Failed to review position ${positionId}`, err);
  }
}

/**
 * A plan that finished **without ever trading**.
 *
 * Until now the review agent only ever ran on a closed position, which left the
 * most common outcome — and the most informative one for the calibration record
 * — with no written record at all. A plan that expired unfired is the owner
 * saying "I expected this and it did not happen", and that is worth keeping in
 * their own words rather than as a state change in a table.
 *
 * The question is different from the trade review's, so the prompt is separate
 * rather than parameterised: **why did this not happen?**, not *how did it go?*
 */
const PLAN_RESOLUTION_PROMPT = `You are the reviewer for a personal crypto trading bot.

A scenario PLAN has finished WITHOUT ever opening a position. The owner wrote down what they expected; it did not play out that way. Your job is to make that useful.

- There is no PnL and no trade. Do not invent one, and never describe this as a loss — nothing was risked.
- The outcome is one of: EXPIRED (the horizon passed and the trigger never fired), INVALIDATED (the thesis was disproved before any entry), or TRIGGERED-BUT-NOT-ENTERED (a branch fired and the entry was refused; the reason is in the payload).
- An INVALIDATED plan that never traded is the system working. Say so. The owner wrote a falsifiable thesis, the market disproved it, and it cost nothing — that is the point of writing an invalidation separate from a stop.
- If watched_throughout is false, the app was closed for part of this plan's life. Then you CANNOT say the trigger never came, only that it was not seen. Say that plainly and draw no conclusion about the thesis.
- Compare the price range actually reached against the entry and trigger levels. "Price got within 0.4% and turned" is a completely different lesson from "price never came within 8%": the first is about a level being slightly wrong, the second about the whole scenario.
- Judge the ASSUMPTIONS, not the owner. For each, say whether what happened supports it, contradicts it, or says nothing.
- Do not suggest re-authoring the plan or propose a new one. One plan is one sample.

Format as plain prose, 110 words maximum:
WHAT HAPPENED: one or two sentences.
HOW CLOSE: where price got, relative to what was asked for.
ASSUMPTIONS: which held, which did not, which are still unproven.`;

/** Price range over a plan's armed life, from the analysis feed. */
function planPriceRange(symbol: string, intervalMin: number, from: number, to: number) {
  const row = getDb()
    .prepare(
      `SELECT MIN(CAST(low AS REAL)) AS lo, MAX(CAST(high AS REAL)) AS hi, COUNT(*) AS bars
       FROM candles WHERE symbol = ? AND ${FEED_SCOPE_SQL} AND interval_min = ?
         AND start_ms BETWEEN ? AND ?`
    )
    .get(symbol, intervalMin, from, to) as { lo: number | null; hi: number | null; bars: number };
  return row && row.bars > 0 ? { low: row.lo, high: row.hi, bars: row.bars } : null;
}

/**
 * Was the monitor running for this whole window?
 *
 * Mirrors the calibration record's rule, and for the same reason: an unwatched
 * gap means "not seen", never "did not happen". Without this flag the reviewer
 * will state confidently that the trigger never came, when the truth is that
 * nobody was looking — the flattering direction, in prose this time.
 */
function watchedThroughout(from: number, to: number): boolean {
  const rows = getDb()
    .prepare(`SELECT detail FROM audit_log WHERE action = 'monitor_gap' ORDER BY created_at DESC LIMIT 500`)
    .all() as Array<{ detail: string }>;
  for (const r of rows) {
    try {
      const g = JSON.parse(r.detail) as { from?: number; to?: number };
      if (typeof g.from === "number" && typeof g.to === "number" && g.from < to && g.to > from) return false;
    } catch {
      /* A malformed audit row must not decide this either way. */
    }
  }
  return true;
}

/**
 * Write the closing note for a plan that finished without trading.
 *
 * Idempotent via `trade_plans.reviewed` (schema v18), and deliberately silent
 * about plans that DID trade: those are covered by their position's
 * `trade_review`, and a second entry would double-count in every reading of the
 * journal — including the lessons distillation that feeds on it.
 */
export async function reviewResolvedPlan(planId: number): Promise<void> {
  try {
    const flag = getDb()
      .prepare(`SELECT reviewed FROM trade_plans WHERE id = ?`)
      .get(planId) as { reviewed: number } | undefined;
    if (!flag || flag.reviewed === 1) return;

    const plan = getPlan(planId);
    if (!plan) return;
    if (!["expired", "invalidated", "closed"].includes(plan.state)) return;

    if (plan.branches.some((b) => b.positionId !== null)) {
      /* It traded. Mark it done so the catch-up query stops returning it. */
      getDb().prepare(`UPDATE trade_plans SET reviewed = 1 WHERE id = ?`).run(planId);
      return;
    }

    const apiKey = credentials.getAnthropicApiKey();
    if (!apiKey) return;
    const model = await reviewModel();
    if (!model) return;

    const from = plan.armedAt ?? plan.expiresAt;
    const to = Date.now();
    const intervalMin = INTERVAL_MINUTES[plan.evalInterval] ?? 240;
    const firedNoEntry = plan.branches.filter((b) => b.status === "triggered" && b.positionId === null);

    const payload = {
      pair: plan.pair,
      plan: plan.slug,
      outcome:
        firedNoEntry.length > 0
          ? "TRIGGERED-BUT-NOT-ENTERED"
          : plan.state === "invalidated"
            ? "INVALIDATED"
            : "EXPIRED",
      thesis: plan.thesis,
      assumptions: plan.assumptions.map((a: { text: string }) => a.text),
      outcome_reason: plan.outcomeReason,
      armed_at: plan.armedAt,
      expires_at: plan.expiresAt,
      branches: plan.branches.map((b) => ({
        label: b.label,
        status: b.status,
        entry: b.entry,
        stop: b.stop,
        targets: b.targets,
      })),
      price_while_armed: planPriceRange(plan.pair, intervalMin, from, to),
      watched_throughout: watchedThroughout(from, to),
    };

    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model,
      max_tokens: 400,
      system: PLAN_RESOLUTION_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(payload, null, 2) }],
    });
    recordUsage(model, "plan_review", res.usage);
    const text = res.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    if (!text) return;

    const db = getDb();
    db.exec("BEGIN TRANSACTION;");
    try {
      db.prepare(
        `INSERT INTO journal (session_id, kind, content, tags, ref_plan_id, created_at)
         VALUES (?, 'trade_review', ?, ?, ?, ?)`
      ).run(
        plan.sessionId,
        `[${plan.pair}] ${plan.slug} — ${payload.outcome.toLowerCase()}, no position\n\n${text}`,
        ["plan", plan.state, "no-trade"].join(","),
        planId,
        Date.now()
      );
      db.prepare(`UPDATE trade_plans SET reviewed = 1 WHERE id = ?`).run(planId);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
    log.info(`Wrote resolution note for plan #${planId} (${payload.outcome}).`);
  } catch (err) {
    /* A broken review must never disturb the engine that called it. */
    log.error(`Failed to review resolved plan ${planId}`, err);
  }
}

/** Catch up on plans that finished while the app was shut, or whose review
 *  failed. Sequential, so a backlog cannot fan out into parallel API calls. */
export async function reviewPendingPlans(limit = 20): Promise<void> {
  const rows = getDb()
    .prepare(
      `SELECT id FROM trade_plans
       WHERE reviewed = 0 AND state IN ('expired','invalidated','closed')
       ORDER BY updated_at ASC LIMIT ?`
    )
    .all(limit) as { id: number }[];
  for (const r of rows) await reviewResolvedPlan(r.id);
}

/** Catch up on any closed positions that were never reviewed (app was shut
 *  during the trade, API key missing at the time, request failed). Called on
 *  startup, sequentially so a backlog can't fan out into parallel API calls. */
export async function reviewPendingPositions(limit = 20): Promise<void> {
  const rows = getDb()
    .prepare(`SELECT id FROM paper_positions WHERE status = 'closed' AND reviewed = 0 ORDER BY closed_at ASC LIMIT ?`)
    .all(limit) as { id: number }[];

  for (const row of rows) {
    await reviewClosedPosition(row.id);
  }
}

/* ── Lessons distillation ─────────────────────────────────────────────── */

/**
 * Closed positions needed before a lesson set is worth writing.
 *
 * **Lowered from 5 to 3 when the strategy path was cut.** Five was a per-
 * strategy number, and a strategy trades often. A plan is a one-shot bet: five
 * closed positions on one pair is a long way off, so the old gate meant lessons
 * would in practice never distil at all. Three is still a pattern rather than a
 * result, and the prompt is explicit that a thin set — even an empty one — is
 * the honest answer.
 */
export const MIN_REVIEWS_FOR_LESSONS = 3;

/** Interval the regime is measured on. 4h is the plan default and coarse
 *  enough that a single noisy session does not reclassify the market. */
const REGIME_INTERVAL_MIN = 240;
/** Bars fed to the classifier — enough for ADX warm-up plus a volatility
 *  window, and bounded so retrospective classification stays cheap. */
const REGIME_BARS = 150;

const LESSONS_SYSTEM_PROMPT = `You maintain the durable "lessons" memory for a personal crypto trading bot, for one trading pair.

You are given the recent trade reviews and observations for this pair, plus the lessons currently stored. Produce the updated lesson set.

Rules:
- A lesson must be supported by a PATTERN across multiple trades, not a single result. If the evidence is thin, keep the lesson set small — an empty or one-item set is a valid and honest answer.
- **Every lesson names the market conditions it holds under.** Each piece of evidence carries a measured \`regime\` (trending_up, trending_down, ranging, transitional, or unknown), computed from ADX and ATR at the time of that trade — you are not being asked to judge the market yourself. A lesson stated without conditions is either overgeneralised or wrong: "exits fire while the move is still extending" can be true in a trend and false in a range, and it will be injected into every future conversation.
- Assign each lesson the regime its supporting evidence actually came from. Use \`mixed\` ONLY when the lesson held across several different regimes — that is the strongest kind of lesson and the claim has to be earned. Never invent a regime that does not appear in the evidence.
- Prefer lessons about process and conditions ("exits on this strategy fire while the move is still extending, seen in 4 of 6 winners") over outcome summaries ("we lost money on Tuesday").
- Merge duplicates. Drop lessons the newer evidence contradicts. Keep the total to at most 5.
- Each lesson: one sentence, specific, and it must state the evidence it rests on.
- These lessons are injected into every future conversation, so a wrong or overconfident lesson does lasting damage. When in doubt, leave it out.
- Evidence origin is stated in the payload as \`evidence_origin\`. When it is "simulated", the fills had no real slippage, no queue position and no partial fills — do not let a simulated result become a lesson about live execution. When it is "live", the fills are real and may be judged as such.
- Evidence may span several sessions on the same pair. Treat it as one body of evidence about that market; do not write a lesson about a session.

Output ONLY a JSON array of objects, each {"text": "...", "regime": "..."}. No prose, no markdown fence.`;


/**
 * What kind of market was it when this trade closed?
 *
 * Point-in-time: only bars up to `asOf` are loaded, so a regime computed for a
 * trade that closed weeks ago cannot see what happened afterwards. Measuring it
 * from the whole series would be look-ahead, and the resulting lesson would be
 * tagged with conditions the market only revealed later.
 *
 * Returns `unknown` freely — with thin cached history there is no answer, and a
 * default bucket would be a fabricated condition stamped onto a memory that
 * goes into every future prompt.
 */
function regimeAt(pair: string, asOf: number): TrendRegime {
  try {
    const bars = dbCandleSource(pair, REGIME_INTERVAL_MIN, 0, asOf).slice(-REGIME_BARS);
    return classifyRegime(bars).trend;
  } catch {
    return "unknown";
  }
}

/**
 * The planner's own track record, folded in as evidence.
 *
 * Distillation never saw this before, and it is some of the best evidence the
 * app has: "your range-reclaim theses trigger 3 of 11 times" is exactly the
 * shape a durable lesson should rest on. Rates that are still null below the
 * sample threshold stay null — the honesty rules travel with the numbers.
 */
function calibrationSummary(): unknown {
  try {
    const rec = buildCalibration();
    if (rec.empty) return "no finished plans yet";
    return {
      finished_plans: rec.overall.resolved,
      min_sample_for_a_rate: rec.minSample,
      by_tag: rec.tags.map((t) => ({
        tag: t.tag ?? "untagged",
        finished: t.resolved,
        triggered: t.triggered,
        trigger_rate: t.triggerRate,
        disproved_after_triggering: t.invalidatedAfterTrigger,
        typical_share_of_forecast_move_captured: t.capturedShare,
      })),
      note: "A null rate means too few finished plans to quote one. Do not compute it from the counts.",
    };
  } catch {
    return "unavailable";
  }
}

/**
 * Fold recent trade reviews into a small curated lesson set **for the pair**.
 *
 * **Evidence is gathered across every session on that pair, and the result is
 * stored in the shared store rather than as journal rows.** Both halves changed
 * with app modes, and both were latent defects before it:
 *
 *  • Distilling per *session* meant archiving a session and starting a fresh
 *    one on the same pair reset the agent's memory of that market to nothing.
 *    Evidence about how ARB behaves does not stop being true because a session
 *    was wound down.
 *  • Storing per session meant lessons could not cross modes at all, and the
 *    owner's decision is that they must — starting live with an empty memory
 *    would discard everything simulation taught. A hit *rate* still must not
 *    cross; that stays in the mode's own database.
 *
 * `minReviews` is the honesty gate: below it there is no pattern, only a
 * result, and a lesson drawn from one trade goes into every future prompt.
 */
export async function distillLessons(sessionId: number, minReviews = MIN_REVIEWS_FOR_LESSONS): Promise<void> {
  try {
    const apiKey = credentials.getAnthropicApiKey();
    if (!apiKey) return;

    const db = getDb();
    const session = getSessionById(sessionId);
    if (!session) return;

    /* Trade reviews are the evidence; observations are supporting colour.
       They must be counted separately and the automated ones excluded.

       The background scheduler writes an hourly `observation` equity snapshot
       per active session — 24 a day, forever. Those used to be pulled in here
       and counted toward `minReviews`, which broke distillation two ways: the
       gate passed on a session that had never closed a single trade (five
       snapshots is not five reviews), and once running, the 40-row window
       filled with snapshots that pushed the actual trade reviews out of the
       prompt. The model was then asked to distill durable lessons from a list
       of hourly cash balances — and these lessons go into every future
       conversation. */
    /* Every session on this pair, not just this one — see the note above. */
    const reviews = db
      .prepare(
        `SELECT j.content AS content, j.created_at AS created_at
         FROM journal j JOIN sessions s ON s.id = j.session_id
         WHERE s.pair = ? AND j.kind = 'trade_review'
         ORDER BY j.created_at DESC LIMIT 40`
      )
      .all(session.pair) as { content: string; created_at: number }[];

    if (reviews.length < minReviews) {
      log.info(`${session.pair}: only ${reviews.length} trade reviews — need ${minReviews}. Skipping.`);
      return;
    }

    /* Hand-written notes and genuine events only: `automated` tags the
       machine-generated bookkeeping entries that carry no judgement. */
    const observations = db
      .prepare(
        `SELECT content FROM journal
         WHERE session_id = ? AND kind = 'observation'
           AND (tags IS NULL OR tags NOT LIKE '%automated%')
         ORDER BY created_at DESC LIMIT 20`
      )
      .all(sessionId) as { content: string }[];

    const existing = getLessonsForPair(session.pair, 10);

    const model = await reviewModel();
    if (!model) return;

    /* The regimes actually present in this evidence. Used to constrain what the
       model may claim — see the validation below. */
    const evidenceRegimes = new Set(reviews.map((r) => regimeAt(session.pair, r.created_at)));

    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model,
      max_tokens: 1000,
      system: LESSONS_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            {
              pair: session.pair,
              current_lessons: existing.map((e) => e.content),
              /* Told, not assumed: the same prompt runs in both modes and the
                 caveat about slippage is only true in one of them. */
              evidence_origin: appMode(),
              /* Each review carries the MEASURED regime at the time of that
                 trade, so the model attributes lessons to conditions rather
                 than judging the market itself. */
              recent_reviews: reviews.map((r) => ({
                review: r.content,
                regime: regimeAt(session.pair, r.created_at),
              })),
              /* The planner's own track record, which distillation never saw.
                 "Your range-reclaim theses trigger 3 of 11 times" is exactly
                 the kind of fact a durable lesson should rest on. */
              your_track_record: calibrationSummary(),
              recent_observations: observations.map((o) => o.content),
            },
            null,
            2
          ),
        },
      ],
    });
    recordUsage(model, "lessons", res.usage);

    const text = res.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();

    let lessons: LessonDraft[];
    try {
      const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim());
      if (!Array.isArray(parsed)) throw new Error("not an array");
      /* Regimes are VALIDATED against the ones actually present in the
         evidence. The attribution is the model's judgement, but it cannot
         stamp a lesson with conditions the evidence never contained — that
         would be a fabricated qualifier on a memory injected into every
         future prompt. Anything unrecognised degrades to `unknown`, which is
         honest, rather than to a plausible-looking default. */
      const allowed = new Set<string>([...evidenceRegimes, "mixed"]);
      lessons = parsed
        .map((l): LessonDraft | null => {
          if (typeof l === "string") return l.trim() ? { text: l.trim(), regime: "unknown" } : null;
          if (l && typeof l === "object" && typeof (l as any).text === "string") {
            const t = ((l as any).text as string).trim();
            const r = String((l as any).regime ?? "unknown");
            return t ? { text: t, regime: allowed.has(r) ? r : "unknown" } : null;
          }
          return null;
        })
        .filter((l): l is LessonDraft => l !== null)
        .slice(0, 5);
    } catch (err) {
      log.error("Model did not return the expected JSON — keeping existing lessons.", err);
      return;
    }

    /* Replace, not append: distillation returns the WHOLE set each pass — it
       merges duplicates and drops what newer evidence contradicts, so appending
       would resurrect lessons the model just decided were wrong. */
    replaceLessonsForPair(session.pair, lessons, appMode(), {
      trades: reviews.length,
      from: reviews[reviews.length - 1]?.created_at ?? null,
      to: reviews[0]?.created_at ?? null,
    });

    log.info(`${session.pair}: distilled ${lessons.length} lessons from ${reviews.length} reviews.`);
  } catch (err) {
    log.error(`Distillation failed for session ${sessionId}`, err);
  }
}

/* ── Wiring ───────────────────────────────────────────────────────────── */

/** Number of closed positions between automatic lesson-distillation passes. */
const DISTILL_EVERY_N_TRADES = 5;

/**
 * Attach the review loop to the paper engine. Called once at startup.
 * Deliberately fire-and-forget: the engine must never await an API call.
 */
export function attachReviewAgent(engine: { onPositionClosed: (cb: (id: number) => void) => () => void }): () => void {
  return engine.onPositionClosed((positionId: number) => {
    void (async () => {
      await reviewClosedPosition(positionId);

      const pos = getClosedPosition(positionId);
      if (!pos) return;

      const { n } = getDb()
        .prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE session_id = ? AND status = 'closed'`)
        .get(pos.session_id) as { n: number };

      if (n > 0 && n % DISTILL_EVERY_N_TRADES === 0) {
        await distillLessons(pos.session_id);
      }
    })();
  });
}
