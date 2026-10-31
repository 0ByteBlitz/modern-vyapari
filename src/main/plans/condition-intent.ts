/**
 * What the trader meant, compiled into what the engine evaluates
 * (roadmap S2-8, `docs/ARCHITECTURE.md` §5).
 *
 * `plans-page.tsx` was building `ConditionGroup` JSON by hand:
 *
 * ```ts
 * { logic: "and", conditions: [{ indicator: "price", params: {}, operator, value }] }
 * ```
 *
 * That is domain structure assembled in React. It is the clearest instance of
 * the "features glued by frontend" problem — the renderer knew the wire format
 * of the thing the engine evaluates, so changing that format broke a UI file,
 * and a malformed group could be stored by a caller that simply got it wrong.
 *
 * The renderer now sends an **intent** — "price crosses above 72000" — and this
 * compiles it. The renderer describes; main constructs.
 *
 * Pure, and deliberately small. It is not a rules engine: the point is that
 * there is exactly one place where a UI choice becomes an evaluable condition,
 * so a new operator or a new left-hand side is added here rather than in a
 * component.
 */

import type { Condition, ConditionGroup, ConditionOperator } from "../strategy/strategy-spec";
import type { PriceLevel } from "../../shared/levels";
import { isPriceLevelLike } from "../../shared/levels";

/** Operators a plan may be authored with. A subset of the engine's, because a
 *  plan trigger is a threshold crossing, not an arbitrary expression. */
const PLAN_OPERATORS: ConditionOperator[] = ["above", "below", "crosses_above", "crosses_below"];

/**
 * One authored condition.
 *
 * `value` is a number or a `PriceLevel` — the same union `Condition.value`
 * accepts — so a plan can be written against a promoted reference without the
 * renderer knowing what a reference *is* structurally.
 */
export interface ConditionIntent {
  /** What is being compared. Only price today; the field exists so adding an
   *  indicator later changes this module rather than a component. */
  subject: "price";
  operator: ConditionOperator;
  value: number | PriceLevel;
}

export type CompileResult =
  | { ok: true; group: ConditionGroup }
  | { ok: false; reason: string };

function validValue(v: unknown): v is number | PriceLevel {
  if (typeof v === "number") return Number.isFinite(v);
  return isPriceLevelLike(v);
}

/**
 * Compile one intent into the group the evaluator consumes.
 *
 * Returns a refusal rather than throwing, because every caller is a user
 * action and the reason belongs on screen. A malformed intent must never
 * become an empty `ConditionGroup`: `groupIsEmpty` treats that as "no
 * condition", which `validatePlan` reads as a missing invalidation — so a
 * silently-dropped condition would surface as a confusing gate failure three
 * steps later instead of at the point it went wrong.
 */
export function compileIntent(intent: ConditionIntent | null | undefined): CompileResult {
  if (!intent) return { ok: false, reason: "No condition was given." };
  if (intent.subject !== "price") {
    return { ok: false, reason: `Unsupported condition subject "${intent.subject}".` };
  }
  if (!PLAN_OPERATORS.includes(intent.operator)) {
    return { ok: false, reason: `Unsupported operator "${intent.operator}".` };
  }
  if (!validValue(intent.value)) {
    return {
      ok: false,
      reason: "That condition needs a price or a level — a blank or non-numeric value cannot be evaluated.",
    };
  }

  /**
   * `field: "close"` is not optional decoration — it is the whole condition.
   *
   * `evaluateCondition` looks values up by `makeIndicatorKey(indicator, params,
   * field)`, and the engine only ever publishes *field-qualified* price keys
   * (`price::close`, `price::high`, …). A condition with no field builds the
   * key `price:`, which matches nothing, resolves to null, and reads **false**
   * — for ever. Every plan trigger and invalidation compiled before this was
   * incapable of ever being true, while the plan displayed as armed.
   *
   * Close is the right field: plans evaluate on closed bars, so "price above X"
   * means the bar closed above X, not that a wick touched it.
   */
  const condition: Condition = {
    indicator: "price",
    params: {},
    field: "close",
    operator: intent.operator,
    value: intent.value,
  };
  return { ok: true, group: { logic: "and", conditions: [condition] } };
}

/** Human description of an intent, for confirmations and audit lines. */
export function describeIntent(intent: ConditionIntent): string {
  const verb: Record<string, string> = {
    above: "is above",
    below: "is below",
    crosses_above: "crosses above",
    crosses_below: "crosses below",
  };
  const value = typeof intent.value === "number" ? String(intent.value) : "a level";
  return `price ${verb[intent.operator] ?? intent.operator} ${value}`;
}
