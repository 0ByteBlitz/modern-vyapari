/**
 * The calibration record (roadmap S3-6) — statistics about the *planner*, never
 * about the plan.
 *
 * ## Why this is not the thing that was frozen
 *
 * A plan is a one-shot bet on a path, so statistical validation **of a plan**
 * is inapplicable: there is no sample. That is why the strategy path was cut
 * and why a plan is never backtested.
 *
 * But the *planner* repeats. The same person writes "range reclaim holds" forty
 * times across forty different plans, and whether that assumption tends to hold
 * is a real, answerable, accumulating question. §17's phrasing is the design:
 * **statistics move from the plan to the planner.** So everything here is
 * grouped by assumption **tag**, never by plan, and the unit of evidence is the
 * thesis type rather than the trade.
 *
 * With the strategy path gone, this is the only evidence record the app
 * accumulates at all.
 *
 * ## The three ways this number could lie, and what stops each
 *
 * 1. **Counting an unwatched window as "did not trigger".** A closed laptop
 *    watches nothing, and a plan that expired while the app was shut records
 *    identically to one that expired while being watched — in the *flattering*
 *    direction, since a thesis that never got its chance is not a thesis that
 *    failed. Plans whose armed→resolved window overlaps a monitor gap are
 *    counted separately and excluded from the rates.
 * 2. **A rate from four plans.** A percentage implies a stability three
 *    observations cannot have. Below `MIN_SAMPLE` the rates are `null` and the
 *    counts stand alone — the UI must show what is there, not a number shaped
 *    like an answer.
 * 3. **Counting plans that have not finished.** A `planned` plan has not had
 *    its chance yet; including it would drag every rate toward zero and make
 *    the record look worse the more actively it is being used.
 */

import { getDb } from "../db/database";
import { GAP_THRESHOLD_MS } from "../paper/monitor-heartbeat";
import type { PlanState } from "../../shared/ipc-types";

/**
 * Below this, report counts and withhold the rates.
 *
 * §17 puts a usable calibration record at "about 30 plans". Thirty per *tag* is
 * a long way off for a personal tool, so the threshold is lower and the honest
 * move is that the UI keeps saying the sample is thin rather than the number
 * quietly becoming trustworthy at some invisible point.
 */
export const MIN_SAMPLE = 8;

/** Plan states that have had their chance. `planned` has not. */
const RESOLVED: PlanState[] = ["triggered", "closed", "expired", "invalidated"];

export interface TagCalibration {
  /** The assumption tag, or null for plans whose assumptions carry none. */
  tag: string | null;
  /** Resolved plans carrying this tag, watched throughout. */
  resolved: number;
  /** Of those, how many had a branch fire. */
  triggered: number;
  /** Of those triggered, how many had the thesis disproved. */
  invalidatedAfterTrigger: number;
  /** Resolved without ever firing, and not because nobody was watching. */
  expiredUnfired: number;
  /** Positions closed at their target. */
  reachedTarget: number;
  /** Positions closed at their stop. */
  stoppedOut: number;
  /**
   * Share of the planned move actually captured, averaged over closed
   * positions: `(exit − entry) / (target − entry)`.
   *
   * **Not PnL.** It answers "when I say 130, how far do I usually get?", which
   * is a fact about the forecast rather than about the money.
   */
  capturedShare: number | null;
  /** Plans excluded because the app was not watching for part of their life. */
  unwatched: number;
  /** Null until `resolved >= MIN_SAMPLE`. A rate from four plans is a guess. */
  triggerRate: number | null;
  invalidationRate: number | null;
}

export interface CalibrationRecord {
  tags: TagCalibration[];
  /** Every tag folded together, same rules. */
  overall: TagCalibration;
  /** Plans that exist but have not resolved yet — context, not evidence. */
  stillOpen: number;
  minSample: number;
  /** True when nothing has resolved yet at all. */
  empty: boolean;
}

interface PlanRow {
  id: number;
  state: PlanState;
  assumptions_json: string;
  armed_at: number | null;
  closed_at: number | null;
  updated_at: number;
}

interface OutcomeRow {
  plan_id: number;
  branch_status: string;
  exit_reason: string | null;
  entry_price: string | null;
  exit_price: string | null;
  targets_json: string | null;
}

function emptyTag(tag: string | null): TagCalibration {
  return {
    tag,
    resolved: 0,
    triggered: 0,
    invalidatedAfterTrigger: 0,
    expiredUnfired: 0,
    reachedTarget: 0,
    stoppedOut: 0,
    capturedShare: null,
    unwatched: 0,
    triggerRate: null,
    invalidationRate: null,
  };
}

/** Windows during which nothing was watching, newest first. */
function watchGaps(): Array<{ from: number; to: number }> {
  /* `detail`, not `payload_json` — the wrong column name here would have thrown
     and been swallowed, reporting zero gaps and marking every plan as watched.
     That is the flattering direction, which is the one that has to be checked. */
  const rows = getDb()
    .prepare(`SELECT detail FROM audit_log WHERE action = 'monitor_gap' ORDER BY created_at DESC LIMIT 500`)
    .all() as Array<{ detail: string }>;

  const out: Array<{ from: number; to: number }> = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.detail) as { from?: number; to?: number; ms?: number };
      if (typeof p.from === "number" && typeof p.to === "number" && (p.ms ?? 0) >= GAP_THRESHOLD_MS) {
        out.push({ from: p.from, to: p.to });
      }
    } catch {
      /* A malformed audit row must not take the whole record down. */
    }
  }
  return out;
}

function tagsOf(assumptionsJson: string): Array<string | null> {
  try {
    const list = JSON.parse(assumptionsJson) as Array<{ tag?: string }>;
    const tags = list.map((a) => (a.tag && a.tag.trim() ? a.tag.trim() : null));
    /* A plan counts once per DISTINCT tag it carries. Counting it once per
       assumption would let a plan with three assumptions sharing one tag vote
       three times for that tag. */
    return [...new Set(tags)];
  } catch {
    return [null];
  }
}

export function buildCalibration(sessionId?: number): CalibrationRecord {
  const db = getDb();
  const where = sessionId !== undefined ? "WHERE session_id = ?" : "";
  const args = sessionId !== undefined ? [sessionId] : [];

  const plans = db
    .prepare(
      `SELECT id, state, assumptions_json, armed_at, closed_at, updated_at
       FROM trade_plans ${where}`
    )
    .all(...args) as unknown as PlanRow[];

  const resolvedPlans = plans.filter((p) => RESOLVED.includes(p.state));
  const stillOpen = plans.filter((p) => p.state === "planned").length;

  const outcomes = new Map<number, OutcomeRow[]>();
  if (resolvedPlans.length > 0) {
    const rows = db
      .prepare(
        `SELECT b.plan_id, b.status AS branch_status, b.targets_json,
                p.exit_reason, p.entry_price, p.exit_price
         FROM plan_branches b
         LEFT JOIN paper_positions p ON p.id = b.position_id
         WHERE b.plan_id IN (${resolvedPlans.map(() => "?").join(",")})`
      )
      .all(...resolvedPlans.map((p) => p.id)) as unknown as OutcomeRow[];
    for (const r of rows) outcomes.set(r.plan_id, [...(outcomes.get(r.plan_id) ?? []), r]);
  }

  const gaps = watchGaps();
  const buckets = new Map<string | null, TagCalibration>();
  const captured = new Map<string | null, number[]>();
  const overall = emptyTag(null);
  const overallCaptured: number[] = [];

  for (const plan of resolvedPlans) {
    const from = plan.armed_at ?? plan.updated_at;
    const to = plan.closed_at ?? plan.updated_at;
    /* Overlap, not containment: a gap in the middle of a plan's life is just as
       disqualifying as one covering all of it. */
    const wasUnwatched = gaps.some((g) => g.from < to && g.to > from);

    const rows = outcomes.get(plan.id) ?? [];
    const fired = rows.some((r) => r.branch_status === "triggered");
    const closed = rows.filter((r) => r.exit_reason !== null);
    const hitTarget = closed.some((r) => r.exit_reason === "take_profit");
    const stopped = closed.some((r) => r.exit_reason === "stop_loss");

    /* How far the move got, as a fraction of what the plan forecast. Only
       computable when the entry, the exit and a target are all real numbers. */
    let share: number | null = null;
    const withPrices = closed.find((r) => r.entry_price && r.exit_price && r.targets_json);
    if (withPrices) {
      try {
        const targets = (JSON.parse(withPrices.targets_json!) as Array<{ price?: number }>)
          .map((t) => t.price)
          .filter((n): n is number => typeof n === "number");
        const entry = parseFloat(withPrices.entry_price!);
        const exit = parseFloat(withPrices.exit_price!);
        const target = targets.length ? Math.min(...targets) : null;
        if (target !== null && Number.isFinite(entry) && Number.isFinite(exit) && target !== entry) {
          share = (exit - entry) / (target - entry);
        }
      } catch {
        /* A target we cannot read is not a captured share of zero. */
      }
    }

    for (const tag of tagsOf(plan.assumptions_json)) {
      const b = buckets.get(tag) ?? emptyTag(tag);
      buckets.set(tag, b);
      if (wasUnwatched) {
        b.unwatched++;
        continue;
      }
      b.resolved++;
      if (fired) b.triggered++;
      if (fired && plan.state === "invalidated") b.invalidatedAfterTrigger++;
      if (!fired && plan.state === "expired") b.expiredUnfired++;
      if (hitTarget) b.reachedTarget++;
      if (stopped) b.stoppedOut++;
      if (share !== null) captured.set(tag, [...(captured.get(tag) ?? []), share]);
    }

    if (wasUnwatched) {
      overall.unwatched++;
      continue;
    }
    overall.resolved++;
    if (fired) overall.triggered++;
    if (fired && plan.state === "invalidated") overall.invalidatedAfterTrigger++;
    if (!fired && plan.state === "expired") overall.expiredUnfired++;
    if (hitTarget) overall.reachedTarget++;
    if (stopped) overall.stoppedOut++;
    if (share !== null) overallCaptured.push(share);
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const finish = (b: TagCalibration, shares: number[]): TagCalibration => {
    b.capturedShare = mean(shares);
    /* The rates stay null below the threshold. Returning a number the caller
       may or may not choose to qualify is how "3 of 4 = 75%" ends up on a
       screen looking like a finding. */
    if (b.resolved >= MIN_SAMPLE) {
      b.triggerRate = b.triggered / b.resolved;
      b.invalidationRate = b.triggered > 0 ? b.invalidatedAfterTrigger / b.triggered : 0;
    }
    return b;
  };

  const tags = [...buckets.entries()]
    .map(([tag, b]) => finish(b, captured.get(tag) ?? []))
    .sort((a, b) => b.resolved - a.resolved || (a.tag ?? "").localeCompare(b.tag ?? ""));

  return {
    tags,
    overall: finish(overall, overallCaptured),
    stillOpen,
    minSample: MIN_SAMPLE,
    empty: resolvedPlans.length === 0,
  };
}
