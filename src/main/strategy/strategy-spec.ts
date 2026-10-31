/**
 * Strategy spec format (plan §6): JSON schema, validation, and condition evaluation.
 *
 * Strategies are formal machine-executable specs. Claude discusses strategy ideas
 * in natural language, then compiles the agreed-upon logic into a StrategySpec
 * that the deterministic engine can run. Specs are versioned; edits create a new
 * version that restarts at DRAFT.
 */

import type { IndicatorConfig } from "../insights/indicator-types";
import { makeIndicatorKey } from "../insights/indicator-types";
import type { PriceLevel } from "../../shared/levels";
import { isPriceLevelLike } from "../../shared/levels";

/* ── Core types ─────────────────────────────────────────────────────── */

export type StrategyType = "signal" | "dca" | "grid";

export type ConditionOperator =
  | "above"
  | "below"
  | "crosses_above"
  | "crosses_below"
  | "between";

/**
 * A condition's threshold.
 *
 * Historically always a plain number. It now also accepts a `PriceLevel`
 * (plan §17.6) so a condition can be written against a *derived* level —
 * "close above the value-area high", "price crosses the anchored VWAP" — rather
 * than only against a number typed in at authoring time.
 *
 * Levels are **pre-resolved by the caller**, exactly as indicators are
 * pre-computed, and handed to the evaluator in a map. That keeps this module a
 * pure function: the one evaluation path stays free of DB access, so the paper
 * engine, the backtester, the alert engine and the scenario dry-run cannot drift
 * apart in how they read a condition.
 */
export type ConditionThreshold =
  | number
  | [number, number]
  | PriceLevel
  | [number | PriceLevel, number | PriceLevel];

/** A single condition comparing an indicator (or price/volume) to a threshold. */
export interface Condition {
  /** Indicator name, e.g. "rsi", "macd". Use "price" or "volume" for raw candle fields. */
  indicator: string;
  /** Indicator parameters, e.g. { period: 14 }. Empty {} for price/volume. */
  params: Record<string, number | string>;
  /** For multi-output indicators: which output field to read (e.g. "histogram" for MACD). */
  field?: string;
  /** Comparison operator. */
  operator: ConditionOperator;
  /** Threshold: a number, `[low, high]` for "between", or a `PriceLevel`. */
  value: ConditionThreshold;
}

/* ── Price-level thresholds ─────────────────────────────────────────── */

/** Is this threshold entry a `PriceLevel` rather than a plain number?
 *  Delegates to the shared structural check so there is one definition of what
 *  "looks like a level" — the display layer and the evaluator must agree. */
export function isPriceLevel(v: unknown): v is PriceLevel {
  return isPriceLevelLike(v);
}

/**
 * Deterministic key for a `PriceLevel`, so a resolver and an evaluator can
 * agree on which resolved number belongs to which reference. Same role as
 * `makeIndicatorKey`, and same reason: the two sides must never guess.
 */
export function makeLevelKey(level: PriceLevel): string {
  if (level.kind === "static") return `static:${level.price}`;
  const params = Object.entries(level.params ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(",");
  return [
    "derived",
    level.source,
    level.field ?? "",
    `${level.window.from}-${level.window.to}`,
    level.resolve,
    params,
  ].join(":");
}

/**
 * Every `PriceLevel` referenced by a spec's conditions, deduped — the level
 * counterpart to `extractRequiredIndicators`. A caller resolves these before
 * evaluating, so the evaluator never has to reach for data mid-comparison.
 */
export function extractRequiredLevels(group: ConditionGroup): PriceLevel[] {
  const seen = new Set<string>();
  const out: PriceLevel[] = [];

  const consider = (v: unknown) => {
    if (!isPriceLevel(v)) return;
    const key = makeLevelKey(v);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  const walk = (g: ConditionGroup): void => {
    for (const item of g.conditions) {
      if (isCondition(item)) {
        const v = item.value;
        if (Array.isArray(v)) v.forEach(consider);
        else consider(v);
      } else {
        walk(item);
      }
    }
  };

  walk(group);
  return out;
}

/**
 * Turn one threshold entry into a number.
 *
 * Returns `null` when a level could not be resolved — insufficient history, an
 * unknown aggressor split, a level the caller forgot to resolve. Null propagates
 * to "condition is false"; it must NEVER fall back to a substitute number,
 * because a level nobody could compute is precisely the value that must not
 * quietly become a trigger.
 */
function resolveThresholdEntry(
  entry: number | PriceLevel,
  levels: ReadonlyMap<string, number | null> | undefined
): number | null {
  if (typeof entry === "number") return Number.isFinite(entry) ? entry : null;
  if (!isPriceLevel(entry)) return null;
  if (entry.kind === "static") return Number.isFinite(entry.price) ? entry.price : null;
  const resolved = levels?.get(makeLevelKey(entry));
  return resolved === undefined || resolved === null || !Number.isFinite(resolved) ? null : resolved;
}

/** A group of conditions combined with AND/OR logic. Supports arbitrary nesting. */
export interface ConditionGroup {
  logic: "and" | "or";
  conditions: (Condition | ConditionGroup)[];
}

export interface SizingConfig {
  /** "fixed_quote" = fixed quote-currency amount per trade.
   *  "percent_balance" = percentage of available balance.
   *  "scaled" = scaled by signal strength (future). */
  mode: "fixed_quote" | "percent_balance" | "scaled";
  /** The amount: quote currency for fixed_quote, percentage (0–100) for percent_balance. */
  amount: number;
  /** Quote currency override (defaults to the pair's quote currency). */
  currency?: string;
}

export type EvalInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export interface ScheduleConfig {
  /** How often to evaluate entry/exit conditions. */
  eval_interval: EvalInterval;
}

export interface StrategyRiskConfig {
  max_open_positions: number;
  max_daily_trades: number;
  /** Hard stop-loss as percentage below entry (e.g. 2 = 2%). */
  stop_loss_pct?: number;
  /** Hard take-profit as percentage above entry (e.g. 4 = 4%). */
  take_profit_pct?: number;
  /** Trailing stop distance as percentage below highest price seen since entry. */
  trailing_stop_pct?: number;
  /** Move stop-loss to entry price once unrealized profit reaches this percentage. */
  breakeven_trigger_pct?: number;
  /** Multi-target trimming configuration (e.g. [{ pct: 4, trim_share: 0.5 }]). */
  targets?: Array<{ pct: number; trim_share: number }>;
}

/** Full strategy specification (plan §6). */
export interface StrategySpec {
  /** Human-readable slug, e.g. "btc-rsi-dip-v2". */
  id: string;
  /** Trading pair, e.g. "BTC-USD". */
  pair: string;
  /** Strategy archetype. */
  type: StrategyType;
  /** When to enter a position. */
  entry: ConditionGroup;
  /** When to exit a position. */
  exit: ConditionGroup;
  /** Position sizing. */
  sizing: SizingConfig;
  /** Evaluation schedule. */
  schedule: ScheduleConfig;
  /** Per-strategy risk limits. */
  risk: StrategyRiskConfig;
  /** Human-readable summary (Claude can write this). */
  description?: string;
}

/* ── Lifecycle ──────────────────────────────────────────────────────── */

/**
 * Lifecycle states (plan §6):
 *   DRAFT → BACKTESTED → PAPER → LIVE_SUPERVISED → LIVE_AUTO
 *   Any state → RETIRED (terminal)
 *   Editing a non-DRAFT strategy creates a new version at DRAFT.
 */
// Defined in the shared IPC contract so the renderer agrees on the spelling
// of states that gate real money; re-exported here for engine code.
export type { StrategyState } from "../../shared/ipc-types";
import type { StrategyState } from "../../shared/ipc-types";

export const VALID_STRATEGY_STATES: readonly StrategyState[] = [
  "draft",
  "backtested",
  "paper",
  "live_supervised",
  "live_auto",
  "retired",
];

/** Allowed state transitions. */
export const STATE_TRANSITIONS: Record<StrategyState, readonly StrategyState[]> = {
  draft: ["backtested", "retired"],
  backtested: ["paper", "draft", "retired"],
  paper: ["live_supervised", "draft", "retired"],
  live_supervised: ["live_auto", "paper", "retired"],
  live_auto: ["live_supervised", "retired"],
  retired: [],
};

/* ── Type guards ────────────────────────────────────────────────────── */

export function isCondition(item: Condition | ConditionGroup): item is Condition {
  return "indicator" in item;
}

export function isConditionGroup(item: Condition | ConditionGroup): item is ConditionGroup {
  return "logic" in item;
}

/* ── Validation ─────────────────────────────────────────────────────── */

const VALID_OPERATORS: readonly ConditionOperator[] = [
  "above",
  "below",
  "crosses_above",
  "crosses_below",
  "between",
];

const VALID_TYPES: readonly StrategyType[] = ["signal", "dca", "grid"];

const VALID_INTERVALS: readonly EvalInterval[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];

const VALID_SIZING_MODES: readonly SizingConfig["mode"][] = ["fixed_quote", "percent_balance", "scaled"];

const PAIR_RE = /^[A-Z0-9]+-[A-Z0-9]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateConditionGroup(
  group: unknown,
  path: string,
  errors: string[]
): void {
  if (!group || typeof group !== "object") {
    errors.push(`${path}: must be an object`);
    return;
  }

  const g = group as Record<string, unknown>;

  if (g.logic !== "and" && g.logic !== "or") {
    errors.push(`${path}.logic: must be "and" or "or"`);
  }

  if (!Array.isArray(g.conditions) || g.conditions.length === 0) {
    errors.push(`${path}.conditions: must be a non-empty array`);
    return;
  }

  for (let i = 0; i < g.conditions.length; i++) {
    const item = g.conditions[i] as Record<string, unknown>;
    const itemPath = `${path}.conditions[${i}]`;

    if (item && typeof item === "object" && "logic" in item) {
      // Nested ConditionGroup
      validateConditionGroup(item, itemPath, errors);
    } else if (item && typeof item === "object" && "indicator" in item) {
      // Leaf Condition
      validateCondition(item, itemPath, errors);
    } else {
      errors.push(`${itemPath}: must be a Condition or ConditionGroup`);
    }
  }
}

function validateCondition(
  cond: Record<string, unknown>,
  path: string,
  errors: string[]
): void {
  if (typeof cond.indicator !== "string" || !cond.indicator) {
    errors.push(`${path}.indicator: must be a non-empty string`);
  }

  if (cond.params !== undefined && (typeof cond.params !== "object" || cond.params === null || Array.isArray(cond.params))) {
    errors.push(`${path}.params: must be an object`);
  }

  if (cond.field !== undefined && typeof cond.field !== "string") {
    errors.push(`${path}.field: must be a string if provided`);
  }

  if (!VALID_OPERATORS.includes(cond.operator as ConditionOperator)) {
    errors.push(`${path}.operator: must be one of ${VALID_OPERATORS.join(", ")}`);
  }

  if (cond.operator === "between") {
    if (!Array.isArray(cond.value) || cond.value.length !== 2) {
      errors.push(`${path}.value: must be [low, high] for "between" operator`);
    } else {
      const [lo, hi] = cond.value as unknown[];
      const loOk = typeof lo === "number" || isPriceLevel(lo);
      const hiOk = typeof hi === "number" || isPriceLevel(hi);
      if (!loOk || !hiOk) {
        errors.push(`${path}.value: each bound must be a number or a PriceLevel`);
      } else {
        validateLevelEntry(lo, `${path}.value[0]`, errors);
        validateLevelEntry(hi, `${path}.value[1]`, errors);
        /* Only orderable when both bounds are literal numbers. Two derived
           levels can legitimately cross as the market moves, so ordering them
           at authoring time would reject a valid band. */
        if (typeof lo === "number" && typeof hi === "number" && lo >= hi) {
          errors.push(`${path}.value: low must be less than high`);
        }
      }
    }
  } else {
    if (typeof cond.value !== "number" && !isPriceLevel(cond.value)) {
      errors.push(`${path}.value: must be a number or a PriceLevel for "${cond.operator}" operator`);
    } else {
      validateLevelEntry(cond.value, `${path}.value`, errors);
    }
  }
}

/**
 * Validate a `PriceLevel` threshold. Numbers pass straight through.
 *
 * The rules enforced here are the ones that make a *developing* level safe to
 * arm against (plan §17.6) — without them a plan can be armed against a level
 * that is free to wander anywhere before it triggers.
 */
function validateLevelEntry(entry: unknown, path: string, errors: string[]): void {
  if (!isPriceLevel(entry)) return;

  if (entry.kind === "static") {
    if (!Number.isFinite(entry.price)) errors.push(`${path}.price: must be a finite number`);
    return;
  }

  if (!entry.window || typeof entry.window.from !== "number") {
    errors.push(`${path}.window.from: derived levels need an anchor timestamp`);
  }
  if (
    entry.window &&
    entry.window.to !== "developing" &&
    typeof entry.window.to !== "number"
  ) {
    errors.push(`${path}.window.to: must be a timestamp or "developing"`);
  }
  if (!Number.isFinite(entry.resolvedAtArm)) {
    errors.push(
      `${path}.resolvedAtArm: required — it is the baseline every drift check measures against, ` +
        `and without it "has this level moved?" is unanswerable`
    );
  }

  const isDeveloping = entry.window?.to === "developing" && entry.resolve === "live";
  if (isDeveloping) {
    const t = entry.driftTolerance;
    const hasGuard = !!t && (t.pct !== undefined || t.atr !== undefined || t.binChange === true);
    if (!hasGuard) {
      errors.push(
        `${path}.driftTolerance: a live, developing level must declare a drift guard (pct, atr or binChange) — ` +
          `otherwise it can wander into a different trade than the one that was approved`
      );
    }
    if (entry.onDrift !== "reconfirm" && entry.onDrift !== "invalidate") {
      errors.push(`${path}.onDrift: must be "reconfirm" or "invalidate"`);
    }
  }
}

/**
 * Validates a strategy spec. Returns an array of error strings (empty = valid).
 */
export function validateSpec(spec: unknown): string[] {
  const errors: string[] = [];

  if (!spec || typeof spec !== "object") {
    return ["Spec must be an object"];
  }

  const s = spec as Record<string, unknown>;

  // id
  if (typeof s.id !== "string" || !SLUG_RE.test(s.id)) {
    errors.push("id: must be a lowercase slug (a-z, 0-9, hyphens)");
  }

  // pair
  if (typeof s.pair !== "string" || !PAIR_RE.test(s.pair)) {
    errors.push("pair: must match format like BTC-USD");
  }

  // type
  if (!VALID_TYPES.includes(s.type as StrategyType)) {
    errors.push(`type: must be one of ${VALID_TYPES.join(", ")}`);
  }

  // entry / exit
  validateConditionGroup(s.entry, "entry", errors);
  validateConditionGroup(s.exit, "exit", errors);

  // sizing
  if (!s.sizing || typeof s.sizing !== "object") {
    errors.push("sizing: must be an object");
  } else {
    const sizing = s.sizing as Record<string, unknown>;
    if (!VALID_SIZING_MODES.includes(sizing.mode as SizingConfig["mode"])) {
      errors.push(`sizing.mode: must be one of ${VALID_SIZING_MODES.join(", ")}`);
    }
    if (typeof sizing.amount !== "number" || sizing.amount <= 0) {
      errors.push("sizing.amount: must be a positive number");
    }
    if (sizing.mode === "percent_balance" && typeof sizing.amount === "number" && sizing.amount > 100) {
      errors.push("sizing.amount: cannot exceed 100 for percent_balance mode");
    }
  }

  // schedule
  if (!s.schedule || typeof s.schedule !== "object") {
    errors.push("schedule: must be an object");
  } else {
    const schedule = s.schedule as Record<string, unknown>;
    if (!VALID_INTERVALS.includes(schedule.eval_interval as EvalInterval)) {
      errors.push(`schedule.eval_interval: must be one of ${VALID_INTERVALS.join(", ")}`);
    }
  }

  // risk
  if (!s.risk || typeof s.risk !== "object") {
    errors.push("risk: must be an object");
  } else {
    const risk = s.risk as Record<string, unknown>;
    if (typeof risk.max_open_positions !== "number" || risk.max_open_positions < 1) {
      errors.push("risk.max_open_positions: must be a positive integer");
    }
    if (typeof risk.max_daily_trades !== "number" || risk.max_daily_trades < 1) {
      errors.push("risk.max_daily_trades: must be a positive integer");
    }
    if (risk.stop_loss_pct !== undefined) {
      if (typeof risk.stop_loss_pct !== "number" || risk.stop_loss_pct <= 0 || risk.stop_loss_pct > 100) {
        errors.push("risk.stop_loss_pct: must be between 0 and 100 (exclusive/inclusive)");
      }
    }
    if (risk.take_profit_pct !== undefined) {
      if (typeof risk.take_profit_pct !== "number" || risk.take_profit_pct <= 0 || risk.take_profit_pct > 1000) {
        errors.push("risk.take_profit_pct: must be between 0 and 1000");
      }
    }
    if (risk.trailing_stop_pct !== undefined) {
      if (typeof risk.trailing_stop_pct !== "number" || risk.trailing_stop_pct <= 0 || risk.trailing_stop_pct > 100) {
        errors.push("risk.trailing_stop_pct: must be between 0 and 100");
      }
    }
    if (risk.breakeven_trigger_pct !== undefined) {
      if (typeof risk.breakeven_trigger_pct !== "number" || risk.breakeven_trigger_pct <= 0 || risk.breakeven_trigger_pct > 1000) {
        errors.push("risk.breakeven_trigger_pct: must be between 0 and 1000");
      }
    }
    if (risk.targets !== undefined) {
      if (!Array.isArray(risk.targets)) {
        errors.push("risk.targets: must be an array of { pct, trim_share } objects");
      } else {
        for (let i = 0; i < risk.targets.length; i++) {
          const t = risk.targets[i] as any;
          if (!t || typeof t.pct !== "number" || t.pct <= 0) {
            errors.push(`risk.targets[${i}].pct: must be a positive number`);
          }
          if (!t || typeof t.trim_share !== "number" || t.trim_share <= 0 || t.trim_share > 1) {
            errors.push(`risk.targets[${i}].trim_share: must be a number between 0 and 1`);
          }
        }
      }
    }
  }

  return errors;
}

/* ── Condition evaluation ───────────────────────────────────────────── */

/**
 * Evaluate a single condition against current and previous indicator values.
 *
 * @param currentValues  Map of indicator key → current numeric value
 * @param previousValues Map of indicator key → previous-bar numeric value
 *                       (needed for crosses_above / crosses_below)
 */
function evaluateCondition(
  condition: Condition,
  currentValues: ReadonlyMap<string, number | null>,
  previousValues: ReadonlyMap<string, number | null>,
  levels?: ReadonlyMap<string, number | null>
): boolean {
  const key = makeIndicatorKey(
    condition.indicator,
    condition.params || {},
    condition.field
  );

  const current = currentValues.get(key) ?? null;
  if (current === null) return false; // can't evaluate without a current value

  if (condition.operator === "between") {
    const raw = condition.value;
    if (!Array.isArray(raw) || raw.length !== 2) return false;
    const lo = resolveThresholdEntry(raw[0] as number | PriceLevel, levels);
    const hi = resolveThresholdEntry(raw[1] as number | PriceLevel, levels);
    if (lo === null || hi === null) return false;
    return current >= lo && current <= hi;
  }

  const threshold = resolveThresholdEntry(condition.value as number | PriceLevel, levels);
  // An unresolvable threshold makes the condition false, never "true by
  // default" — the same discipline as a missing indicator value above.
  if (threshold === null) return false;

  switch (condition.operator) {
    case "above":
      return current > threshold;

    case "below":
      return current < threshold;

    case "crosses_above": {
      const prev = previousValues.get(key) ?? null;
      if (prev === null) return false;
      return prev <= threshold && current > threshold;
    }

    case "crosses_below": {
      const prev = previousValues.get(key) ?? null;
      if (prev === null) return false;
      return prev >= threshold && current < threshold;
    }

    default:
      return false;
  }
}

/**
 * Recursively evaluate a condition group (AND / OR logic, with nesting).
 *
 * @param group          The condition group to evaluate.
 * @param currentValues  Map of indicator key → current numeric value.
 * @param previousValues Map of indicator key → previous-bar numeric value.
 * @param levels         Optional map of `makeLevelKey()` → resolved level price,
 *                       for conditions whose threshold is a `PriceLevel`.
 *                       Omitting it leaves numeric thresholds working exactly as
 *                       before, so every existing caller is unchanged.
 * @returns `true` if the group's conditions are satisfied.
 */
export function evaluateConditionGroup(
  group: ConditionGroup,
  currentValues: ReadonlyMap<string, number | null>,
  previousValues: ReadonlyMap<string, number | null>,
  levels?: ReadonlyMap<string, number | null>
): boolean {
  const results = group.conditions.map((item) => {
    if (isCondition(item)) {
      return evaluateCondition(item, currentValues, previousValues, levels);
    } else {
      return evaluateConditionGroup(item, currentValues, previousValues, levels);
    }
  });

  return group.logic === "and"
    ? results.every(Boolean)
    : results.some(Boolean);
}

/* ── Indicator extraction ───────────────────────────────────────────── */

/**
 * Extract all unique indicators referenced by a strategy spec's entry
 * and exit conditions. Returns a list of { name, params } pairs (deduped)
 * that the caller must pre-compute before evaluation.
 *
 * "price" and "volume" are excluded — those are read directly from candles.
 */
export function extractRequiredIndicators(spec: StrategySpec): IndicatorConfig[] {
  const seen = new Set<string>();
  const result: IndicatorConfig[] = [];

  function walk(group: ConditionGroup): void {
    for (const item of group.conditions) {
      if (isCondition(item)) {
        if (item.indicator === "price" || item.indicator === "volume") continue;
        const key = makeIndicatorKey(item.indicator, item.params || {});
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ name: item.indicator, params: item.params || {} });
        }
      } else {
        walk(item);
      }
    }
  }

  walk(spec.entry);
  walk(spec.exit);
  return result;
}

/**
 * Checks whether a state transition is allowed by the lifecycle rules.
 */
export function isValidTransition(from: StrategyState, to: StrategyState): boolean {
  return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}
