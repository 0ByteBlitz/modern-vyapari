/**
 * Strategy CRUD + lifecycle management.
 * Persists strategies to the `strategies` table with versioning and state transitions.
 */

import { getDb, auditLog } from "../db/database";
import type { StrategySpec, StrategyState } from "./strategy-spec";
import { validateSpec, isValidTransition, VALID_STRATEGY_STATES, extractRequiredLevels } from "./strategy-spec";
import { formatLevel } from "../../shared/levels";
import { isResolvableSource } from "../insights/level-resolver";
import type { StrategyRow } from "../../shared/ipc-types";
import { createLogger } from "../logger";
import { AppError } from "../../shared/errors";

const log = createLogger("strategy");

// Shape lives in the shared IPC contract so main and renderer cannot drift.
export type { StrategyRow };

/* ── Row shape ──────────────────────────────────────────────────────── */


/* ── Create ─────────────────────────────────────────────────────────── */

/**
 * Create a new strategy for a session. Validates the spec before persisting.
 * Returns the newly created strategy row.
 */
export function createStrategy(
  sessionId: number,
  name: string,
  spec: StrategySpec,
  description?: string
): StrategyRow {
  // Validate the spec
  const errors = validateSpec(spec);
  if (errors.length > 0) {
    throw new Error(`Invalid strategy spec:\n${errors.join("\n")}`);
  }

  const db = getDb();
  const now = Date.now();

  // Option 3: If an un-backtested draft with the same name exists, update it in-place to prevent draft clutter
  const existingUnbacktestedDraft = db
    .prepare(
      `SELECT id FROM strategies
       WHERE session_id = ? AND name = ? AND state = 'draft' AND backtest_count = 0
       ORDER BY version DESC LIMIT 1`
    )
    .get(sessionId, name) as { id: number } | undefined;

  if (existingUnbacktestedDraft) {
    db.prepare(
      `UPDATE strategies SET spec_json = ?, description = ? WHERE id = ?`
    ).run(JSON.stringify(spec), description || spec.description || "", existingUnbacktestedDraft.id);
    return getStrategy(existingUnbacktestedDraft.id)!;
  }

  // Check for existing strategy with this name — auto-increment version
  const existing = db
    .prepare(
      `SELECT MAX(version) AS maxVer FROM strategies
       WHERE session_id = ? AND name = ?`
    )
    .get(sessionId, name) as { maxVer: number | null } | undefined;

  const version = (existing?.maxVer ?? 0) + 1;

  const result = db
    .prepare(
      `INSERT INTO strategies (session_id, name, version, spec_json, state, description, backtest_count, last_evaluated_at, created_at)
       VALUES (?, ?, ?, ?, 'draft', ?, 0, NULL, ?)`
    )
    .run(sessionId, name, version, JSON.stringify(spec), description || spec.description || "", now);

  auditLog("strategy_created", {
    sessionId,
    strategyId: result.lastInsertRowid,
    name,
    version,
    specId: spec.id,
  });

  return getStrategy(Number(result.lastInsertRowid))!;
}

/**
 * Delete a strategy and everything that only exists because of it.
 *
 * This used to delete `backtests` then `strategies` and stop there — but
 * `orders.strategy_id`, `journal.ref_strategy_id` and
 * `paper_positions.strategy_id` are all foreign keys into `strategies`, and
 * the DB runs with `PRAGMA foreign_keys = ON`. So the moment a strategy had
 * journalled a note or opened a paper position, the DELETE raised
 * "FOREIGN KEY constraint failed", the renderer discarded the error, and the
 * strategy silently stayed in the list — the delete looked like a no-op.
 *
 * Rules now:
 *   • Traded strategies are NOT deletable. Their closed positions are the
 *     realised-PnL history the portfolio and review agent are built on;
 *     deleting them would quietly rewrite past performance. Retire instead.
 *   • Anything the strategy authored that belongs to the session's permanent
 *     record (journal entries, order rows) is kept and simply unlinked.
 *   • Backtests are the strategy's own working output and go with it.
 */
export function deleteStrategy(strategyId: number): void {
  const db = getDb();

  const strategy = getStrategy(strategyId);
  if (!strategy) throw new AppError("NOT_FOUND", "That strategy has already been deleted.");

  const positions = db
    .prepare("SELECT COUNT(*) AS n, SUM(status = 'open') AS open FROM paper_positions WHERE strategy_id = ?")
    .get(strategyId) as { n: number; open: number | null } | undefined;

  if (positions && positions.open) {
    throw new AppError(
      "VALIDATION",
      "This strategy is holding an open paper position, so it can't be deleted.",
      { hint: "Wait for the position to close, or retire the strategy to stop it opening new ones." }
    );
  }
  if (positions && positions.n > 0) {
    throw new AppError(
      "VALIDATION",
      `This strategy has ${positions.n} recorded paper ${positions.n === 1 ? "trade" : "trades"}, so it can't be deleted.`,
      { hint: "Retire it instead — deleting it would change your recorded results." }
    );
  }

  db.exec("BEGIN TRANSACTION;");
  try {
    db.prepare("DELETE FROM backtests WHERE strategy_id = ?").run(strategyId);
    // Keep the writing, drop the link: the journal is the durable record.
    db.prepare("UPDATE journal SET ref_strategy_id = NULL WHERE ref_strategy_id = ?").run(strategyId);
    db.prepare("UPDATE orders SET strategy_id = NULL WHERE strategy_id = ?").run(strategyId);
    db.prepare("DELETE FROM strategies WHERE id = ?").run(strategyId);
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    log.error(`Failed to delete strategy ${strategyId}`, err);
    throw err;
  }

  auditLog("strategy_deleted", { strategyId, sessionId: strategy.session_id, name: strategy.name });

  // A deleted armed strategy must also leave the running engine, or it keeps
  // evaluating candles against a spec that no longer exists in the DB.
  if (strategy.state === "paper") {
    try {
      const { paperEngine } = require("../paper/paper-exchange");
      paperEngine.reloadStrategies();
    } catch (e) {
      log.warn("Could not reload paper engine after delete:", e);
    }
  }
}

/* ── Read ───────────────────────────────────────────────────────────── */

/** Get a single strategy by DB id. */
export function getStrategy(id: number): StrategyRow | null {
  const row = getDb()
    .prepare("SELECT * FROM strategies WHERE id = ?")
    .get(id) as unknown as StrategyRow | undefined;
  return row ?? null;
}

/** List all strategies for a session, newest first. */
export function listStrategies(sessionId: number): StrategyRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM strategies
       WHERE session_id = ?
       ORDER BY created_at DESC`
    )
    .all(sessionId) as unknown as StrategyRow[];
}

/** List strategies in active states (paper or live — not draft/backtested/retired). */
export function getActiveStrategies(sessionId: number): StrategyRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM strategies
       WHERE session_id = ? AND state IN ('paper', 'live_supervised', 'live_auto')
       ORDER BY created_at DESC`
    )
    .all(sessionId) as unknown as StrategyRow[];
}

/** Get all paper strategies across all sessions (used by the Paper Exchange engine). */
export function getAllPaperStrategies(): StrategyRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM strategies
       WHERE state = 'paper'
       ORDER BY session_id, created_at DESC`
    )
    .all() as unknown as StrategyRow[];
}

/** Get the latest version of a named strategy within a session. */
export function getLatestVersion(sessionId: number, name: string): StrategyRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM strategies
       WHERE session_id = ? AND name = ?
       ORDER BY version DESC
       LIMIT 1`
    )
    .get(sessionId, name) as unknown as StrategyRow | undefined;
  return row ?? null;
}

/* ── Update ─────────────────────────────────────────────────────────── */

/**
 * Update a strategy's spec. Creates a NEW VERSION at DRAFT state.
 * The old version remains unchanged (historical record).
 */
export function updateStrategy(
  strategyId: number,
  newSpec: StrategySpec,
  description?: string
): StrategyRow {
  const existing = getStrategy(strategyId);
  if (!existing) throw new Error(`Strategy ${strategyId} not found`);

  return createStrategy(
    existing.session_id,
    existing.name,
    newSpec,
    description || newSpec.description
  );
}

/**
 * Transition a strategy to a new lifecycle state.
 * Enforces the valid transition rules from strategy-spec.ts.
 */
/** Derived price levels a spec references whose SOURCE the resolver cannot
 *  compute yet — Ichimoku (S2-4) and Fibonacci (S2-1). Everything the resolver
 *  handles is armable; these would evaluate false forever. */
function unresolvableLevelsInSpec(specJson: string): string[] {
  try {
    const spec = JSON.parse(specJson) as StrategySpec;
    return [...extractRequiredLevels(spec.entry), ...extractRequiredLevels(spec.exit)]
      .filter((l) => l.kind === "derived" && !isResolvableSource(l.source))
      .map((l) => formatLevel(l));
  } catch {
    return [];
  }
}

export function setStrategyState(strategyId: number, newState: StrategyState): StrategyRow {
  if (!VALID_STRATEGY_STATES.includes(newState)) {
    throw new Error(`Invalid strategy state: ${newState}`);
  }

  const existing = getStrategy(strategyId);
  if (!existing) throw new Error(`Strategy ${strategyId} not found`);

  if (!isValidTransition(existing.state, newState)) {
    throw new Error(
      `Cannot transition from "${existing.state}" to "${newState}". ` +
      `Valid transitions: ${["(none)"].concat([] as string[]).join(", ") || "(none)"}`
    );
  }

  /* Arming is the one transition that can bring a dormant session back to
     life. The paper engine already refuses to enter on a non-active session,
     but a strategy sitting in `paper` state on an archived session reads as
     "armed" everywhere in the UI while being incapable of trading — a lie in
     the direction that matters. Refuse it at the source. */
  if (newState === "paper") {
    const { getSessionById } = require("../sessions/service") as typeof import("../sessions/service");
    const session = getSessionById(existing.session_id);
    if (session && session.status !== "active") {
      throw new AppError(
        "VALIDATION",
        `This session is ${session.status}, so its strategies can't be armed.`,
        { hint: session.status === "paused" ? "Resume the session first." : "Restore the session first." }
      );
    }

    /* Derived `PriceLevel` thresholds (plan §17.6) are expressible in a spec
       before every source can be resolved. An unresolvable threshold evaluates
       to FALSE by design — fail closed — which is right for safety but would
       make an armed strategy sit there looking active and never trade. A
       silently dead strategy is the exact failure mode this codebase keeps
       finding; refuse the arm instead of shipping the silence.
       Narrowed on 2026-07-30: the paper engine now resolves VWAP, AVWAP,
       volume profile and CVD per bar (S1-1), so only Ichimoku and Fib are
       still refused. Delete the rest of this when S2-1 and S2-4 land. */
    const levels = unresolvableLevelsInSpec(existing.spec_json);
    if (levels.length > 0) {
      throw new AppError(
        "VALIDATION",
        `This strategy uses ${levels.length} price ${levels.length === 1 ? "level" : "levels"} ` +
          `(${levels.join(", ")}) whose source the engine can't compute yet.`,
        { hint: "Use a VWAP, volume profile, CVD or a fixed price instead." }
      );
    }
  }

  getDb()
    .prepare("UPDATE strategies SET state = ? WHERE id = ?")
    .run(newState, strategyId);

  auditLog("strategy_state_changed", {
    strategyId,
    from: existing.state,
    to: newState,
  });

  // Phase 3: hot-reload paper engine if a strategy enters or exits 'paper' state
  if (existing.state === "paper" || newState === "paper") {
    try {
      const { paperEngine } = require("../paper/paper-exchange");
      paperEngine.reloadStrategies();
    } catch (e) {
      log.warn("Could not reload paper engine:", e);
    }
  }

  return getStrategy(strategyId)!;
}

/** Increment the backtest count for a strategy (called after a backtest completes). */
export function incrementBacktestCount(strategyId: number): void {
  getDb()
    .prepare("UPDATE strategies SET backtest_count = backtest_count + 1 WHERE id = ?")
    .run(strategyId);
}

/** Update the last_evaluated_at timestamp. */
export function touchLastEvaluated(strategyId: number): void {
  getDb()
    .prepare("UPDATE strategies SET last_evaluated_at = ? WHERE id = ?")
    .run(Date.now(), strategyId);
}
