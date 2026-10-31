/**
 * Would this plan do anything? (roadmap S3-5)
 *
 * ## What this is, and the line it must not cross
 *
 * The falsifiability gate asks whether a plan can be *wrong*. Nothing has ever
 * asked whether it can **fire**. A plan whose trigger never becomes true and a
 * plan whose trigger is true on every bar arm identically, display identically,
 * and are both silently useless — one never trades, the other is not a scenario
 * at all but a permanently-satisfied condition wearing a thesis.
 *
 * **This is structural, not statistical, and the distinction is the whole
 * design.** It reports *how a plan behaves against recent bars* — fires / never
 * fires / fires constantly, reachable / unreachable, exclusive / overlapping.
 * It reports **no PnL, no win rate, no expectancy, and the return type has
 * nowhere to put one.** A plan is a one-shot bet on a path; statistical
 * validation of it is inapplicable, not merely unavailable, and a two-trade
 * sample dressed as a backtest launders a guess into a metric. That is the
 * reason the strategy path was frozen, and it must not be reintroduced through
 * a side door labelled "dry run".
 *
 * ## Why the answer can be trusted
 *
 * It replays `evaluatePlan` — the same pure decision layer the live monitor
 * calls — over cached bars, with the same `barValues` keys and the same
 * point-in-time level resolution. It is not a second implementation of the
 * monitor's rules; it is the monitor, given history instead of a live stream.
 *
 * ## What it cannot tell you
 *
 * That a trigger fired often in the past says nothing about whether it will
 * fire again, and this report never implies otherwise. It answers "is this
 * plan structurally sound", which is a question about the plan, not the market.
 */

import { evaluatePlan } from "./plan-monitor";
import type { StoredPlan } from "./plan-service";
import { LevelResolver, dbCandleSource, type CandleSource } from "../insights/level-resolver";
import { evaluateConditionGroup, extractRequiredLevels, makeLevelKey } from "../strategy/strategy-spec";
import { barValues } from "../insights/bar-values";
import type { CandleNumeric } from "../insights/indicator-types";
import type { PriceLevel } from "../../shared/levels";
import { formatLevel } from "../../shared/levels";
import type { EvalInterval } from "../strategy/strategy-spec";

const INTERVAL_MINUTES: Record<EvalInterval, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

/** Bars to replay. Enough to see behaviour, few enough to stay interactive. */
const DEFAULT_BARS = 400;

/**
 * A trigger true on more than this share of bars is not describing a scenario.
 * Deliberately generous — the failure being caught is "always true", not "fires
 * a bit more than I expected".
 */
const CONSTANT_SHARE = 0.5;

export interface BranchDryRun {
  id: string;
  label: string;
  /** Bars on which this branch's trigger condition was true. */
  firedBars: number;
  /** Timestamp of the first bar it would have fired on, if any. */
  firstFireAt: number | null;
  /** True when the condition was never satisfied over the window. */
  unreachable: boolean;
  /** True when it was satisfied on most bars — not a scenario. */
  constant: boolean;
  /** Bars where this branch and another were both true. */
  overlappingBars: number;
}

export type DryRunVerdict = "fires" | "never_fires" | "fires_constantly" | "already_over" | "cannot_evaluate";

export interface PlanDryRun {
  verdict: DryRunVerdict;
  /** One sentence for the owner. The UI shows this; the detail is below it. */
  headline: string;
  barsExamined: number;
  from: number | null;
  to: number | null;
  intervalMin: number;
  branches: BranchDryRun[];
  /** Bars on which the thesis invalidation was already true. */
  invalidationBars: number;
  /** True when the invalidation holds on the most recent bar — the plan would
   *  be over the moment it was armed. */
  invalidatedNow: boolean;
  /** Levels that could not be resolved, and why. */
  problems: string[];
  /** Things worth saying that are not failures. */
  notes: string[];
}

export interface DryRunOptions {
  bars?: number;
  /** Injectable so tests (and a future replay UI) can feed their own series. */
  candleSource?: CandleSource;
  /** Overridable for determinism in tests. */
  now?: number;
}

function empty(plan: StoredPlan, intervalMin: number, headline: string, verdict: DryRunVerdict): PlanDryRun {
  return {
    verdict,
    headline,
    barsExamined: 0,
    from: null,
    to: null,
    intervalMin,
    branches: plan.branches.map((b) => ({
      id: b.id,
      label: b.label,
      firedBars: 0,
      firstFireAt: null,
      unreachable: false,
      constant: false,
      overlappingBars: 0,
    })),
    invalidationBars: 0,
    invalidatedNow: false,
    problems: [],
    notes: [],
  };
}

export function dryRunPlan(plan: StoredPlan, opts: DryRunOptions = {}): PlanDryRun {
  const intervalMin = INTERVAL_MINUTES[plan.evalInterval] ?? 240;
  const source = opts.candleSource ?? dbCandleSource;
  const now = opts.now ?? Date.now();
  const wanted = opts.bars ?? DEFAULT_BARS;

  const bars: CandleNumeric[] = source(plan.pair, intervalMin, 0, now);
  const window = bars.slice(-wanted);

  if (window.length < 2) {
    /* Two bars is the floor: every crosses_above/crosses_below compares a bar
       with its predecessor, so one bar cannot express a cross. Saying "cannot
       evaluate" beats reporting "never fires", which would be a claim about the
       plan when the truth is a claim about the history. */
    return empty(
      plan,
      intervalMin,
      `No cached ${plan.evalInterval} history for ${plan.pair} — open it on Research first.`,
      "cannot_evaluate"
    );
  }

  const problems: string[] = [];
  const notes: string[] = [];
  const seenProblem = new Set<string>();

  /* A fresh resolver, never the shared singleton: its accumulators carry state
     from a live run that has already seen later bars, and an accumulator cannot
     un-see a bar. Replaying through the shared one would silently carry the
     future into the past. */
  const resolver = new LevelResolver(source);

  const levelsFor = (asOf: number): Map<string, number | null> => {
    const out = new Map<string, number | null>();
    const groups = [plan.invalidation, ...plan.branches.map((b) => b.trigger)];
    for (const group of groups) {
      for (const level of extractRequiredLevels(group)) {
        const key = makeLevelKey(level);
        if (out.has(key)) continue;
        const r = resolver.resolve(level, { symbol: plan.pair, intervalMin, asOf });
        out.set(key, r.price);
        if (r.price === null) {
          const why = `${formatLevel(level)}: ${r.unavailableReason ?? "could not be resolved"}`;
          if (!seenProblem.has(why)) {
            seenProblem.add(why);
            problems.push(why);
          }
        }
      }
    }
    return out;
  };

  const stats = new Map<string, BranchDryRun>(
    plan.branches.map((b) => [
      b.id,
      { id: b.id, label: b.label, firedBars: 0, firstFireAt: null, unreachable: false, constant: false, overlappingBars: 0 },
    ])
  );

  let invalidationBars = 0;
  let invalidatedNow = false;

  for (let i = 1; i < window.length; i++) {
    const bar = window[i]!;
    const { current, previous } = barValues(window, i);
    const levels = levelsFor(bar.timestamp);
    const evaluate = (g: Parameters<typeof evaluateConditionGroup>[0]) =>
      evaluateConditionGroup(g, current, previous, levels);

    if (evaluate(plan.invalidation)) {
      invalidationBars++;
      if (i === window.length - 1) invalidatedNow = true;
    }

    /* Each branch's trigger is evaluated INDEPENDENTLY here, deliberately —
       `evaluatePlan` returns the first branch to fire and stops, which is
       correct live (OCO) but would hide an unreachable sibling behind a
       greedy one. Exclusivity is then measured from the raw truth. */
    let firedThisBar = 0;
    for (const b of plan.branches) {
      if (!evaluate(b.trigger)) continue;
      firedThisBar++;
      const st = stats.get(b.id)!;
      st.firedBars++;
      if (st.firstFireAt === null) st.firstFireAt = bar.timestamp;
    }
    if (firedThisBar > 1) {
      for (const b of plan.branches) {
        if (evaluate(b.trigger)) stats.get(b.id)!.overlappingBars++;
      }
    }
  }

  const examined = window.length - 1;
  const branches = [...stats.values()];
  for (const b of branches) {
    b.unreachable = b.firedBars === 0;
    b.constant = b.firedBars / examined > CONSTANT_SHARE;
  }

  /* Sanity-check the plan against the monitor itself on the final bar, so the
     dry run and the live monitor cannot disagree about the same instant. */
  const finalBar = window[window.length - 1]!;
  const { current, previous } = barValues(window);
  const finalLevels = levelsFor(finalBar.timestamp);
  const monitorSays = evaluatePlan(plan, {
    now: finalBar.timestamp,
    evaluate: (g) => evaluateConditionGroup(g, current, previous, finalLevels),
    resolve: (lv: PriceLevel) => {
      const r = resolver.resolve(lv, { symbol: plan.pair, intervalMin, asOf: finalBar.timestamp });
      return { price: r.price, drifted: r.drifted };
    },
  });
  for (const n of monitorSays.notices) if (!problems.includes(n)) problems.push(n);

  if (plan.expiresAt <= now) {
    notes.push("The expiry has already passed.");
  } else {
    const barsLeft = Math.floor((plan.expiresAt - now) / (intervalMin * 60_000));
    if (barsLeft < 3) {
      notes.push(`Only ${barsLeft} ${plan.evalInterval} bar${barsLeft === 1 ? "" : "s"} before it expires.`);
    }
  }

  const overlapping = branches.filter((b) => b.overlappingBars > 0);
  if (overlapping.length > 1 && !plan.ocoExclusive) {
    /* With OCO on, the monitor cancels the siblings and this is harmless. With
       it off, two branches true at once is a double-sized position. */
    notes.push("Branches were true at the same time and one-cancels-the-other is off — this would size twice.");
  }

  const fired = branches.filter((b) => b.firedBars > 0);
  const constant = branches.filter((b) => b.constant);

  let verdict: DryRunVerdict;
  let headline: string;
  if (invalidatedNow) {
    verdict = "already_over";
    headline = "The thesis invalidation is true right now — this plan would end the moment you armed it.";
  } else if (problems.length > 0 && fired.length === 0) {
    verdict = "cannot_evaluate";
    headline = "Some levels could not be resolved, so this plan cannot be judged yet.";
  } else if (constant.length === branches.length && branches.length > 0) {
    verdict = "fires_constantly";
    headline = `Every branch was true on most of the last ${examined} bars — this reads as a standing condition, not a scenario.`;
  } else if (fired.length === 0) {
    verdict = "never_fires";
    headline = `Nothing triggered across the last ${examined} ${plan.evalInterval} bars.`;
  } else {
    verdict = "fires";
    const names = fired.map((b) => `${b.label} (${b.firedBars}×)`).join(", ");
    headline = `Would have triggered on the last ${examined} bars: ${names}.`;
  }

  const unreachable = branches.filter((b) => b.unreachable);
  if (verdict === "fires" && unreachable.length > 0) {
    notes.push(
      `${unreachable.map((b) => b.label).join(", ")} never became true — check ${unreachable.length === 1 ? "it is" : "they are"} reachable from here.`
    );
  }

  return {
    verdict,
    headline,
    barsExamined: examined,
    from: window[1]?.timestamp ?? null,
    to: finalBar.timestamp,
    intervalMin,
    branches,
    invalidationBars,
    invalidatedNow,
    problems,
    notes,
  };
}
