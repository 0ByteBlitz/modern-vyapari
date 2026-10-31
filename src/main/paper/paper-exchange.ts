/**
 * Paper exchange — the backtester's fill model running against *live* data.
 *
 * Design contract (plan §10): a strategy is promoted to live by swapping the
 * engine pointer, so this must behave identically to `backtester.simulate()`
 * given the same candles. That means, specifically:
 *
 *   1. Signals evaluate ONLY on CLOSED candles. Evaluating the forming candle
 *      lets a condition flip true then false within one bar — the backtester
 *      never sees that, so paper results would not be comparable (and the
 *      engine could open and immediately close a position on noise).
 *   2. Fees and slippage come from DEFAULT_BACKTEST_CONFIG, not local
 *      constants, so the two engines can never silently drift apart.
 *   3. Stop-loss / take-profit are checked intrabar against high/low on every
 *      tick (protective levels must NOT wait for the bar to close — a real
 *      venue-side TP/SL wouldn't), filling at the stop/target price, matching
 *      the backtester's treatment.
 *
 * Position state lives in `paper_positions` (schema v6) rather than being
 * inferred by replaying the whole order log.
 *
 * No AI call is anywhere in this path (plan hard rule: AI proposes, code
 * executes). The post-trade review agent is invoked strictly *after* a
 * position has already closed, and cannot influence execution.
 */
import { getDb, auditLog, withTransaction } from "../db/database";
import { getAllPaperStrategies, StrategyRow } from "../strategy/strategy-service";
import {
  listWatchedPlans,
  recordBranchTrigger,
  transitionPlan,
  type StoredPlan,
} from "../plans/plan-service";
import { evaluatePlan } from "../plans/plan-monitor";
import { getSessionById, Session } from "../sessions/service";
import { getPaperBalance, setPaperBalance, canFund } from "./account";
import { binanceWS } from "../data/binance-ws";
import { computeFromCandles } from "../insights/indicators";
import type { CandleNumeric } from "../insights/indicator-types";
import { makeIndicatorKey } from "../insights/indicator-types";
import { barValues } from "../insights/bar-values";
import {
  evaluateConditionGroup,
  extractRequiredIndicators,
  extractRequiredLevels,
  makeLevelKey,
  StrategySpec,
  SizingConfig,
} from "../strategy/strategy-spec";
import { levelResolver } from "../insights/level-resolver";
import { formatLevel } from "../../shared/levels";
import type { PriceLevel } from "../../shared/levels";
import type { LevelDraft } from "../plans/level-reference";
import { DEFAULT_BACKTEST_CONFIG } from "../backtest/backtest-types";
import { killSwitch } from "../risk/kill-switch";
import * as crypto from "crypto";
import { createLogger } from "../logger";
import { ListenerRegistry } from "../events/listener-registry";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";
import { emit } from "../events/outbound";

const log = createLogger("paper");

const BUFFER_SIZE = 200;

const INTERVAL_MAP: Record<string, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

/** Fill-model parameters, shared with the backtester so they cannot diverge. */
const FEE_RATE = DEFAULT_BACKTEST_CONFIG.feeRateTakerBps / 10_000;
const SLIPPAGE = DEFAULT_BACKTEST_CONFIG.slippageBps / 10_000;

function applySlippage(price: number, side: "buy" | "sell"): number {
  return side === "buy" ? price * (1 + SLIPPAGE) : price * (1 - SLIPPAGE);
}

/** Stream keys are `SYMBOL:INTERVAL`. Split on the LAST colon — pair symbols
 *  are hyphenated today, but this keeps the parse safe either way. */
function splitStreamKey(key: string): { symbol: string; intervalMin: number } {
  const idx = key.lastIndexOf(":");
  return { symbol: key.slice(0, idx), intervalMin: Number(key.slice(idx + 1)) };
}

export interface PaperPosition {
  id: number;
  /** Null when a plan branch owns this position — schema v15's CHECK makes
   *  exactly one of these two non-null, so the pair is never ambiguous. */
  strategyId: number | null;
  planBranchRowId?: number | null;
  sessionId: number;
  symbol: string;
  entryPrice: number;
  quantity: number;
  entryFee: number;
  stopPrice: number | null;
  targetPrice: number | null;
  openedAt: number;
  highestPriceSeen?: number;
  breakevenMoved?: boolean;
  completedTargets?: Set<number>;
}

/**
 * Why a position closed. The distinction that matters is **who decided**:
 *
 *   • `exit_signal` / `stop_loss` / `take_profit` — the STRATEGY decided. These
 *     are evidence about its edge and count toward promotion.
 *   • `manual` / `session_archived` — the OPERATOR decided, for reasons that
 *     have nothing to do with the setup. Counting an administrative wind-down
 *     as a losing trade would slander a strategy for something it didn't do,
 *     and counting it as a win would flatter it. It's neither; it's an
 *     interruption, and the review agent is told so explicitly.
 */
export type ExitReason = "exit_signal" | "stop_loss" | "take_profit" | "manual" | "session_archived";

/** Exits the strategy itself chose — the only ones that are evidence. */
export const STRATEGY_EXIT_REASONS: readonly ExitReason[] = ["exit_signal", "stop_loss", "take_profit"];

/** True when the close was an operator action, not a strategy decision. */
export function isAdministrativeExit(reason: string | null | undefined): boolean {
  return reason === "manual" || reason === "session_archived";
}

type CloseListener = (positionId: number) => void;

/**
 * What a derived `PriceLevel` was worth when a position opened, against what
 * it was worth when the strategy was armed.
 *
 * Persisted at entry because it is only true at that instant — by the time the
 * review agent runs, a developing level has moved on and the comparison is
 * unrecoverable. It exists to answer the question no PnL figure can: **did the
 * trigger fire because price moved, or because the level moved toward price?**
 * An anchored profile's POC migrates toward price as volume accumulates, so a
 * strategy can look like it is catching setups while the setups walk into it.
 */
export interface EntryLevelSnapshot {
  key: string;
  /** Human-readable, e.g. "VAH (developing)". */
  label: string;
  /** Value when the strategy was armed. */
  armed: number;
  /** Value resolved at the entry bar. Null when it could not be resolved. */
  atEntry: number | null;
  driftPct: number | null;
  drifted: boolean;
}

export class PaperExchangeEngine {
  private activeStrategies = new Map<number, StrategyRow>();
  private candleBuffers = new Map<string, CandleNumeric[]>();
  private positions = new Map<number, PaperPosition | null>();
  /** Streams this engine currently holds an internal subscription on, so a
   *  reload can release the old ones instead of leaking refcounts forever. */
  private subscribed = new Set<string>();
  /** Last CLOSED bar timestamp already evaluated, per stream. */
  private lastEvaluatedBar = new Map<string, number>();
  private unsubscribeCandle: (() => void) | null = null;
  private closeListeners = new ListenerRegistry<[number]>("paper position close");
  /** Strategies already audited as kill-switch-blocked during the current trip,
   *  so a tripped switch logs one line per strategy instead of one per bar. */
  private killSwitchBlocked = new Set<number>();
  /** `strategyId:levelKey` → the last problem reported for that level, so an
   *  unresolvable or drifted level is logged on change rather than every bar. */
  private levelNotices = new Map<string, string>();
  /** Armed plans being watched, refreshed by `reloadStrategies`. */
  private watchedPlans: StoredPlan[] = [];
  /** planId → last bar timestamp evaluated, so a plan is judged once per bar.
   *  Deliberately NOT `lastEvaluatedBar`, which is keyed by symbol:interval and
   *  already consumed by the first strategy on that stream. */
  private lastPlanBar = new Map<number, number>();
  /** Open positions owned by a plan branch, keyed by `plan_branches.id`.
   *
   *  A separate map rather than a wider key on `positions`: the two are opened
   *  by different rules and, more importantly, the strategy path is frozen —
   *  reshaping its hot-path lookup to make room for plans would risk a
   *  regression in code nobody is going to exercise again. */
  private planPositions = new Map<number, PaperPosition | null>();
  private running = false;

  public start(subscribeToWs = true) {
    if (this.running) return;
    this.running = true;
    this.reloadStrategies(subscribeToWs);
    if (subscribeToWs) {
      this.unsubscribeCandle = binanceWS.onCandle((symbol, intervalMin, candle) => {
        this.handleCandle(symbol, intervalMin, candle);
      });
    }
    log.info("Started.");
  }

  public stop() {
    if (this.unsubscribeCandle) {
      this.unsubscribeCandle();
      this.unsubscribeCandle = null;
    }
    for (const key of this.subscribed) {
      const { symbol, intervalMin } = splitStreamKey(key);
      binanceWS.unsubscribeInternal(symbol, intervalMin);
    }
    this.subscribed.clear();
    this.activeStrategies.clear();
    this.running = false;
    log.info("Stopped.");
  }

  /** Fired after a position is closed and persisted. Used by the post-trade
   *  review agent — deliberately a notification, never a decision input. */
  public onPositionClosed(cb: CloseListener): () => void {
    return this.closeListeners.add(cb);
  }

  public reloadStrategies(subscribeToWs = true) {
    const strategies = getAllPaperStrategies();
    this.activeStrategies.clear();

    const wanted = new Set<string>();

    for (const strat of strategies) {
      let spec: StrategySpec;
      try {
        spec = JSON.parse(strat.spec_json) as StrategySpec;
      } catch (err) {
        log.error(`Strategy ${strat.id} has unparseable spec_json — skipping.`, err);
        continue;
      }

      const session = getSessionById(strat.session_id);
      if (!session) continue;

      /* A non-active session must not OPEN anything (enforced in
         `entryAllowed`) — but dropping it here entirely was wrong: a paused
         session with an open position stopped having its stop-loss and
         take-profit checked at all, so the position sat unmanaged while the
         UI still showed protective levels. Pause means "no new entries", not
         "stop watching". Archived sessions can't have open positions (the
         status change refuses it), so they genuinely drop out. */
      const position = this.loadOpenPosition(strat.id);
      if (session.status === "archived") continue;
      if (session.status !== "active" && !position) continue;

      this.activeStrategies.set(strat.id, strat);

      const intervalMin = INTERVAL_MAP[spec.schedule.eval_interval] || 15;
      const key = `${session.pair}:${intervalMin}`;
      wanted.add(key);

      if (!this.candleBuffers.has(key)) {
        this.candleBuffers.set(key, this.seedBuffer(session.pair, intervalMin));
      }

      this.positions.set(strat.id, position);
    }

    /* Armed plans ride this same engine — no second candle subscriber, because
       a plan monitor and the paper engine racing on one bar could act while
       caps were still being checked, and `EventEmitter` fan-out gives no
       ordering guarantee. They need their pair/interval streams too, or an
       armed plan on a pair no strategy watches would never see a bar. */
    this.watchedPlans = listWatchedPlans();
    this.planPositions.clear();
    for (const plan of this.watchedPlans) {
      const intervalMin = INTERVAL_MAP[plan.evalInterval] || 240;
      const key = `${plan.pair}:${intervalMin}`;
      wanted.add(key);
      if (!this.candleBuffers.has(key)) {
        this.candleBuffers.set(key, this.seedBuffer(plan.pair, intervalMin));
      }
      /* Re-adopt open positions. `listWatchedPlans` returns `triggered` plans
         as well as `planned` ones precisely so this can happen: a restart that
         forgot the position would leave it with nothing checking its stop while
         the app still displayed one. */
      for (const branch of plan.branches) {
        const pos = this.loadPlanPosition(branch.rowId);
        if (pos) this.planPositions.set(branch.rowId, pos);
      }
    }

    if (subscribeToWs) {
      // Release streams we no longer need, take streams we newly need.
      for (const key of Array.from(this.subscribed)) {
        if (!wanted.has(key)) {
          const { symbol, intervalMin } = splitStreamKey(key);
          binanceWS.unsubscribeInternal(symbol, intervalMin);
          this.subscribed.delete(key);
        }
      }
      for (const key of wanted) {
        if (!this.subscribed.has(key)) {
          const { symbol, intervalMin } = splitStreamKey(key);
          binanceWS.subscribeInternal(symbol, intervalMin);
          this.subscribed.add(key);
        }
      }
    }

    log.info(
      `Loaded ${this.activeStrategies.size} active paper strategies and ${this.watchedPlans.length} armed plans.`
    );
  }

  private seedBuffer(symbol: string, intervalMin: number): CandleNumeric[] {
    const rows = getDb()
      .prepare(
        /* `taker_buy_volume` is in the SELECT deliberately: without it every
           seeded bar reads as an unknown aggressor split, so a CVD condition
           would be permanently false on restart while looking perfectly armed.
           A column omitted from a SELECT is indistinguishable, at the type
           level, from one that is genuinely NULL — that is exactly how
           `paper_balance` became fiction. */
        `SELECT start_ms, open, high, low, close, volume, taker_buy_volume FROM candles
         WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL}
         ORDER BY start_ms DESC LIMIT ?`
      )
      .all(symbol, intervalMin, BUFFER_SIZE) as any[];

    return rows.reverse().map((r) => ({
      timestamp: r.start_ms,
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume),
      takerBuyVolume:
        r.taker_buy_volume === null || r.taker_buy_volume === undefined || r.taker_buy_volume === ""
          ? null
          : parseFloat(r.taker_buy_volume),
    }));
  }

  private loadOpenPosition(strategyId: number): PaperPosition | null {
    const row = getDb()
      .prepare(
        `SELECT id, session_id, strategy_id, plan_branch_id, symbol, entry_price, quantity, entry_fee,
                stop_price, target_price, opened_at
         FROM paper_positions WHERE strategy_id = ? AND status = 'open'
         ORDER BY opened_at DESC LIMIT 1`
      )
      .get(strategyId) as any;

    return this.toPosition(row);
  }

  /** The open position a plan branch owns, if any. Read on reload so a restart
   *  resumes managing it — a plan position whose stop stopped being checked
   *  because the app was restarted is the failure the pause semantics exist to
   *  prevent, arriving by a different route. */
  private loadPlanPosition(branchRowId: number): PaperPosition | null {
    const row = getDb()
      .prepare(
        `SELECT id, session_id, strategy_id, plan_branch_id, symbol, entry_price, quantity, entry_fee,
                stop_price, target_price, opened_at
         FROM paper_positions WHERE plan_branch_id = ? AND status = 'open'
         ORDER BY opened_at DESC LIMIT 1`
      )
      .get(branchRowId) as any;

    return this.toPosition(row);
  }

  /** By position id — the wind-down closes specific rows, and a strategy can
   *  in principle hold more than one, so "the strategy's open position" is not
   *  a safe identifier there. */
  private loadPositionById(positionId: number): PaperPosition | null {
    const row = getDb()
      .prepare(
        `SELECT id, session_id, strategy_id, plan_branch_id, symbol, entry_price, quantity, entry_fee,
                stop_price, target_price, opened_at
         FROM paper_positions WHERE id = ? AND status = 'open'`
      )
      .get(positionId) as any;

    return this.toPosition(row);
  }

  /** Highest price the market has printed since the position opened, read from
   *  the candle cache.
   *
   *  A restart used to reset `highestPriceSeen` to the entry price, which threw
   *  away every trailing-stop ratchet the position had earned: the stop stayed
   *  where the DB had it (so protection wasn't *lost*), but it stopped tracking
   *  from the real high and resumed from entry, so a position 30% up behaved
   *  like one just opened. Any interval's high is a real traded high, so the max
   *  across cached intervals is the right reconstruction. */
  private highWaterSince(symbol: string, openedAt: number, fallback: number): number {
    const row = getDb()
      .prepare(
        `SELECT MAX(CAST(high AS REAL)) AS hi FROM candles
         WHERE symbol = ? AND ${FEED_SCOPE_SQL} AND start_ms >= ?`
      )
      .get(symbol, openedAt) as { hi: number | null } | undefined;

    const hi = row?.hi;
    return typeof hi === "number" && Number.isFinite(hi) && hi > fallback ? hi : fallback;
  }

  private toPosition(row: any): PaperPosition | null {
    if (!row) return null;
    const entryPrice = parseFloat(row.entry_price);
    return {
      id: row.id,
      strategyId: row.strategy_id ?? null,
      planBranchRowId: row.plan_branch_id ?? null,
      sessionId: row.session_id,
      symbol: row.symbol,
      entryPrice,
      quantity: parseFloat(row.quantity),
      entryFee: parseFloat(row.entry_fee),
      stopPrice: row.stop_price !== null ? parseFloat(row.stop_price) : null,
      targetPrice: row.target_price !== null ? parseFloat(row.target_price) : null,
      openedAt: row.opened_at,
      highestPriceSeen: this.highWaterSince(row.symbol, row.opened_at, entryPrice),
      breakevenMoved: row.stop_price !== null && parseFloat(row.stop_price) >= entryPrice,
      completedTargets: new Set<number>(),
    };
  }

  /* ── Candle handling ──────────────────────────────────────────────── */

  public handleCandle(symbol: string, intervalMin: number, candle: any) {
    const key = `${symbol}:${intervalMin}`;
    const buffer = this.candleBuffers.get(key);
    if (!buffer) return;

    const c: CandleNumeric = {
      timestamp: candle.start,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      takerBuyVolume: candle.takerBuyVolume ?? null,
    };

    const last = buffer[buffer.length - 1];
    if (last && last.timestamp === c.timestamp) {
      buffer[buffer.length - 1] = c;
    } else {
      buffer.push(c);
      if (buffer.length > BUFFER_SIZE) buffer.shift();
    }

    for (const strat of this.activeStrategies.values()) {
      const session = getSessionById(strat.session_id);
      if (!session || session.pair !== symbol) continue;

      let spec: StrategySpec;
      try {
        spec = JSON.parse(strat.spec_json) as StrategySpec;
      } catch {
        continue;
      }
      if (INTERVAL_MAP[spec.schedule.eval_interval] !== intervalMin) continue;

      try {
        // 1. Protective levels are checked on EVERY tick, closed or not —
        //    a real venue-side stop does not wait for the bar to close.
        const pos = this.positions.get(strat.id) || null;
        if (pos) {
          const hit = this.checkProtectiveLevels(pos, c, spec);
          if (hit) {
            this.closePosition({ kind: "strategy", strat }, session, pos, hit.price, hit.reason);
            continue;
          }
        }

        // 2. Entry/exit signals only on a CLOSED bar, evaluated exactly once.
        if (!candle.closed) continue;
        if (this.lastEvaluatedBar.get(key) === c.timestamp) continue;
        this.lastEvaluatedBar.set(key, c.timestamp);

        this.evaluateStrategy(strat, spec, session, buffer);
      } catch (e) {
        log.error(`Error evaluating strategy ${strat.id}:`, e);
      }
    }

    /* Plan-owned positions: protective levels on every tick, exactly like
       strategies — a stop that waits for the bar to close is not a stop. */
    this.managePlanPositions(symbol, intervalMin, c);

    /* Plan *decisions* last, and only on a closed bar. A direct call rather
       than a second subscriber, for the ordering reason in `reloadStrategies`. */
    if (candle.closed) this.evaluatePlansOnBar(symbol, intervalMin, buffer);
  }

  /**
   * What should each armed plan on this stream do with this bar?
   *
   * **Watch-only for now.** The decision layer is complete and runs for real —
   * expiry, thesis invalidation, drift and triggers are all evaluated, and
   * expiry/invalidation genuinely transition the plan. What a trigger does
   * *not* do yet is open a position, because the paper engine has never
   * executed one (S1-2 unrun) and extending an execution path that has never
   * run once would mean the first fault found is the strategy path's, not the
   * plan path's.
   *
   * The split is the roadmap's own risk ordering: **watching protects you,
   * acting risks something.** Expiry and invalidation are the protective half,
   * so they are live; the entry is gated behind one flag.
   *
   * A recorded trigger with a null `position_id` is a real state, not a
   * placeholder — the branch genuinely fired and genuinely opened nothing. It
   * is also what lets the calibration record start measuring trigger rate
   * before a single position has ever existed.
   */
  private evaluatePlansOnBar(symbol: string, intervalMin: number, buffer: CandleNumeric[]) {
    if (this.watchedPlans.length === 0 || buffer.length < 2) return;
    const bar = buffer[buffer.length - 1];
    if (!bar) return;

    let changed = false;
    for (const plan of this.watchedPlans) {
      if (plan.pair !== symbol) continue;
      if ((INTERVAL_MAP[plan.evalInterval] || 240) !== intervalMin) continue;
      if (this.lastPlanBar.get(plan.rowId) === bar.timestamp) continue;
      this.lastPlanBar.set(plan.rowId, bar.timestamp);

      try {
        if (this.applyPlanOutcome(plan, buffer, bar)) changed = true;
      } catch (e) {
        log.error(`Error evaluating plan ${plan.slug}:`, e);
      }
    }
    /* A transition changes what should be watched, so re-read rather than
       carrying a stale in-memory copy that would keep evaluating a plan the
       database considers finished. */
    if (changed) {
      this.reloadStrategies();
      /* And tell the screen. Without this the Plans page and the dashboard's
         watch panel keep showing "planned" after a plan has triggered — the
         same stale-surface failure the agent's write tools already hit once. */
      emit("data:updated", { kind: "plan" });
    }
  }

  /** Returns true when the plan's state changed. */
  private applyPlanOutcome(plan: StoredPlan, buffer: CandleNumeric[], bar: CandleNumeric): boolean {
    const session = getSessionById(plan.sessionId);
    if (!session) return false;

    const { current, previous } = this.priceMaps(buffer);
    const now = bar.timestamp;

    const evaluation = evaluatePlan(plan, {
      now,
      /* The same evaluator the strategy path and the alert engine use. A
         second implementation is how a plan and a backtest start disagreeing. */
      evaluate: (group) => evaluateConditionGroup(group, current, previous, this.planLevels(plan, now)),
      resolve: (level) => {
        const r = levelResolver.resolve(level, {
          symbol: plan.pair,
          intervalMin: INTERVAL_MAP[plan.evalInterval] || 240,
          asOf: now,
        });
        return { price: r.price, drifted: r.drifted };
      },
    });

    /* Notices are why a plan cannot fire. Reported once per plan per distinct
       reason — per bar would bury the log, never would leave a plan looking
       armed while silently incapable of triggering. */
    for (const notice of evaluation.notices) {
      const key = `plan:${plan.rowId}:${notice}`;
      if (!this.levelNotices.has(key)) {
        this.levelNotices.set(key, notice);
        log.warn(`Plan ${plan.slug}: ${notice}`);
      }
    }

    const outcome = evaluation.outcome;
    if (outcome.kind === "none") return false;

    if (outcome.kind === "expired" || outcome.kind === "invalidated") {
      /* The dedupe key is derived from the EVENT, not the clock: a plan can
         only reach a terminal state once, so a retry or a replay after restart
         can never send this twice. */
      transitionPlan(plan.rowId, outcome.kind, outcome.reason, {
        kind: `plan_${outcome.kind}`,
        title:
          outcome.kind === "invalidated"
            ? `${plan.pair} — thesis invalidated: ${plan.slug}`
            : `${plan.pair} — plan expired: ${plan.slug}`,
        body: `${plan.thesis}\n\n${outcome.reason}`,
        dedupeKey: `plan:${plan.rowId}:${outcome.kind}`,
      });
      log.info(`Plan ${plan.slug} ${outcome.kind}: ${outcome.reason}`);
      /* The plan is over and never traded, so no position review will ever run
         for it. Required lazily and fire-and-forget: the engine must not import
         the agent (it would put an AI module on the execution path's import
         graph), and a failed review must never disturb a state transition that
         has already committed. */
      void (async () => {
        try {
          const { reviewResolvedPlan } = require("../agent/review");
          await reviewResolvedPlan(plan.rowId);
        } catch (e) {
          log.error(`Plan resolution note failed for ${plan.slug}`, e);
        }
      })();
      return true;
    }

    /* Triggered. The branch fired; whether a position follows is a separate
       question, and both answers are recorded. A trigger that fired and could
       not be acted on is a different fact from one that never fired at all, and
       the calibration record has to be able to tell them apart. */
    const branch = plan.branches.find((b) => b.id === outcome.branchId);
    const positionId = branch ? this.openPlanPosition(plan, branch, session, bar) : null;

    recordBranchTrigger(plan.rowId, outcome.branchId, outcome.cancelledBranchIds, now, positionId, {
      kind: "plan_triggered",
      title: `${plan.pair} — ${plan.slug} triggered (${outcome.branchId})`,
      /* Says what happened to the position as well as to the trigger. An owner
         reading "triggered" on their phone would otherwise assume one exists. */
      body:
        `${plan.thesis}\n\nPrice ${bar.close}. ` +
        (positionId !== null
          ? `Simulated position opened (#${positionId}).`
          : "No position was opened — see the app for why."),
      dedupeKey: `plan:${plan.rowId}:triggered:${outcome.branchId}`,
    });
    if (plan.state !== "triggered") transitionPlan(plan.rowId, "triggered", outcome.reason);
    auditLog("plan_branch_triggered", {
      planId: plan.rowId,
      slug: plan.slug,
      branch: outcome.branchId,
      cancelled: outcome.cancelledBranchIds,
      price: bar.close,
      positionOpened: positionId !== null,
      position_id: positionId,
    });
    log.info(
      `Plan ${plan.slug} triggered on "${outcome.branchId}" at ${bar.close}` +
        (positionId !== null ? ` — position #${positionId}` : " — no position opened")
    );
    return true;
  }

  /** Price/volume for the last bar and the one before it. Now `insights/
   *  bar-values.ts`, so the structural dry run judges a plan against exactly
   *  the values the live monitor will. */
  private priceMaps(buffer: CandleNumeric[]) {
    return barValues(buffer);
  }

  /** Resolve every derived level a plan's conditions name, as of this bar. */
  private planLevels(plan: StoredPlan, asOf: number): Map<string, number | null> {
    const out = new Map<string, number | null>();
    const intervalMin = INTERVAL_MAP[plan.evalInterval] || 240;
    const groups = [plan.invalidation, ...plan.branches.map((b) => b.trigger)];
    for (const group of groups) {
      for (const level of extractRequiredLevels(group)) {
        const key = makeLevelKey(level);
        if (out.has(key)) continue;
        out.set(key, levelResolver.resolve(level, { symbol: plan.pair, intervalMin, asOf }).price);
      }
    }
    return out;
  }

  /** Intrabar stop/target check against the candle's extremes, matching the
   *  backtester (which tests `candle.low` for the stop). Stop is checked
   *  first: when a single bar spans both levels we cannot know which tick
   *  came first, so we assume the pessimistic one.
   *
   *  **`spec` is optional, and its absence means a plan owns this position.**
   *  A strategy repeats, so its stop is a *distance* and may ratchet — breakeven
   *  and trailing are part of the rule being tested. A plan is one bet, and its
   *  stop is a specific price the owner signed off on; moving it afterwards
   *  would be the engine trading a geometry the owner never approved. So a plan
   *  position gets steps 3 and 4 only, and that is deliberate rather than
   *  unimplemented. */
  private checkProtectiveLevels(
    pos: PaperPosition,
    candle: CandleNumeric,
    spec?: StrategySpec
  ): { price: number; reason: ExitReason } | null {
    // Dynamic highest price tracking
    pos.highestPriceSeen = Math.max(pos.highestPriceSeen ?? pos.entryPrice, candle.high);

    const stopBefore = pos.stopPrice;

    // 1. Breakeven Trigger
    if (spec && !pos.breakevenMoved && spec.risk.breakeven_trigger_pct) {
      const gainPct = ((pos.highestPriceSeen - pos.entryPrice) / pos.entryPrice) * 100;
      if (gainPct >= spec.risk.breakeven_trigger_pct) {
        pos.stopPrice = Math.max(pos.stopPrice ?? 0, pos.entryPrice);
        pos.breakevenMoved = true;
      }
    }

    // 2. Trailing Stop
    if (spec?.risk.trailing_stop_pct) {
      const trailingStop = pos.highestPriceSeen * (1 - spec.risk.trailing_stop_pct / 100);
      if (pos.stopPrice === null || trailingStop > pos.stopPrice) {
        pos.stopPrice = trailingStop;
      }
    }

    /* Persist a moved stop. Breakeven and trailing used to ratchet the stop in
       memory only, so `paper_positions.stop_price` kept the ORIGINAL level: the
       Workbench, the archive preflight's mark-to-market and the review agent's
       payload all reported a stop the engine was no longer using, and a restart
       reverted the ratchet to the entry-time stop — handing back protection the
       position had already earned. The stop a decision depends on has to be the
       stop that is written down. */
    if (pos.stopPrice !== stopBefore && pos.stopPrice !== null) {
      try {
        getDb()
          .prepare(`UPDATE paper_positions SET stop_price = ? WHERE id = ? AND status = 'open'`)
          .run(pos.stopPrice.toString(), pos.id);
      } catch (err) {
        /* Keep managing the position in memory even if the write fails — the
           in-memory stop is the one that actually protects it right now. */
        log.error(`Failed to persist moved stop for position ${pos.id}`, err);
      }
    }

    // 3. Stop-Loss intrabar trigger
    if (pos.stopPrice !== null && candle.low <= pos.stopPrice) {
      return { price: pos.stopPrice, reason: "stop_loss" };
    }

    // 4. Take-Profit intrabar trigger
    if (pos.targetPrice !== null && candle.high >= pos.targetPrice) {
      return { price: pos.targetPrice, reason: "take_profit" };
    }

    return null;
  }

  private evaluateStrategy(strat: StrategyRow, spec: StrategySpec, session: Session, buffer: CandleNumeric[]) {
    if (buffer.length < 2) return;

    const required = extractRequiredIndicators(spec);
    const indicatorData = new Map<string, { name: string; params: any; values: any }>();

    for (const req of required) {
      if (req.name === "price" || req.name === "volume") continue;
      const key = makeIndicatorKey(req.name, req.params);
      if (!indicatorData.has(key)) {
        const values = computeFromCandles(buffer, req.name, req.params);
        indicatorData.set(key, { name: req.name, params: req.params, values });
      }
    }

    const barIdx = buffer.length - 1;
    const current = new Map<string, number | null>();
    const previous = new Map<string, number | null>();

    const c = buffer[barIdx];
    const p = buffer[barIdx - 1];
    if (!c || !p) return;

    for (const field of ["open", "high", "low", "close"] as const) {
      const k = makeIndicatorKey("price", {}, field);
      current.set(k, c[field]);
      previous.set(k, p[field]);
    }
    const volKey = makeIndicatorKey("volume", {});
    current.set(volKey, c.volume);
    previous.set(volKey, p.volume);

    for (const [baseKey, data] of indicatorData) {
      const curVal = data.values[barIdx];
      const prevVal = data.values[barIdx - 1];

      if (curVal !== null && curVal !== undefined && typeof curVal === "object") {
        for (const field of Object.keys(curVal as any)) {
          const fieldKey = makeIndicatorKey(data.name, data.params, field);
          current.set(fieldKey, (curVal as any)[field] ?? null);
          previous.set(fieldKey, (prevVal as any)?.[field] ?? null);
        }
      } else {
        current.set(baseKey, typeof curVal === "number" ? curVal : null);
        previous.set(baseKey, typeof prevVal === "number" ? (prevVal as number) : null);
      }
    }

    /* Derived price levels (plan §17.6). Resolved AS OF this bar, so a level
       can never see a bar the strategy hasn't. An unresolvable level stays
       null and the condition reads false — fail closed — but it is logged,
       because a strategy that is armed and silently never trades is the exact
       failure mode this codebase keeps finding. */
    const resolvedLevels = this.resolveLevels(strat, spec, session, c.timestamp);
    const levels = resolvedLevels?.prices;

    const pos = this.positions.get(strat.id) || null;
    const price = c.close;

    if (!pos) {
      if (evaluateConditionGroup(spec.entry, current, previous, levels)) {
        if (!this.entryAllowed(strat, spec, session)) return;
        this.openPosition(strat, session, spec, price, resolvedLevels?.snapshot);
      }
    } else {
      if (evaluateConditionGroup(spec.exit, current, previous, levels)) {
        this.closePosition({ kind: "strategy", strat }, session, pos, price, "exit_signal");
      }
    }

    getDb().prepare("UPDATE strategies SET last_evaluated_at = ? WHERE id = ?").run(Date.now(), strat.id);
  }

  /**
   * Resolve the spec's derived `PriceLevel` thresholds as of this bar.
   *
   * Returns undefined when the spec has none, so the overwhelmingly common
   * numeric-threshold case does no work at all.
   *
   * Unresolvable levels are reported ONCE per strategy per distinct reason.
   * Logging per bar would bury the log at one line a minute; logging never
   * would leave an armed strategy quietly incapable of triggering, with
   * nothing anywhere saying why.
   */
  private resolveLevels(
    strat: StrategyRow,
    spec: StrategySpec,
    session: Session,
    asOf: number
  ): { prices: Map<string, number | null>; snapshot: EntryLevelSnapshot[] } | undefined {
    const required = [...extractRequiredLevels(spec.entry), ...extractRequiredLevels(spec.exit)].filter(
      (l) => l.kind === "derived"
    );
    if (required.length === 0) return undefined;

    const ctx = {
      symbol: session.pair,
      intervalMin: INTERVAL_MAP[spec.schedule.eval_interval] || 15,
      asOf,
    };

    const resolved = levelResolver.resolveAll(required, ctx);
    const out = new Map<string, number | null>();
    const snapshot: EntryLevelSnapshot[] = [];

    for (const level of required) {
      const key = makeLevelKey(level);
      const r = resolved.get(key);

      /* A level that has drifted past its tolerance is no longer the level the
         strategy was armed against — same words, different geometry. With the
         default `onDrift: "invalidate"` it stops being a usable threshold, so
         it resolves to null and the condition reads false. `"reconfirm"` needs
         an operator queue, which arrives with `trade_plans` (S3-2); until then
         it keeps trading and is reported, which is the honest half-measure —
         silently treating "ask me" as "carry on" is not. */
      const invalidated =
        r?.drifted === true && (level as { onDrift?: string }).onDrift !== "reconfirm";

      const atEntry = invalidated ? null : (r?.price ?? null);
      out.set(key, atEntry);

      snapshot.push({
        key,
        label: formatLevel(level),
        armed: (level as { resolvedAtArm?: number }).resolvedAtArm ?? NaN,
        atEntry,
        driftPct: r?.driftPct ?? null,
        drifted: r?.drifted === true,
      });

      const problem =
        r === undefined || r.price === null
          ? (r?.unavailableReason ?? "Level could not be resolved.")
          : r.drifted
            ? `drifted ${r.driftPct?.toFixed(2) ?? "?"}% from its armed value` +
              (invalidated ? " — treated as unresolvable" : " — awaiting reconfirmation")
            : null;

      const noticeKey = `${strat.id}:${key}`;
      if (problem === null) {
        this.levelNotices.delete(noticeKey);
        continue;
      }
      if (this.levelNotices.get(noticeKey) === problem) continue;
      this.levelNotices.set(noticeKey, problem);
      log.warn(`Strategy ${strat.id}: ${formatLevel(level)} ${problem}`);
    }

    return { prices: out, snapshot };
  }

  /* ── Risk gates ───────────────────────────────────────────────────── */

  /** Local pre-trade checks. NOTE: deliberately minimal and paper-only — this
   *  is NOT the Phase 4 risk engine and must not be mistaken for it. Live
   *  order placement stays blocked until that engine exists and is tested. */
  private entryAllowed(strat: StrategyRow, spec: StrategySpec, session: Session): boolean {
    /* The emergency kill switch. It was exposed over IPC and wired to a button
       on the Approvals page, but NOTHING in the running engine read it — so
       tripping it changed a flag and the engine carried on opening positions.
       A control that claims to stop the bot and doesn't is worse than no
       control, because you stop looking for the real off switch.

       Deliberately checked here and not on the exit path: protective stops and
       targets must keep firing while the switch is tripped. Freezing the whole
       engine would strand every open position with no stop-loss — the exact
       failure the pause semantics were fixed to avoid. Kill switch means
       "take no new risk", not "stop watching the risk already taken". */
    if (killSwitch.isTripped()) {
      if (!this.killSwitchBlocked.has(strat.id)) {
        this.killSwitchBlocked.add(strat.id);
        log.warn(`Strategy ${strat.id}: entry blocked — kill switch active (${killSwitch.getReason()}).`);
        auditLog("paper_entry_blocked_kill_switch", {
          strategy_id: strat.id,
          session_id: session.id,
          reason: killSwitch.getReason(),
        });
      }
      return false;
    }
    this.killSwitchBlocked.delete(strat.id);

    /* Re-read the status rather than trusting the cached row: a session can be
       paused between `reloadStrategies` and this candle, and a strategy that
       stayed loaded to manage an open position must never open another one. */
    const current = getSessionById(session.id);
    if (!current || current.status !== "active") {
      log.info(`Strategy ${strat.id}: session ${session.id} is ${current?.status ?? "gone"} — no new entries.`);
      return false;
    }

    const db = getDb();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    const tradesToday = db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
         WHERE strategy_id = ? AND mode = 'paper' AND side = 'buy' AND created_at >= ?`
      )
      .get(strat.id, dayStart.getTime()) as { n: number };

    if (tradesToday.n >= spec.risk.max_daily_trades) {
      log.info(`Strategy ${strat.id}: daily trade cap (${spec.risk.max_daily_trades}) reached.`);
      return false;
    }

    const openInSession = db
      .prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE session_id = ? AND status = 'open'`)
      .get(session.id) as { n: number };

    if (openInSession.n >= spec.risk.max_open_positions) {
      log.info(`Session ${session.id}: max_open_positions (${spec.risk.max_open_positions}) reached.`);
      return false;
    }

    return true;
  }

  /* ── Execution ────────────────────────────────────────────────────── */

  /**
   * Persist an entry: order, trade, position, and the new cash balance, in one
   * transaction.
   *
   * **Owner-agnostic on purpose (schema v15).** A paper position is opened
   * either by a strategy or by a plan branch, and both must go through *this*
   * function — the fill model, the fee, the balance arithmetic and the
   * protective-level rule are the things that must never fork. A second entry
   * path is how a backtest and a paper run start disagreeing, which is the
   * failure this codebase has already paid for once.
   *
   * Returns the new position id, or `null` when the write failed — in which
   * case nothing was committed and the caller must not update in-memory state.
   */
  private persistEntry(
    owner: { kind: "strategy"; id: number } | { kind: "plan"; branchRowId: number },
    session: Session,
    fill: {
      fillPrice: number;
      quantity: number;
      fee: number;
      quoteAmount: number;
      stopPrice: number | null;
      targetPrice: number | null;
      newBalance: number;
      now: number;
    },
    entryLevels?: EntryLevelSnapshot[]
  ): number | null {
    const db = getDb();
    const { fillPrice, quantity, fee, quoteAmount, stopPrice, targetPrice, newBalance, now } = fill;
    /* `orders.strategy_id` stays NULL for a plan-opened position: that column
       is a foreign key into `strategies`, and inventing a row there to satisfy
       it is exactly the synthetic-strategy shortcut schema v15 rejected. The
       position's `plan_branch_id` is the authoritative link. */
    const strategyId = owner.kind === "strategy" ? owner.id : null;
    const branchId = owner.kind === "plan" ? owner.branchRowId : null;

    return withTransaction(() => {
      const orderRes = db
        .prepare(
          `INSERT INTO orders (session_id, strategy_id, client_order_id, symbol, side, type,
                               quantity, quote_amount, price, status, mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'buy', 'market', ?, ?, ?, 'filled', 'paper', ?, ?)`
        )
        .run(
          session.id,
          strategyId,
          crypto.randomUUID(),
          session.pair,
          quantity.toString(),
          quoteAmount.toString(),
          fillPrice.toString(),
          now,
          now
        );
      const orderId = Number(orderRes.lastInsertRowid);

      db.prepare(
        `INSERT INTO trades (session_id, order_id, venue_trade_id, symbol, side, price, quantity,
                             fee, fee_currency, mode, executed_at, created_at)
         VALUES (?, ?, ?, ?, 'buy', ?, ?, ?, 'USD', 'paper', ?, ?)`
      ).run(
        session.id,
        orderId,
        crypto.randomUUID(),
        session.pair,
        fillPrice.toString(),
        quantity.toString(),
        fee.toString(),
        now,
        now
      );

      const posRes = db
        .prepare(
          `INSERT INTO paper_positions (session_id, strategy_id, plan_branch_id, symbol, side,
                                        entry_price, quantity, entry_fee, stop_price, target_price,
                                        entry_order_id, status, entry_reason, opened_at,
                                        entry_levels_json)
           VALUES (?, ?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?, 'open', 'entry_signal', ?, ?)`
        )
        .run(
          session.id,
          strategyId,
          branchId,
          session.pair,
          fillPrice.toString(),
          quantity.toString(),
          fee.toString(),
          stopPrice !== null ? stopPrice.toString() : null,
          targetPrice !== null ? targetPrice.toString() : null,
          orderId,
          now,
          /* What each derived level was worth at entry, against what it was
             worth at arming. Recorded here and nowhere else: it is only true
             at this instant, and by the time the review runs the levels have
             moved on. */
          entryLevels && entryLevels.length > 0 ? JSON.stringify(entryLevels) : null
        );

      /* One account, not one per session — see `paper/account.ts`. */
      setPaperBalance(newBalance);
      return Number(posRes.lastInsertRowid);
    });
  }

  private openPosition(
    strat: StrategyRow,
    session: Session,
    spec: StrategySpec,
    rawPrice: number,
    entryLevels?: EntryLevelSnapshot[]
  ) {
    const db = getDb();
    const now = Date.now();
    const fillPrice = applySlippage(rawPrice, "buy");
    const balance = getPaperBalance();

    const quoteAmount = this.sizeOrder(spec.sizing, balance);
    if (quoteAmount <= 0) return;

    const quantity = quoteAmount / fillPrice;
    const fee = quoteAmount * FEE_RATE;
    const newBalance = balance - quoteAmount - fee;
    if (newBalance < 0) return;

    // Plan hard rule: every position carries protective levels. In paper these
    // are simulated locally; the live engine must place them venue-side.
    const stopPrice = spec.risk.stop_loss_pct ? fillPrice * (1 - spec.risk.stop_loss_pct / 100) : null;
    const targetPrice = spec.risk.take_profit_pct ? fillPrice * (1 + spec.risk.take_profit_pct / 100) : null;

    const positionId = this.persistEntry(
      { kind: "strategy", id: strat.id },
      session,
      { fillPrice, quantity, fee, quoteAmount, stopPrice, targetPrice, newBalance, now },
      entryLevels
    );
    if (positionId === null) return;

    this.positions.set(strat.id, {
      id: positionId,
      strategyId: strat.id,
      sessionId: session.id,
      symbol: session.pair,
      entryPrice: fillPrice,
      quantity,
      entryFee: fee,
      stopPrice,
      targetPrice,
      openedAt: now,
      highestPriceSeen: fillPrice,
      breakevenMoved: false,
      completedTargets: new Set<number>(),
    });

    auditLog("paper_position_opened", {
      strategy_id: strat.id,
      position_id: positionId,
      price: fillPrice,
      quantity,
      stop: stopPrice,
      target: targetPrice,
      balance: newBalance,
    });

    try {
      const stopStr = stopPrice !== null ? `, stop: $${stopPrice.toFixed(2)}` : "";
      const targetStr = targetPrice !== null ? `, target: $${targetPrice.toFixed(2)}` : "";
      const text = `Strategy Entry: "${strat.name}" opened BUY @ $${fillPrice.toFixed(2)} (qty: ${quantity.toFixed(6)}${stopStr}${targetStr})`;
      db.prepare(
        `INSERT INTO journal (session_id, kind, content, tags, ref_strategy_id, created_at)
         VALUES (?, 'observation', ?, 'strategy,entry,paper', ?, ?)`
      ).run(session.id, text, strat.id, now);
    } catch (err) {
      log.error("Failed to log strategy entry observation:", err);
    }

    log.info(`BUY ${strat.name} (#${strat.id}) @ ${fillPrice.toFixed(2)} qty ${quantity.toFixed(6)} — cash ${newBalance.toFixed(2)}`
    );
  }

  /* ── Plan execution (S1-2) ────────────────────────────────────────── */

  /**
   * The approved geometry of a branch, resolved as of this bar.
   *
   * Static levels are the number the owner typed. Derived levels are resolved
   * *now* rather than read from `resolvedAtArm` — the monitor has already
   * refused to trigger if any of them drifted past tolerance, so the current
   * value is guaranteed to be within the geometry that was signed off, and a
   * VWAP stop that stays where it was at arming is not the stop the owner
   * meant.
   *
   * Returns null when anything is unresolvable, and the caller must then not
   * open. A position with no stop is precisely what must never exist, so this
   * fails closed rather than substituting a number.
   */
  private resolveBranchGeometry(
    plan: StoredPlan,
    branch: StoredPlan["branches"][number],
    asOf: number
  ): { entry: number; stop: number; target: number | null; extraTargets: number; snapshot: EntryLevelSnapshot[] } | null {
    const intervalMin = INTERVAL_MAP[plan.evalInterval] || 240;
    const ctx = { symbol: plan.pair, intervalMin, asOf };
    const snapshot: EntryLevelSnapshot[] = [];

    const value = (lv: LevelDraft, role: string): number | null => {
      if (lv.kind === "static") return lv.price;
      const r = levelResolver.resolve(lv as unknown as PriceLevel, ctx);
      snapshot.push({
        key: `${role}:${makeLevelKey(lv as unknown as PriceLevel)}`,
        label: `${role} — ${formatLevel(lv as unknown as PriceLevel)}`,
        armed: (lv as { resolvedAtArm?: number }).resolvedAtArm ?? NaN,
        atEntry: r.price,
        driftPct: r.driftPct ?? null,
        drifted: r.drifted === true,
      });
      return r.price;
    };

    const entry = value(branch.entry, "entry");
    const stop = value(branch.stop, "stop");
    const targets = branch.targets.map((t) => value(t, "target")).filter((n): n is number => n !== null);

    if (entry === null || stop === null) {
      log.warn(
        `Plan ${plan.slug}/${branch.id}: ${entry === null ? "entry" : "stop"} level could not be resolved — no position opened.`
      );
      return null;
    }
    return { entry, stop, target: targets.length > 0 ? Math.min(...targets) : null, extraTargets: Math.max(0, targets.length - 1), snapshot };
  }

  /**
   * The branch's slice of the plan's budget.
   *
   * Absolute quote, never a percentage of the balance — a plan is a one-shot
   * bet and "5% of whatever I happen to have" is not a number the owner agreed
   * to at authoring time. Capped at the balance so a plan authored when the
   * account was larger cannot overdraw it, and divided by `1 + fee` so the fee
   * comes out of the budget rather than pushing past it.
   */
  private sizePlanBranch(plan: StoredPlan, branch: StoredPlan["branches"][number], balance: number): number {
    let quote = plan.risk.maxQuote * (branch.budgetSharePct / 100);
    if (plan.risk.maxQuotePerBranch != null) quote = Math.min(quote, plan.risk.maxQuotePerBranch);
    if (quote > balance) quote = balance;
    return quote / (1 + FEE_RATE);
  }

  /** Pre-trade checks for a plan entry. The kill switch applies here for the
   *  same reason it applies to strategies — it means "take no new risk". */
  private planEntryAllowed(plan: StoredPlan, branch: StoredPlan["branches"][number]): boolean {
    if (killSwitch.isTripped()) {
      log.warn(`Plan ${plan.slug}: entry blocked — kill switch active (${killSwitch.getReason()}).`);
      auditLog("plan_entry_blocked_kill_switch", {
        planId: plan.rowId,
        slug: plan.slug,
        branch: branch.id,
        reason: killSwitch.getReason(),
      });
      return false;
    }
    /* Re-read rather than trusting the row loaded at reload: a session can be
       paused between the reload and this bar. */
    const session = getSessionById(plan.sessionId);
    if (!session || session.status !== "active") {
      log.info(`Plan ${plan.slug}: session is ${session?.status ?? "gone"} — no entry.`);
      return false;
    }
    /* One position per branch. OCO already cancels siblings, so this guards the
       replay/restart case rather than a design gap. */
    if (this.loadPlanPosition(branch.rowId)) {
      log.warn(`Plan ${plan.slug}/${branch.id}: already holds an open position — not opening a second.`);
      return false;
    }
    return true;
  }

  /**
   * Open the position a triggered branch calls for.
   *
   * Returns the position id, or null when the entry was refused — in which case
   * the branch is still recorded as triggered, because it *did* fire. A trigger
   * that fired and could not be acted on is a different fact from one that
   * never fired, and the calibration record has to be able to tell them apart.
   */
  private openPlanPosition(
    plan: StoredPlan,
    branch: StoredPlan["branches"][number],
    session: Session,
    bar: CandleNumeric
  ): number | null {
    if (!this.planEntryAllowed(plan, branch)) return null;

    const geom = this.resolveBranchGeometry(plan, branch, bar.timestamp);
    if (!geom) return null;

    /* Fill at the bar's close, with the same slippage every other fill uses.
       NOT at the approved entry level: if price gapped through it, filling
       there would be inventing a price the market never offered — the fill
       model's whole job is to refuse that. The divergence is recorded instead. */
    const now = Date.now();
    const fillPrice = applySlippage(bar.close, "buy");

    /* Two refusals, both derived from the owner's own numbers rather than an
       invented tolerance. Entering at or below the approved stop is a trade
       that is already dead; entering at or above the target is paying for a
       move that has already happened. Either means price ran past the plan
       between bars, and taking it anyway would be trading a geometry the owner
       never agreed to. */
    if (fillPrice <= geom.stop || (geom.target !== null && fillPrice >= geom.target)) {
      const why = fillPrice <= geom.stop ? "at or below its stop" : "at or above its target";
      log.warn(`Plan ${plan.slug}/${branch.id}: price ${fillPrice.toFixed(6)} is ${why} — entry refused.`);
      auditLog("plan_entry_refused", {
        planId: plan.rowId,
        slug: plan.slug,
        branch: branch.id,
        reason: why,
        price: fillPrice,
        stop: geom.stop,
        target: geom.target,
      });
      return null;
    }

    const balance = getPaperBalance();
    const quoteAmount = this.sizePlanBranch(plan, branch, balance);
    if (quoteAmount <= 0) return null;

    const quantity = quoteAmount / fillPrice;
    const fee = quoteAmount * FEE_RATE;
    const newBalance = balance - quoteAmount - fee;
    /* Reachable for the first time. While every session minted its own 10,000
       this branch was dead code — there was always cash. With one account it is
       a real outcome, so it is audited like the other refusals rather than only
       logged: a plan that fired and could not be funded is a fact the owner
       needs, and the activity feed reads the audit log. */
    const funding = canFund(quoteAmount + fee);
    if (!funding.ok) {
      log.warn(`Plan ${plan.slug}/${branch.id}: ${funding.reason}`);
      auditLog("plan_entry_refused", {
        planId: plan.rowId,
        slug: plan.slug,
        branch: branch.id,
        reason: funding.reason,
        price: fillPrice,
      });
      return null;
    }

    const positionId = this.persistEntry(
      { kind: "plan", branchRowId: branch.rowId },
      session,
      {
        fillPrice,
        quantity,
        fee,
        quoteAmount,
        stopPrice: geom.stop,
        targetPrice: geom.target,
        newBalance,
        now,
      },
      geom.snapshot
    );
    if (positionId === null) return null;

    this.planPositions.set(branch.rowId, {
      id: positionId,
      strategyId: null,
      planBranchRowId: branch.rowId,
      sessionId: session.id,
      symbol: session.pair,
      entryPrice: fillPrice,
      quantity,
      entryFee: fee,
      stopPrice: geom.stop,
      targetPrice: geom.target,
      openedAt: now,
      highestPriceSeen: fillPrice,
      breakevenMoved: false,
      completedTargets: new Set<number>(),
    });

    auditLog("plan_position_opened", {
      planId: plan.rowId,
      slug: plan.slug,
      branch: branch.id,
      position_id: positionId,
      approved_entry: geom.entry,
      price: fillPrice,
      /* How far the fill sat from the level the owner signed. The number that
         says whether the plan got the trade it asked for. */
      entry_divergence_pct: geom.entry !== 0 ? ((fillPrice - geom.entry) / geom.entry) * 100 : null,
      quantity,
      stop: geom.stop,
      target: geom.target,
      /* Only the nearest target is managed. Scaling out is a real feature and
         is not built; saying so beats implying the others were honoured. */
      unmanaged_targets: geom.extraTargets,
      balance: newBalance,
    });

    try {
      getDb()
        .prepare(
          `INSERT INTO journal (session_id, kind, content, tags, ref_plan_id, created_at)
           VALUES (?, 'observation', ?, 'plan,entry,paper', ?, ?)`
        )
        .run(
          session.id,
          `Plan entry: "${plan.slug}" branch "${branch.label}" opened BUY @ ${fillPrice.toFixed(6)} ` +
            `(approved entry ${geom.entry.toFixed(6)}, stop ${geom.stop.toFixed(6)}` +
            `${geom.target !== null ? `, target ${geom.target.toFixed(6)}` : ""}, qty ${quantity.toFixed(6)})`,
          plan.rowId,
          now
        );
    } catch (err) {
      log.error("Failed to log plan entry observation:", err);
    }

    log.info(
      `BUY plan ${plan.slug}/${branch.id} @ ${fillPrice.toFixed(6)} qty ${quantity.toFixed(6)} — cash ${newBalance.toFixed(2)}`
    );
    return positionId;
  }

  /**
   * Stops and targets for plan-owned positions, checked on **every tick**.
   *
   * Same rule as strategies and for the same reason: a real venue-side stop
   * does not wait for the bar to close. This is separate from
   * `evaluatePlansOnBar`, which runs only on a closed bar — protecting an open
   * position and deciding whether to open one are different jobs on different
   * clocks.
   */
  private managePlanPositions(symbol: string, intervalMin: number, candle: CandleNumeric) {
    if (this.planPositions.size === 0) return;

    for (const plan of this.watchedPlans) {
      if (plan.pair !== symbol) continue;
      if ((INTERVAL_MAP[plan.evalInterval] || 240) !== intervalMin) continue;

      const session = getSessionById(plan.sessionId);
      if (!session) continue;

      for (const branch of plan.branches) {
        const pos = this.planPositions.get(branch.rowId);
        if (!pos) continue;
        /* No spec: a plan's stop is a price the owner approved, not a distance
           that ratchets. See `checkProtectiveLevels`. */
        const hit = this.checkProtectiveLevels(pos, candle);
        if (!hit) continue;
        this.closePosition(
          { kind: "plan", label: `${plan.slug}/${branch.id}` },
          session,
          pos,
          hit.price,
          hit.reason
        );
        this.settlePlanIfDone(plan, branch, hit);
      }
    }
  }

  /**
   * A plan whose last position has closed and which has nothing left to fire is
   * over — move it to `closed` so it stops being watched and the calibration
   * record has an outcome rather than a plan sitting in `triggered` for ever.
   *
   * With OCO on (the default) one trigger cancels the siblings, so this fires on
   * the first exit. With OCO off, pending branches keep the plan alive — the
   * owner described more than one way the market might resolve and only one of
   * them has played out.
   */
  private settlePlanIfDone(
    plan: StoredPlan,
    branch: StoredPlan["branches"][number],
    hit: { price: number; reason: ExitReason }
  ) {
    const fresh = listWatchedPlans().find((p) => p.rowId === plan.rowId);
    if (!fresh) return;
    const stillPending = fresh.branches.some((b) => b.status === "pending");
    const stillOpen = fresh.branches.some((b) => b.positionId !== null && this.planPositions.get(b.rowId));
    if (stillPending || stillOpen) return;

    transitionPlan(plan.rowId, "closed", `Position closed: ${hit.reason} at ${hit.price}.`, {
      kind: "plan_closed",
      title: `${plan.pair} — ${plan.slug} closed (${hit.reason})`,
      body: `${plan.thesis}\n\nBranch "${branch.label}" exited at ${hit.price} (${hit.reason}).`,
      dedupeKey: `plan:${plan.rowId}:closed`,
    });
    this.reloadStrategies();
  }

  /**
   * Close a position, whichever kind of thing owns it.
   *
   * The owner affects three things and nothing else: which foreign key the
   * exit order carries, which in-memory map is cleared, and what the log says.
   * The fill price, the fee, the realised-PnL arithmetic and the close
   * notification are identical by construction — a second close path is how a
   * plan's recorded PnL and a strategy's stop meaning subtly different things.
   */
  private closePosition(
    owner: { kind: "strategy"; strat: StrategyRow } | { kind: "plan"; label: string },
    session: Session,
    pos: PaperPosition,
    rawPrice: number,
    reason: ExitReason
  ) {
    /* NULL for a plan-owned exit, same rule as the entry: `orders.strategy_id`
       is a foreign key into `strategies` and there is no row to point at. */
    const ownerStrategyId = owner.kind === "strategy" ? owner.strat.id : null;
    const ownerLabel = owner.kind === "strategy" ? `${owner.strat.name} (#${owner.strat.id})` : owner.label;
    const db = getDb();
    const now = Date.now();
    // Stop/target fill AT the level (the backtester does the same); a signal
    // exit fills at the close with slippage applied.
    const fillPrice =
      reason === "stop_loss" || reason === "take_profit" ? rawPrice : applySlippage(rawPrice, "sell");

    const proceeds = pos.quantity * fillPrice;
    const exitFee = proceeds * FEE_RATE;
    const balance = getPaperBalance();
    const newBalance = balance + proceeds - exitFee;
    const feesTotal = pos.entryFee + exitFee;
    const realizedPnl = (fillPrice - pos.entryPrice) * pos.quantity - feesTotal;

    db.exec("BEGIN TRANSACTION;");
    try {
      const orderRes = db
        .prepare(
          `INSERT INTO orders (session_id, strategy_id, client_order_id, symbol, side, type,
                               quantity, quote_amount, price, status, mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'sell', 'market', ?, ?, ?, 'filled', 'paper', ?, ?)`
        )
        .run(
          session.id,
          ownerStrategyId,
          crypto.randomUUID(),
          session.pair,
          pos.quantity.toString(),
          proceeds.toString(),
          fillPrice.toString(),
          now,
          now
        );
      const orderId = Number(orderRes.lastInsertRowid);

      db.prepare(
        `INSERT INTO trades (session_id, order_id, venue_trade_id, symbol, side, price, quantity,
                             fee, fee_currency, mode, executed_at, created_at)
         VALUES (?, ?, ?, ?, 'sell', ?, ?, ?, 'USD', 'paper', ?, ?)`
      ).run(
        session.id,
        orderId,
        crypto.randomUUID(),
        session.pair,
        fillPrice.toString(),
        pos.quantity.toString(),
        exitFee.toString(),
        now,
        now
      );

      db.prepare(
        `UPDATE paper_positions
         SET status = 'closed', exit_price = ?, exit_reason = ?, realized_pnl = ?,
             fees_total = ?, exit_order_id = ?, closed_at = ?
         WHERE id = ?`
      ).run(
        fillPrice.toString(),
        reason,
        realizedPnl.toString(),
        feesTotal.toString(),
        orderId,
        now,
        pos.id
      );

      setPaperBalance(newBalance);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      log.error("Close transaction failed", err);
      return;
    }

    if (owner.kind === "strategy") this.positions.set(owner.strat.id, null);
    else if (pos.planBranchRowId != null) this.planPositions.set(pos.planBranchRowId, null);

    auditLog("paper_position_closed", {
      strategy_id: ownerStrategyId,
      plan_branch_id: pos.planBranchRowId ?? null,
      position_id: pos.id,
      reason,
      exit_price: fillPrice,
      realized_pnl: realizedPnl,
      balance: newBalance,
    });
    log.info(`SELL ${ownerLabel} @ ${fillPrice.toFixed(2)} — ${reason}, PnL ${realizedPnl.toFixed(2)}, cash ${newBalance.toFixed(2)}`
    );

    this.closeListeners.emit(pos.id);
    /* Positions, PnL and plan state all just moved on screen. */
    emit("data:updated", { kind: owner.kind === "plan" ? "plan" : "strategy" });
  }

  /**
   * Close one open position on demand, at a caller-supplied price.
   *
   * Used by the session wind-down (archive). It deliberately goes through the
   * SAME `closePosition` path as a stop or an exit signal — same fee, same
   * slippage, same order/trade rows, same `paper_positions` update, same
   * close-listener notification (so the review agent still journals it).
   * Re-implementing the close in the archive flow would be a second fill model
   * that drifts from the first, which is exactly the class of bug this codebase
   * keeps paying for.
   *
   * Returns null when there's nothing open for that position id.
   */
  public closePositionForShutdown(
    positionId: number,
    price: number,
    reason: ExitReason = "session_archived"
  ): { realizedPnl: number } | null {
    const row = getDb()
      .prepare(
        `SELECT id, strategy_id, plan_branch_id, session_id
         FROM paper_positions WHERE id = ? AND status = 'open'`
      )
      .get(positionId) as
      | { id: number; strategy_id: number | null; plan_branch_id: number | null; session_id: number }
      | undefined;
    if (!row) return null;

    const session = getSessionById(row.session_id);
    if (!session) return null;

    /* Resolve the owner from the row rather than assuming a strategy. This used
       to read `strategies` unconditionally and bail when the lookup missed —
       so once plans could own a position, the archive wind-down would have
       silently declined to close one, leaving an "archived" session holding a
       live position with nothing checking its stop. Exactly the state archiving
       is refused for. */
    let owner: { kind: "strategy"; strat: StrategyRow } | { kind: "plan"; label: string };
    if (row.strategy_id !== null) {
      /* The strategy may not be in `activeStrategies` (a paused session, or one
         whose streams were released), so read it directly rather than assuming
         the engine currently holds it. */
      const strat = getDb()
        .prepare("SELECT * FROM strategies WHERE id = ?")
        .get(row.strategy_id) as unknown as StrategyRow | undefined;
      if (!strat) return null;
      owner = { kind: "strategy", strat };
    } else {
      const b = getDb()
        .prepare(
          `SELECT p.slug AS plan_slug, b.slug AS branch_slug
           FROM plan_branches b JOIN trade_plans p ON p.id = b.plan_id
           WHERE b.id = ?`
        )
        .get(row.plan_branch_id) as { plan_slug: string; branch_slug: string } | undefined;
      owner = { kind: "plan", label: b ? `${b.plan_slug}/${b.branch_slug}` : `branch #${row.plan_branch_id}` };
    }

    const pos = this.loadPositionById(positionId);
    if (!pos) return null;

    const before = getPaperBalance();
    this.closePosition(owner, session, pos, price, reason);

    const after = getDb()
      .prepare("SELECT realized_pnl FROM paper_positions WHERE id = ?")
      .get(positionId) as { realized_pnl: string | null } | undefined;

    // Fall back to the balance delta if the row somehow has no PnL recorded.
    const realizedPnl = after?.realized_pnl
      ? parseFloat(after.realized_pnl)
      : getPaperBalance() - before;

    return { realizedPnl: Number.isFinite(realizedPnl) ? realizedPnl : 0 };
  }

  private sizeOrder(sizing: SizingConfig, balance: number): number {
    let quote = 0;
    if (sizing.mode === "percent_balance") {
      quote = balance * (sizing.amount / 100);
    } else if (sizing.mode === "fixed_quote" || sizing.mode === "scaled") {
      quote = sizing.amount;
    }
    if (quote > balance) quote = balance;
    // Leave room for the fee so the balance can never go negative.
    return quote / (1 + FEE_RATE);
  }

  /* ── Read helpers (UI / context / review) ─────────────────────────── */

  /** Total account value = cash + mark-to-market of any open position.
   *  `paper_balance` alone reads as a huge drawdown while a position is open. */
  public getEquity(sessionId: number, markPrices: Map<string, number> = new Map()): number {
    const session = getSessionById(sessionId);
    if (!session) return 0;
    /* Cash is now an ACCOUNT fact, so equity is the one balance plus this
       session's open positions marked to market. Summing a per-session balance
       here is what made the portfolio total a count of sessions. */
    let equity = getPaperBalance();

    const rows = getDb()
      .prepare(`SELECT symbol, entry_price, quantity FROM paper_positions WHERE session_id = ? AND status = 'open'`)
      .all(sessionId) as any[];

    for (const r of rows) {
      const mark = markPrices.get(r.symbol) ?? parseFloat(r.entry_price);
      equity += mark * parseFloat(r.quantity);
    }
    return equity;
  }
}

export const paperEngine = new PaperExchangeEngine();
