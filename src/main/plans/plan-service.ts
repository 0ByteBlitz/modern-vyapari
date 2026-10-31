/**
 * Scenario-plan persistence and lifecycle (roadmap S3-1/S3-2).
 *
 * `trade-plan.ts` is the pure half — shape, transitions, and the falsifiability
 * gate. This is the half that touches the database and the clock.
 *
 * **The interesting operation is `armPlan`.** Everything else is CRUD. Arming
 * is the moment a plan stops being an idea:
 *
 *  1. the falsifiability gate must pass, with no bypass;
 *  2. every derived level must resolve to a real number **now**, which is what
 *     `resolvedAtArm` means — the baseline every later drift check measures
 *     against. A level that cannot be computed **refuses the arm** rather than
 *     being stored as 0 or NaN, because a fabricated baseline makes every
 *     subsequent drift answer fiction;
 *  3. only then does the state move `draft → planned`.
 *
 * Levels are stored as drafts (no `resolvedAtArm`) until this runs, so the
 * type system distinguishes "not armed yet" from "armed at some value".
 */

import { getDb, auditLog, withTransaction } from "../db/database";
import { compileIntent, type ConditionIntent } from "./condition-intent";
import { createLogger } from "../logger";
import { enqueueWithin, type NotificationDraft } from "../notify/outbox";
import { levelResolver } from "../insights/level-resolver";
import { extractRequiredLevels } from "../strategy/strategy-spec";
import type { ConditionGroup, EvalInterval } from "../strategy/strategy-spec";
import type { DerivedLevel, PriceLevel } from "../../shared/levels";
import type { PlanState } from "../../shared/ipc-types";
import type { LevelDraft } from "./level-reference";
import {
  validatePlan,
  canTransitionPlan,
  type PlanAssumption,
  type PlanRiskBudget,
  type TradePlan,
} from "./trade-plan";

const log = createLogger("plans");

const INTERVAL_MINUTES: Record<EvalInterval, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

/* ── Row shapes ─────────────────────────────────────────────────────── */

interface PlanRow {
  id: number;
  session_id: number;
  slug: string;
  pair: string;
  thesis: string;
  assumptions_json: string;
  invalidation_json: string;
  expires_at: number;
  risk_json: string;
  oco_exclusive: number;
  eval_interval: string;
  state: PlanState;
  notes: string | null;
  armed_at: number | null;
  outcome_reason: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface BranchRow {
  id: number;
  plan_id: number;
  slug: string;
  label: string;
  trigger_json: string;
  entry_json: string;
  stop_json: string;
  targets_json: string;
  budget_share_pct: number;
  status: string;
  triggered_at: number | null;
  position_id: number | null;
  trigger_levels_json: string | null;
}

/** A plan as it is worked on: levels may still be drafts (pre-arm). */
export interface StoredPlan extends Omit<TradePlan, "id" | "branches"> {
  rowId: number;
  slug: string;
  state: PlanState;
  armedAt: number | null;
  outcomeReason: string | null;
  branches: StoredBranch[];
}

export interface StoredBranch {
  rowId: number;
  id: string;
  label: string;
  trigger: ConditionGroup;
  entry: LevelDraft;
  stop: LevelDraft;
  targets: LevelDraft[];
  budgetSharePct: number;
  status: string;
  triggeredAt: number | null;
  positionId: number | null;
}

function hydrate(row: PlanRow, branches: BranchRow[]): StoredPlan {
  return {
    rowId: row.id,
    slug: row.slug,
    sessionId: row.session_id,
    pair: row.pair,
    thesis: row.thesis,
    assumptions: JSON.parse(row.assumptions_json) as PlanAssumption[],
    invalidation: JSON.parse(row.invalidation_json) as ConditionGroup,
    expiresAt: row.expires_at,
    risk: JSON.parse(row.risk_json) as PlanRiskBudget,
    ocoExclusive: row.oco_exclusive === 1,
    evalInterval: row.eval_interval as EvalInterval,
    state: row.state,
    armedAt: row.armed_at,
    outcomeReason: row.outcome_reason,
    notes: row.notes ?? undefined,
    branches: branches.map((b) => ({
      rowId: b.id,
      id: b.slug,
      label: b.label,
      trigger: JSON.parse(b.trigger_json) as ConditionGroup,
      entry: JSON.parse(b.entry_json) as LevelDraft,
      stop: JSON.parse(b.stop_json) as LevelDraft,
      targets: JSON.parse(b.targets_json) as LevelDraft[],
      budgetSharePct: b.budget_share_pct,
      status: b.status,
      triggeredAt: b.triggered_at,
      positionId: b.position_id,
    })),
  };
}

/* ── Read ───────────────────────────────────────────────────────────── */

export function listPlans(sessionId: number, states?: PlanState[]): StoredPlan[] {
  const db = getDb();
  const filter = states?.length ? ` AND state IN (${states.map(() => "?").join(",")})` : "";
  const rows = db
    .prepare(`SELECT * FROM trade_plans WHERE session_id = ?${filter} ORDER BY created_at DESC`)
    .all(sessionId, ...(states ?? [])) as unknown as PlanRow[];

  const branchStmt = db.prepare(`SELECT * FROM plan_branches WHERE plan_id = ? ORDER BY id ASC`);
  return rows.map((r) => hydrate(r, branchStmt.all(r.id) as unknown as BranchRow[]));
}

/**
 * Every plan the monitor should be watching, across all sessions.
 *
 * `triggered` is included deliberately: a thesis can be disproved while its
 * position is green, so a plan does not stop being watched the moment it fires.
 * A "only watch un-triggered plans" filter would miss exactly that case.
 *
 * Archived sessions are excluded — their strategies never load either, and a
 * plan that could still fire on a wound-down session is the same hazard.
 */
/** Hot-reload the paper engine's watch list. Swallows failure: the engine may
 *  not be running (tests, or before `start`), and that is not an arming error. */
function reloadPaperEngine(): void {
  try {
    const { paperEngine } = require("../paper/paper-exchange");
    paperEngine.reloadStrategies();
  } catch (e) {
    log.warn("Could not reload paper engine:", e);
  }
}

export function listWatchedPlans(): StoredPlan[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.* FROM trade_plans p
         JOIN sessions s ON s.id = p.session_id
        WHERE p.state IN ('planned', 'triggered') AND s.status != 'archived'
        ORDER BY p.id ASC`
    )
    .all() as unknown as PlanRow[];
  const branchStmt = db.prepare(`SELECT * FROM plan_branches WHERE plan_id = ? ORDER BY id ASC`);
  return rows.map((r) => hydrate(r, branchStmt.all(r.id) as unknown as BranchRow[]));
}

/**
 * Record that a branch fired, and cancel its OCO siblings.
 *
 * `positionId` is null while plan execution is not wired (S3-3's applying
 * half). That is a real state, not a placeholder: the branch genuinely fired
 * and genuinely opened nothing, and the UI says so. Recording it anyway is what
 * lets the calibration record (S3-6) measure trigger rate before a single
 * position has ever been opened.
 */
export function recordBranchTrigger(
  planId: number,
  branchSlug: string,
  cancelledSlugs: string[],
  now: number,
  positionId: number | null = null,
  /* Same transaction as the trigger itself — see `transitionPlan`. */
  notify?: NotificationDraft
): void {
  withTransaction((db) => {
    db.prepare(
      `UPDATE plan_branches SET status = 'triggered', triggered_at = ?, position_id = ?
        WHERE plan_id = ? AND slug = ?`
    ).run(now, positionId, planId, branchSlug);
    for (const slug of cancelledSlugs) {
      db.prepare(
        `UPDATE plan_branches SET status = 'cancelled_oco' WHERE plan_id = ? AND slug = ?`
      ).run(planId, slug);
    }
    if (notify) enqueueWithin(db, notify);
  });
}

export function getPlan(rowId: number): StoredPlan | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM trade_plans WHERE id = ?`).get(rowId) as unknown as
    | PlanRow
    | undefined;
  if (!row) return null;
  const branches = db
    .prepare(`SELECT * FROM plan_branches WHERE plan_id = ? ORDER BY id ASC`)
    .all(rowId) as unknown as BranchRow[];
  return hydrate(row, branches);
}

/* ── Write ──────────────────────────────────────────────────────────── */

export interface PlanInput {
  sessionId: number;
  slug: string;
  pair: string;
  thesis: string;
  assumptions: PlanAssumption[];
  /** Where the THESIS is wrong, as an authored intent. Compiled here — the
   *  renderer describes a condition, main constructs one. */
  invalidation: ConditionIntent;
  expiresAt: number;
  risk: PlanRiskBudget;
  ocoExclusive?: boolean;
  evalInterval?: EvalInterval;
  notes?: string;
  branches: Array<{
    id: string;
    label: string;
    trigger: ConditionIntent;
    entry: LevelDraft;
    stop: LevelDraft;
    targets: LevelDraft[];
    budgetSharePct: number;
  }>;
}

/**
 * Create a plan in `draft`.
 *
 * Deliberately does NOT run the falsifiability gate: a draft is where you think,
 * and refusing to save an incomplete thought would just push authoring back into
 * a text file. The gate runs at `armPlan`, which is where it matters.
 */
export type CreateResult = { ok: true; plan: StoredPlan } | { ok: false; reason: string };

/**
 * Compile every authored intent, or say which one failed.
 *
 * Done up front so a malformed condition is refused rather than stored as an
 * empty `ConditionGroup` — which `validatePlan` would later read as a *missing*
 * invalidation, surfacing the mistake three steps away from its cause.
 */
function compileAll(input: PlanInput):
  | { ok: true; invalidation: ConditionGroup; triggers: Map<string, ConditionGroup> }
  | { ok: false; reason: string } {
  const inv = compileIntent(input.invalidation);
  if (!inv.ok) return { ok: false, reason: `Thesis invalidation: ${inv.reason}` };

  const triggers = new Map<string, ConditionGroup>();
  for (const b of input.branches ?? []) {
    const t = compileIntent(b.trigger);
    if (!t.ok) return { ok: false, reason: `${b.label || b.id}: ${t.reason}` };
    triggers.set(b.id, t.group);
  }
  return { ok: true, invalidation: inv.group, triggers };
}

/**
 * Is this name already used in this session?
 *
 * `idx_plans_slug` is UNIQUE over `(session_id, slug)` with **no state filter**,
 * deliberately: an expired or invalidated plan keeps its name forever, because
 * the name is how the calibration record refers to that thesis. So the answer
 * here is "taken", not "taken by something still running".
 */
function nameTaken(sessionId: number, slug: string): PlanState | null {
  const row = getDb()
    .prepare(`SELECT state FROM trade_plans WHERE session_id = ? AND slug = ?`)
    .get(sessionId, slug) as { state: PlanState } | undefined;
  return row?.state ?? null;
}

export function createPlan(input: PlanInput): CreateResult {
  const now = Date.now();
  const compiled = compileAll(input);
  if (!compiled.ok) return compiled;

  /* Refuse a duplicate name rather than letting the UNIQUE index raise.
     Two reasons this is a refusal and not an auto-rename:

     1. Without it the raw SQLite error escaped `safe()` and reached the owner
        as "couldn't read or write local data" — a storage failure, for what is
        actually "you already have a plan called this". Found by the first UI
        test run (§2.8); the error was three steps from its cause, which is the
        same shape as an empty ConditionGroup surfacing as a missing
        invalidation.
     2. Silently uniquifying to `range-break-2` would mean the plan the owner
        sees is not the plan they named — and the name is the key the
        calibration record groups a thesis by. */
  const taken = nameTaken(input.sessionId, input.slug);
  if (taken) {
    /* Finished plans keep their names — they are the record — so the name does
       not free up when a plan expires. Worth saying, briefly. */
    const held = taken === "draft" || taken === "planned" || taken === "triggered" ? "" : ` (${taken})`;
    return {
      ok: false,
      reason: `This session already has a plan called "${input.slug}"${held}. Pick another name.`,
    };
  }

  /* One transaction: a plan whose branches failed to write is a plan with no
     paths, which would still list and still offer an Arm button. */
  const planId = withTransaction((db) => {
  const res = db
    .prepare(
      `INSERT INTO trade_plans
         (session_id, slug, pair, thesis, assumptions_json, invalidation_json, expires_at,
          risk_json, oco_exclusive, eval_interval, state, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
    )
    .run(
      input.sessionId,
      input.slug,
      input.pair,
      input.thesis,
      JSON.stringify(input.assumptions ?? []),
      JSON.stringify(compiled.invalidation),
      input.expiresAt,
      JSON.stringify(input.risk ?? {}),
      input.ocoExclusive === false ? 0 : 1,
      input.evalInterval ?? "4h",
      input.notes ?? null,
      now,
      now
    );

    const id = Number(res.lastInsertRowid);
    replaceBranches(id, input.branches ?? [], compiled.triggers);
    return id;
  });

  auditLog("plan_created", { planId, slug: input.slug, pair: input.pair });
  return { ok: true, plan: getPlan(planId)! };
}

function replaceBranches(
  planId: number,
  branches: PlanInput["branches"],
  triggers: Map<string, ConditionGroup>
): void {
  const db = getDb();
  db.prepare(`DELETE FROM plan_branches WHERE plan_id = ?`).run(planId);
  const stmt = db.prepare(
    `INSERT INTO plan_branches
       (plan_id, slug, label, trigger_json, entry_json, stop_json, targets_json, budget_share_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const b of branches) {
    stmt.run(
      planId,
      b.id,
      b.label,
      JSON.stringify(triggers.get(b.id) ?? { logic: "and", conditions: [] }),
      JSON.stringify(b.entry),
      JSON.stringify(b.stop),
      JSON.stringify(b.targets ?? []),
      b.budgetSharePct
    );
  }
}

/**
 * Edit a plan. **Drafts only** — an armed plan is a commitment, and quietly
 * rewriting one would mean the plan that fires is not the plan that was
 * approved. Re-authoring an armed plan means invalidating it and writing a new
 * one, which is deliberate friction.
 */
export function updatePlan(rowId: number, input: PlanInput): { ok: true } | { ok: false; reason: string } {
  const existing = getPlan(rowId);
  if (!existing) return { ok: false, reason: "That plan no longer exists." };
  if (existing.state !== "draft") {
    /* Editing an armed plan would mean the plan that fires is not the plan that
       was approved. Re-authoring means invalidating and writing a new one. */
    return {
      ok: false,
      reason: `A ${existing.state} plan can't be edited. Invalidate it and write a new one.`,
    };
  }

  const compiled = compileAll(input);
  if (!compiled.ok) return compiled;

  withTransaction((db) => {
    db
    .prepare(
      `UPDATE trade_plans SET pair=?, thesis=?, assumptions_json=?, invalidation_json=?,
              expires_at=?, risk_json=?, oco_exclusive=?, eval_interval=?, notes=?, updated_at=?
        WHERE id=?`
    )
    .run(
      input.pair,
      input.thesis,
      JSON.stringify(input.assumptions ?? []),
      JSON.stringify(compiled.invalidation),
      input.expiresAt,
      JSON.stringify(input.risk ?? {}),
      input.ocoExclusive === false ? 0 : 1,
      input.evalInterval ?? "4h",
      input.notes ?? null,
      Date.now(),
      rowId
    );
    /* replaceBranches DELETEs then re-INSERTs. Unwrapped, a failure between the
       two leaves a plan with no branches at all — the edit silently destroying
       what it was meant to change. */
    replaceBranches(rowId, input.branches ?? [], compiled.triggers);
  });
  return { ok: true };
}

/** Delete a draft. Armed and terminal plans are kept — they are the record. */
export function deletePlan(rowId: number): { ok: true } | { ok: false; reason: string } {
  const existing = getPlan(rowId);
  if (!existing) return { ok: false, reason: "That plan no longer exists." };
  if (existing.state !== "draft") {
    /* Deleting one would erase evidence about how the owner's theses resolve —
       the only record a plans-only product accumulates, and specifically the
       DENOMINATOR of the trigger rate. Delete the plans that never fired and
       the rate counts only the ones that did, so it rises with nothing that
       would notice. Finished plans move to their own tab instead. */
    return {
      ok: false,
      reason: `This plan is ${existing.state} and part of your record. Find it under Finished.`,
    };
  }
  withTransaction((db) => {
    db.prepare(`DELETE FROM plan_branches WHERE plan_id = ?`).run(rowId);
    db.prepare(`DELETE FROM trade_plans WHERE id = ?`).run(rowId);
  });
  return { ok: true };
}

/* ── Arming ─────────────────────────────────────────────────────────── */

export interface ArmResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** What each derived level resolved to, for the confirmation diff (S3-2). */
  resolved: Array<{ where: string; label: string; price: number }>;
}

function isDraftDerived(level: LevelDraft): level is Omit<DerivedLevel, "resolvedAtArm"> {
  return level.kind === "derived";
}

/**
 * Arm a draft: gate, resolve, then transition.
 *
 * Returns the resolved values so the UI can show the trader the concrete
 * numbers *before* it commits — "VAH resolves to 71,842 right now" is the
 * difference between approving a thesis and approving a geometry.
 */
export function armPlan(rowId: number, now: number = Date.now()): ArmResult {
  const plan = getPlan(rowId);
  if (!plan) return { ok: false, errors: ["That plan no longer exists."], warnings: [], resolved: [] };

  if (!canTransitionPlan(plan.state, "planned")) {
    return {
      ok: false,
      errors: [`A ${plan.state} plan cannot be armed.`],
      warnings: [],
      resolved: [],
    };
  }

  /* 1. The gate. Levels are drafts here; validatePlan only inspects structure
        and drift guards, both of which are present pre-arm. */
  const asPlan = { ...plan, id: plan.slug, branches: plan.branches } as unknown as TradePlan;
  const gate = validatePlan(asPlan, now);
  if (!gate.valid) return { ok: false, errors: gate.errors, warnings: gate.warnings, resolved: [] };

  /* 2. Resolve every derived level to a number NOW. */
  const intervalMin = INTERVAL_MINUTES[plan.evalInterval] ?? 240;
  const ctx = { symbol: plan.pair, intervalMin, asOf: now };
  const errors: string[] = [];
  const resolved: ArmResult["resolved"] = [];

  const armLevel = (level: LevelDraft, where: string): LevelDraft => {
    if (!isDraftDerived(level)) return level;
    const r = levelResolver.resolveAtArm(level, ctx);
    if (r.price === null) {
      errors.push(
        `${where}: ${r.unavailableReason ?? "level could not be resolved"}. ` +
          "A plan cannot arm against a level nobody can compute — it would evaluate false forever " +
          "while looking armed."
      );
      return level;
    }
    resolved.push({ where, label: String(level.field ?? level.source), price: r.price });
    return { ...level, resolvedAtArm: r.price } as PriceLevel;
  };

  const armedBranches = plan.branches.map((b) => ({
    ...b,
    entry: armLevel(b.entry, `${b.label} entry`),
    stop: armLevel(b.stop, `${b.label} stop`),
    targets: b.targets.map((t, i) => armLevel(t, `${b.label} target ${i + 1}`)),
  }));

  /* Levels inside the thesis invalidation need arming too — it is the condition
     most likely to be written against a developing level, and the one whose
     drift matters most. */
  for (const lv of extractRequiredLevels(plan.invalidation)) {
    if (lv.kind !== "derived") continue;
    const r = levelResolver.resolveAtArm(lv, ctx);
    if (r.price === null) {
      errors.push(`Thesis invalidation: ${r.unavailableReason ?? "level could not be resolved"}.`);
    } else {
      resolved.push({ where: "invalidation", label: String(lv.field ?? lv.source), price: r.price });
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings: gate.warnings, resolved };

  /* 3. Commit: write the armed levels back, then move the state. */
  /* The armed levels and the state flip are one fact. Half of it — levels
     written, state still draft, or worse the reverse — would mean a plan armed
     against values nobody recorded. */
  withTransaction((db) => {
    const stmt = db.prepare(
      `UPDATE plan_branches SET entry_json=?, stop_json=?, targets_json=? WHERE id=?`
    );
    for (const b of armedBranches) {
      stmt.run(JSON.stringify(b.entry), JSON.stringify(b.stop), JSON.stringify(b.targets), b.rowId);
    }
    db.prepare(`UPDATE trade_plans SET state='planned', armed_at=?, updated_at=? WHERE id=?`).run(
      now,
      now,
      rowId
    );
  });

  auditLog("plan_armed", {
    planId: rowId,
    slug: plan.slug,
    pair: plan.pair,
    expiresAt: plan.expiresAt,
    resolvedLevels: resolved,
  });
  log.info(`Plan ${plan.slug} armed on ${plan.pair} (${resolved.length} derived levels resolved).`);

  /* Tell the engine, or the plan is armed in the database and unwatched in the
     running process until the next restart — which is exactly the "armed but
     nothing is looking at it" state this wiring exists to remove. `require` at
     call time for the same reason `strategy-service` does it: the engine
     imports this module, and a top-level import would be a cycle. */
  reloadPaperEngine();

  return { ok: true, errors: [], warnings: gate.warnings, resolved };
}

/**
 * Move a plan to a new state, refusing anything the transition table forbids.
 *
 * `reason` is required for terminal states, because the calibration record's
 * value depends on knowing *why* a plan ended — "never fired" and "fired and was
 * wrong" are the distinction the whole thing exists to measure.
 */
export function transitionPlan(
  rowId: number,
  to: PlanState,
  reason?: string,
  /* Written in the SAME transaction as the state change. That is the whole
     outbox guarantee: a plan cannot transition without the message being owed,
     and the message cannot exist without the transition having happened. */
  notify?: NotificationDraft
): { ok: true } | { ok: false; reason: string } {
  const plan = getPlan(rowId);
  if (!plan) return { ok: false, reason: "That plan no longer exists." };
  if (!canTransitionPlan(plan.state, to)) {
    return { ok: false, reason: `A ${plan.state} plan cannot become ${to}.` };
  }

  const now = Date.now();
  const terminal = to === "closed" || to === "expired" || to === "invalidated";

  /* One transaction so the state change and the message it owes commit
     together. Without this the process can die between them and the owner is
     never told a plan they armed was invalidated. */
  withTransaction((db) => {
    db.prepare(`UPDATE trade_plans SET state=?, outcome_reason=?, closed_at=?, updated_at=? WHERE id=?`)
      .run(to, reason ?? plan.outcomeReason ?? null, terminal ? now : plan.armedAt, now, rowId);
    if (notify) enqueueWithin(db, notify);
  });

  auditLog("plan_state_changed", { planId: rowId, slug: plan.slug, from: plan.state, to, reason });
  return { ok: true };
}
