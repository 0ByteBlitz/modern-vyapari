/**
 * Scenario plans (plan §17, roadmap S3-1) — the shape of a thesis, its
 * lifecycle, and the gate it must pass before it can arm.
 *
 * **Why this is not a strategy.** §6's lifecycle treats a backtest as the only
 * evidence, which assumes every idea is a repeating rule. A discretionary trader
 * also makes one-shot bets on a *path* — "above 72k held for 4h → long to 78k;
 * rejection → retest 68k; below 66k the thesis is dead". For those, statistical
 * validation is **inapplicable, not merely unavailable**: a 2-trade sample
 * dressed as a backtest launders a guess into a metric. So plans live in their
 * own table with their own gate, and the backtest gate is not loosened.
 *
 * **What replaces the backtest is falsifiability.** A plan cannot arm without
 * all four of:
 *
 *   1. explicit **assumptions** — what must be true for this to work;
 *   2. **invalidation separate from the stop** — a stop is where the *trade* is
 *      wrong, invalidation is where the *thesis* is wrong. It can fire while the
 *      position is green;
 *   3. a **hard expiry** — a stale conditional firing weeks later into a
 *      different market is the worst failure mode of scenario automation;
 *   4. its own **risk budget**, smaller than a validated strategy's — unvalidated
 *      conviction gets less capital.
 *
 * `validatePlan` enforces all four. There is no flag to skip it.
 *
 * Pure: types, transitions and validation only. No DB, no engine, no IO — so the
 * authoring UI, the monitor and the tests all judge a plan by the same rules.
 */

import type { PriceLevel } from "../../shared/levels";
import { isDeveloping } from "../../shared/levels";
import type { ConditionGroup, EvalInterval } from "../strategy/strategy-spec";
import { isCondition, extractRequiredLevels } from "../strategy/strategy-spec";

export type { PlanState } from "../../shared/ipc-types";
import type { PlanState } from "../../shared/ipc-types";

/* ── Lifecycle ──────────────────────────────────────────────────────── */

export const VALID_PLAN_STATES: readonly PlanState[] = [
  "draft",
  "planned",
  "triggered",
  "closed",
  "expired",
  "invalidated",
];

/**
 * Allowed transitions.
 *
 * A `draft` goes only to `planned` — it is deleted rather than terminated,
 * because a plan that was never armed has nothing to record and putting it in
 * the calibration set would dilute the owner's real hit rate with ideas they
 * abandoned while typing.
 *
 * `triggered → invalidated` is deliberately reachable: a thesis can be proven
 * wrong while the position it opened is still on, and that must be recordable
 * as what it is rather than as an ordinary close.
 */
export const PLAN_TRANSITIONS: Record<PlanState, readonly PlanState[]> = {
  draft: ["planned"],
  planned: ["triggered", "expired", "invalidated"],
  triggered: ["closed", "invalidated"],
  closed: [],
  expired: [],
  invalidated: [],
};

export function canTransitionPlan(from: PlanState, to: PlanState): boolean {
  return PLAN_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Has this plan reached a terminal state? */
export function isPlanTerminal(state: PlanState): boolean {
  return PLAN_TRANSITIONS[state].length === 0;
}

/* ── Shape ──────────────────────────────────────────────────────────── */

/**
 * One thing that must be true for the thesis to work.
 *
 * Free text by design — the point is that the trader writes down what they are
 * assuming, in their own words, before the market can talk them out of
 * remembering. `tag` is what the calibration record (S3-6) groups by, so the
 * same recurring assumption can accumulate a hit rate across many plans.
 */
export interface PlanAssumption {
  text: string;
  /** Short scenario tag, e.g. "range-high-rejection". Optional but valuable. */
  tag?: string;
}

/**
 * One branch of the path.
 *
 * Branches are **OCO by default** (see `ocoExclusive`): a plan describing two
 * ways the market might resolve must not take both, or a triggered plan is
 * silently double-sized.
 *
 * There is no `direction` field. The venue is spot-only, so every branch is a
 * long. Modelling a short we cannot place would be a control that does not
 * control — the failure this codebase keeps paying for.
 */
export interface PlanBranch {
  id: string;
  /** Human label, e.g. "breakout continuation". Shown in approvals and reviews. */
  label: string;
  /** What must happen for this branch to fire. Evaluated by the same
   *  `evaluateConditionGroup` as strategies and alerts — one evaluator. */
  trigger: ConditionGroup;
  /** Intended entry. */
  entry: PriceLevel;
  /** Where the TRADE is wrong. Distinct from the plan's thesis invalidation. */
  stop: PriceLevel;
  /** Where the trade is right. Multiple = scale-out targets, in order. */
  targets: PriceLevel[];
  /** Share of the plan's risk budget this branch may consume, 0–100. */
  budgetSharePct: number;
}

export interface PlanRiskBudget {
  /**
   * Hard cap in quote currency for the whole plan, across every branch.
   *
   * Deliberately absolute rather than a percentage of balance: a plan is a
   * one-shot bet, and "5% of whatever I happen to have" is not a number the
   * trader agreed to at authoring time.
   */
  maxQuote: number;
  /** Optional per-branch ceiling, also in quote currency. */
  maxQuotePerBranch?: number;
}

export interface TradePlan {
  /** Slug, unique per session. */
  id: string;
  sessionId: number;
  pair: string;
  /** One sentence: what you think is going to happen and why. */
  thesis: string;
  /** At least one. See `validatePlan`. */
  assumptions: PlanAssumption[];
  /** At least one. Mutually exclusive unless `ocoExclusive` is false. */
  branches: PlanBranch[];
  /**
   * Where the THESIS is wrong — not where a trade is wrong.
   *
   * Kept separate from every branch stop, and validated to differ from them,
   * because the two answer different questions and collapsing them is how a
   * plan quietly becomes "a trade with extra words". This can fire while a
   * position is in profit, and when it does the plan is over.
   */
  invalidation: ConditionGroup;
  /** Hard expiry, ms epoch. Required — see the module note. */
  expiresAt: number;
  risk: PlanRiskBudget;
  /** Branches are one-cancels-the-other unless explicitly disabled. */
  ocoExclusive: boolean;
  /** How often triggers, invalidation and drift are evaluated. */
  evalInterval: EvalInterval;
  notes?: string;
}

/* ── Validation: the falsifiability gate ────────────────────────────── */

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Longest a plan may sit armed. Two years of crypto is several markets. */
export const MAX_PLAN_HORIZON_MS = 1000 * 60 * 60 * 24 * 180;

function groupIsEmpty(group: ConditionGroup | undefined | null): boolean {
  if (!group || !Array.isArray(group.conditions) || group.conditions.length === 0) return true;
  return group.conditions.every((item) =>
    isCondition(item) ? false : groupIsEmpty(item as ConditionGroup)
  );
}

/** Stable-ish identity for a level, used only to compare stop vs. invalidation. */
function levelFingerprint(level: PriceLevel): string {
  if (level.kind === "static") return `static:${level.price}`;
  return `derived:${level.source}:${level.field ?? ""}:${level.window.from}-${level.window.to}`;
}

/**
 * Enforce the four falsifiability requirements, plus the structural rules that
 * make a plan mean one thing.
 *
 * `now` is injected so a test does not depend on the wall clock, and so the
 * authoring UI can preview validity at arm time.
 */
export function validatePlan(plan: TradePlan, now: number = Date.now()): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!plan.id?.trim()) errors.push("Add a name.");
  if (!plan.pair?.trim()) errors.push("Add a pair.");
  if (!Number.isInteger(plan.sessionId)) errors.push("Add a session.");
  if (!plan.thesis?.trim()) errors.push("Add a thesis — one sentence on what you expect.");

  /* 1. Assumptions. Without one there is nothing to be wrong about, and nothing
     the calibration record (S3-6) can score. */
  const assumptions = (plan.assumptions ?? []).filter((a) => a?.text?.trim());
  if (assumptions.length === 0) {
    errors.push("Add at least one assumption.");
  }

  /* 2. Invalidation, separate from every stop. A stop is where the *trade* is
     wrong; invalidation is where the *thesis* is, and it can fire while the
     position is in profit. */
  if (groupIsEmpty(plan.invalidation)) {
    errors.push("Add a thesis invalidation — the price that proves you wrong.");
  }

  /* 3. Hard expiry. A stale conditional firing weeks later into a different
     market is the worst failure mode of scenario automation. */
  if (!Number.isFinite(plan.expiresAt)) {
    errors.push("Add an expiry.");
  } else if (plan.expiresAt <= now) {
    errors.push("Expiry is in the past. Pick a future date.");
  } else if (plan.expiresAt - now > MAX_PLAN_HORIZON_MS) {
    errors.push(
      `Expiry is over ${Math.round(MAX_PLAN_HORIZON_MS / 86400000)} days out. Pick a nearer date.`
    );
  }

  /* 4. Its own risk budget — unvalidated conviction gets less capital than the
     session default, by construction. */
  if (!plan.risk || !Number.isFinite(plan.risk.maxQuote) || plan.risk.maxQuote <= 0) {
    errors.push("Add a risk budget for this plan.");
  }

  /* Branches. */
  const branches = plan.branches ?? [];
  if (branches.length === 0) errors.push("Add at least one branch.");

  const ids = new Set<string>();
  let budgetTotal = 0;
  for (const [i, b] of branches.entries()) {
    const where = b?.label?.trim() || `Branch ${i + 1}`;
    if (!b?.id?.trim()) errors.push(`${where}: add an id.`);
    else if (ids.has(b.id)) errors.push(`${where}: the id "${b.id}" is used twice.`);
    else ids.add(b.id);

    if (groupIsEmpty(b?.trigger)) errors.push(`${where}: add a trigger.`);
    if (!b?.entry) errors.push(`${where}: add an entry.`);
    if (!b?.stop) errors.push(`${where}: add a stop.`);
    if (!Array.isArray(b?.targets) || b.targets.length === 0) {
      errors.push(`${where}: add a target.`);
    }

    if (!Number.isFinite(b?.budgetSharePct) || b.budgetSharePct <= 0 || b.budgetSharePct > 100) {
      errors.push(`${where}: budget share must be between 0 and 100.`);
    } else {
      budgetTotal += b.budgetSharePct;
    }

    /* A developing level with no drift guard is a plan that silently becomes a
       different plan. The resolver fails such a level closed, so the plan would
       look armed and never fire — worse than refusing it here. */
    for (const [name, lv] of [["Entry", b?.entry], ["Stop", b?.stop]] as const) {
      if (lv && isDeveloping(lv) && !hasDriftGuard(lv)) {
        errors.push(`${where}: ${name.toLowerCase()} moves over time. Add a drift tolerance.`);
      }
    }
    for (const lv of b?.targets ?? []) {
      if (isDeveloping(lv) && !hasDriftGuard(lv)) {
        errors.push(`${where}: a target moves over time. Add a drift tolerance.`);
      }
    }
  }

  /* OCO branches share one budget; non-exclusive ones each spend their own. */
  if (plan.ocoExclusive && branches.length > 1 && budgetTotal > 100 + 1e-9) {
    errors.push(
      `Branch budgets total ${budgetTotal}%. They share one budget, so keep the total at 100% or under.`
    );
  }
  if (!plan.ocoExclusive && branches.length > 1) {
    warnings.push("More than one branch can trigger, so this plan may take several positions.");
  }

  /* Invalidation must not simply restate a stop. */
  const invalidationLevels = new Set(
    extractRequiredLevels(plan.invalidation ?? { logic: "and", conditions: [] }).map(levelFingerprint)
  );
  if (invalidationLevels.size > 0) {
    const everyStopIsInvalidation =
      branches.length > 0 &&
      branches.every((b) => b?.stop && invalidationLevels.has(levelFingerprint(b.stop)));
    if (everyStopIsInvalidation && invalidationLevels.size === 1) {
      /* If the only way the thesis can be wrong is the trade losing, it is a
         stop wearing a different label and the plan has no thesis test at all. */
      errors.push("Thesis invalidation is the same price as every stop. Set it somewhere else.");
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function hasDriftGuard(level: PriceLevel): boolean {
  if (level.kind !== "derived") return true;
  const t = level.driftTolerance;
  return !!t && (t.pct !== undefined || t.atr !== undefined || t.binChange === true);
}

/**
 * Is this plan past its expiry? Used by the monitor's expiry sweep (S3-3).
 *
 * Separate from `validatePlan` because an armed plan going stale is a normal
 * lifecycle event, not a validation failure.
 */
export function isPlanExpired(plan: Pick<TradePlan, "expiresAt">, now: number = Date.now()): boolean {
  return Number.isFinite(plan.expiresAt) && now >= plan.expiresAt;
}
