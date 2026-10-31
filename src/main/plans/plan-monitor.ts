/**
 * What an armed plan should do on a given bar (roadmap S3-3).
 *
 * **Pure.** No database, no clock, no engine. It is handed a plan, the current
 * bar, and two resolved lookups, and it returns *decisions*. The applying half
 * lives in `plan-service`, so the rules can be tested exhaustively without a
 * paper engine and so every consumer — the monitor, a dry run (S3-5), a replay
 * — judges a plan by one implementation.
 *
 * ## The order of checks is the design
 *
 * A bar can satisfy several conditions at once, and which one wins changes what
 * gets recorded in the calibration record — the thing the whole plans-only
 * product is meant to accumulate. So the precedence is fixed and deliberate:
 *
 *  1. **Expiry** — a plan past its horizon does nothing else, ever. A stale
 *     conditional firing weeks later into a different market is the worst
 *     failure mode of scenario automation, so expiry beats a trigger on the
 *     same bar.
 *  2. **Thesis invalidation** — if the thesis is disproved, the plan is over
 *     even if a branch would otherwise have fired. Firing *and* invalidating on
 *     one bar and recording it as a trigger would flatter the thesis.
 *  3. **Drift** — an armed level that has wandered past its tolerance is no
 *     longer the level that was approved, so a branch resting on it must not
 *     trigger. Checked before triggers, never after.
 *  4. **Triggers** — and only then.
 *
 * Note that 1–3 can all fire while a position is green. That is the point of
 * separating thesis invalidation from a stop.
 */

import type { ConditionGroup } from "../strategy/strategy-spec";
import type { PriceLevel } from "../../shared/levels";
import type { LevelDraft } from "./level-reference";
import type { StoredPlan, StoredBranch } from "./plan-service";

/* ── Inputs ─────────────────────────────────────────────────────────── */

/** Everything the monitor needs from the outside world, injected. */
export interface PlanBarContext {
  /** Bar being evaluated (its close timestamp). */
  now: number;
  /**
   * Evaluate a condition group against this bar.
   *
   * Injected rather than imported so the monitor never reaches for candles or
   * indicators itself — and so the caller guarantees it is the *same*
   * evaluator the paper engine and the alert engine use.
   */
  evaluate: (group: ConditionGroup) => boolean;
  /**
   * Resolve a level now. `null` means unresolvable, which is a value: it must
   * never become a substitute number.
   */
  resolve: (level: PriceLevel) => { price: number | null; drifted?: boolean };
}

/* ── Decisions ──────────────────────────────────────────────────────── */

export type PlanOutcome =
  | { kind: "none" }
  | { kind: "expired"; reason: string }
  | { kind: "invalidated"; reason: string }
  | { kind: "triggered"; branchId: string; cancelledBranchIds: string[]; reason: string };

export interface PlanEvaluation {
  outcome: PlanOutcome;
  /** Branches that could not be evaluated, and why. Surfaced rather than
   *  swallowed: a plan that silently cannot fire looks armed and is not. */
  notices: string[];
}

/* ── Evaluation ─────────────────────────────────────────────────────── */

const isDerived = (l: LevelDraft): l is Extract<LevelDraft, { kind: "derived" }> => l.kind === "derived";

/**
 * A branch's own levels, for the drift check.
 *
 * Targets are included deliberately. A target that has drifted means the
 * reward half of the geometry changed, and entering against a stop the trader
 * approved toward a target they did not is not the trade that was approved.
 */
function branchLevels(b: StoredBranch): LevelDraft[] {
  return [b.entry, b.stop, ...b.targets];
}

export function evaluatePlan(plan: StoredPlan, ctx: PlanBarContext): PlanEvaluation {
  const notices: string[] = [];

  /* 1. Expiry first — see the precedence note. */
  if (Number.isFinite(plan.expiresAt) && ctx.now >= plan.expiresAt) {
    return {
      outcome: { kind: "expired", reason: `Expiry passed (${new Date(plan.expiresAt).toISOString()}).` },
      notices,
    };
  }

  /* 2. Thesis invalidation, before any trigger. */
  if (ctx.evaluate(plan.invalidation)) {
    return {
      outcome: { kind: "invalidated", reason: "Thesis invalidation condition became true." },
      notices,
    };
  }

  /* 3 + 4. Per branch: drift disqualifies before a trigger is even considered. */
  const pending = plan.branches.filter((b) => b.status === "pending");

  for (const b of pending) {
    const drifted = branchLevels(b)
      .filter(isDerived)
      .map((lv) => ({ lv, r: ctx.resolve(lv as unknown as PriceLevel) }))
      .filter(({ r }) => r.price === null || r.drifted);

    if (drifted.length > 0) {
      const why = drifted[0]!.r.price === null ? "could not be resolved" : "drifted past its tolerance";
      notices.push(`${b.label}: a level ${why}, so this branch cannot trigger.`);
      continue;
    }

    if (!ctx.evaluate(b.trigger)) continue;

    /* OCO: the first branch to fire cancels its siblings. Without this a plan
       describing two ways the market might resolve could take both and end up
       silently double-sized. `ocoExclusive` defaults true; when it is off the
       trader was warned at authoring time. */
    const cancelled = plan.ocoExclusive ? pending.filter((o) => o.id !== b.id).map((o) => o.id) : [];

    return {
      outcome: {
        kind: "triggered",
        branchId: b.id,
        cancelledBranchIds: cancelled,
        reason: `Trigger condition met for "${b.label}".`,
      },
      notices,
    };
  }

  return { outcome: { kind: "none" }, notices };
}

/**
 * Is this plan worth evaluating at all on this bar?
 *
 * Cheap pre-filter so the hot path does not resolve levels for plans that
 * cannot act. `planned` is the only state that can trigger; `triggered` plans
 * still need watching, because a thesis can be disproved while its position is
 * open — which is exactly the case a naive "only watch un-triggered plans"
 * filter would miss.
 */
export function planIsWatchable(plan: Pick<StoredPlan, "state">): boolean {
  return plan.state === "planned" || plan.state === "triggered";
}
