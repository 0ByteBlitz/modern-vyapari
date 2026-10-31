/**
 * Resolving a `PriceLevel` reference to a number (roadmap S1-1, plan §17.6).
 *
 * A spec can say "VAH of the profile anchored at Monday's open" instead of
 * "71,800". Something has to turn that back into a number every bar, and this
 * is it. Three properties are load-bearing, and each one is a bug this project
 * has already paid for in another form:
 *
 *  1. **Point-in-time.** A resolution `asOf` bar *i* sees only bars `≤ i`.
 *     Resolving over the full range and then replaying is look-ahead bias, and
 *     an anchored-profile strategy would backtest beautifully on levels that
 *     did not exist yet.
 *  2. **Incremental.** Anchored accumulators are path-dependent, so recomputing
 *     from the anchor every bar is O(n) per bar — O(n²) across a replay. State
 *     is carried forward and only new bars are folded in.
 *  3. **Unresolvable is a value, not an error.** `price: null` propagates to
 *     "condition is false" (fail closed). It must never fall back to a
 *     substitute number: a level nobody could compute is precisely the value
 *     that must not quietly become a trigger.
 *
 * Rewinding is handled explicitly rather than assumed away: an accumulator
 * cannot un-see a bar, so a resolution `asOf` an EARLIER bar than the last one
 * folded in rebuilds from the anchor. Without that, a replay restarting mid-run
 * would silently carry forward the future it had already seen.
 */

import { getDb } from "../db/database";
import { createLogger } from "../logger";
import type { CandleNumeric, CandleRow } from "./indicator-types";
import { toNumericCandle } from "./indicator-types";
import { AnchoredVwapAccumulator, CvdAccumulator } from "./anchored";
import { VolumeProfileAccumulator } from "./volume-profile";
import { computeFromCandles } from "./indicators";
import { makeLevelKey } from "../strategy/strategy-spec";
import type {
  DerivedLevel,
  PriceLevel,
  ResolvedLevel,
  StaticLevel,
  VolumeProfileParams,
} from "../../shared/levels";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

const log = createLogger("level-resolver");

/**
 * Sources this resolver can actually compute, today.
 *
 * `ichimoku` (S2-4) and `fib` (S2-1) are expressible in a spec but not yet
 * resolvable. They resolve to null with a reason rather than being silently
 * absent — and `setStrategyState` refuses to arm a strategy that needs one,
 * because a fail-closed threshold makes a strategy that looks armed and never
 * trades, which is the failure mode this codebase keeps finding.
 */
export const RESOLVABLE_SOURCES = ["vwap", "avwap", "volume_profile", "cvd"] as const;
export type ResolvableSource = (typeof RESOLVABLE_SOURCES)[number];

export function isResolvableSource(source: string): source is ResolvableSource {
  return (RESOLVABLE_SOURCES as readonly string[]).includes(source);
}

/* ── Candle access ──────────────────────────────────────────────────── */

/** Bars in `[fromMs, toMs]` ascending. Injectable so the resolver is testable
 *  without a database, and so a backtest can feed it its own series. */
export type CandleSource = (
  symbol: string,
  intervalMin: number,
  fromMs: number,
  toMs: number
) => CandleNumeric[];

/**
 * The analysis feed, and only the analysis feed. `${FEED_SCOPE_SQL}` is not
 * incidental: a level resolved from Revolut X prices and compared against a
 * Binance-derived indicator would be two feeds inside one computation.
 *
 * `taker_buy_volume` is in the SELECT deliberately — CVD and the profile's
 * buy/sell split are computed from it, and a column omitted from a SELECT is
 * indistinguishable at the type level from one that is genuinely NULL. That is
 * exactly how `paper_balance` became fiction.
 */
export const dbCandleSource: CandleSource = (symbol, intervalMin, fromMs, toMs) => {
  const rows = getDb()
    .prepare(
      `SELECT symbol, interval_min, start_ms, open, high, low, close, volume,
              taker_buy_volume, source
       FROM candles
       WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL}
         AND start_ms >= ? AND start_ms <= ?
       ORDER BY start_ms ASC`
    )
    .all(symbol, intervalMin, fromMs, toMs) as unknown as CandleRow[];

  return rows.map(toNumericCandle);
};

/* ── Context ────────────────────────────────────────────────────────── */

export interface LevelContext {
  symbol: string;
  intervalMin: number;
  /** Bar being evaluated. Nothing after this timestamp may influence the result. */
  asOf: number;
}

/* ── Internal accumulator state ─────────────────────────────────────── */

interface CacheEntry {
  vwap?: AnchoredVwapAccumulator;
  cvd?: CvdAccumulator;
  profile?: VolumeProfileAccumulator;
  /** Last bar folded in. null = nothing accumulated yet. */
  lastBarTs: number | null;
  /** UTC day the session-VWAP accumulator belongs to, for the daily reset. */
  sessionDay?: number;
  /** A closed window resolves once and is then deterministic forever. */
  frozen?: ResolvedLevel;
}

const MS_PER_DAY = 86_400_000;

function utcDayStart(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

function unavailable(reason: string): ResolvedLevel {
  return { price: null, unavailableReason: reason };
}

/* ── The resolver ───────────────────────────────────────────────────── */

export class LevelResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly candles: CandleSource = dbCandleSource) {}

  /** Drop all accumulated state. Call when starting a fresh replay. */
  reset(): void {
    this.cache.clear();
  }

  /**
   * Resolve many levels at once, keyed by `makeLevelKey` — the shape
   * `evaluateConditionGroup` consumes, plus the drift metadata a caller needs
   * to decide whether the plan is still the plan that was approved.
   */
  resolveAll(levels: readonly PriceLevel[], ctx: LevelContext): Map<string, ResolvedLevel> {
    const out = new Map<string, ResolvedLevel>();
    for (const level of levels) {
      const key = makeLevelKey(level);
      if (out.has(key)) continue;
      out.set(key, this.resolve(level, ctx));
    }
    return out;
  }

  /** Just the prices, for `evaluateConditionGroup`'s `levels` argument. */
  priceMap(levels: readonly PriceLevel[], ctx: LevelContext): Map<string, number | null> {
    const resolved = this.resolveAll(levels, ctx);
    const out = new Map<string, number | null>();
    for (const [key, r] of resolved) out.set(key, r.price);
    return out;
  }

  /**
   * Resolve a level **at arming time**, computing its value now.
   *
   * `resolve()` deliberately refuses to recompute a `snapshot_at_arm` level: it
   * hands back the number the trader agreed to, and recomputing would quietly
   * change the trade. But arming is the one moment that number does not exist
   * yet — it is being established. This is that moment, and it is the only
   * caller allowed to compute it.
   *
   * Takes a level **without** `resolvedAtArm` (a `LevelDraft`), because a
   * reference promoted from a drawing genuinely has no armed value until now.
   * Returns `price: null` with a reason when the level cannot be computed, and
   * a plan must refuse to arm rather than store a placeholder — an unresolvable
   * level written as 0 is a fabricated number in the field every later drift
   * check measures against.
   */
  resolveAtArm(
    level: StaticLevel | Omit<DerivedLevel, "resolvedAtArm">,
    ctx: LevelContext
  ): ResolvedLevel {
    if (level.kind === "static") {
      return Number.isFinite(level.price)
        ? { price: level.price }
        : unavailable("Static level is not a finite number.");
    }
    if (!isResolvableSource(level.source)) {
      return unavailable(`${level.source} levels can't be resolved yet — the source isn't implemented.`);
    }
    /* `computeDerived` never reads `resolvedAtArm`; the cast supplies the field
       only to satisfy the type, and the value never escapes this call. */
    return this.computeDerived({ ...level, resolvedAtArm: Number.NaN } as DerivedLevel, ctx);
  }

  resolve(level: PriceLevel, ctx: LevelContext): ResolvedLevel {
    if (level.kind === "static") {
      return Number.isFinite(level.price)
        ? { price: level.price }
        : unavailable("Static level is not a finite number.");
    }

    /* The trader's thesis was about the price at arming time. Honour it
       literally — do not recompute and do not report drift against yourself. */
    if (level.resolve === "snapshot_at_arm") {
      return Number.isFinite(level.resolvedAtArm)
        ? { price: level.resolvedAtArm, driftPct: 0, drifted: false }
        : unavailable("Level was armed without a resolved value.");
    }

    if (!isResolvableSource(level.source)) {
      return unavailable(
        `${level.source} levels can't be resolved yet — the source isn't implemented.`
      );
    }

    const computed = this.computeDerived(level, ctx);
    if (computed.price === null) return computed;
    return this.withDrift(level, computed, ctx);
  }

  /* ── Computation ──────────────────────────────────────────────────── */

  private computeDerived(level: DerivedLevel, ctx: LevelContext): ResolvedLevel {
    const anchor = level.window.from;
    if (!Number.isFinite(anchor)) return unavailable("Level has no anchor timestamp.");

    /* Point-in-time: a closed window is truncated at `asOf` too, so replaying
       a fixed-range profile bar by bar sees it fill up rather than arrive
       complete on the first bar. */
    const windowEnd = level.window.to === "developing" ? ctx.asOf : Math.min(level.window.to, ctx.asOf);

    if (ctx.asOf < anchor) {
      return unavailable("The level's anchor is later than the bar being evaluated.");
    }
    if (windowEnd < anchor) return unavailable("The level's window is empty at this bar.");

    const cacheKey = `${makeLevelKey(level)}|${ctx.symbol}|${ctx.intervalMin}`;
    let entry = this.cache.get(cacheKey);

    if (entry?.frozen) return entry.frozen;

    /* Rewind. Accumulators only append, so a resolution asking for an EARLIER
       bar than the last one folded in cannot be served from carried state —
       that state already contains bars the caller is not allowed to see. Throw
       it away and rebuild rather than answer with the future. */
    if (entry && entry.lastBarTs !== null && entry.lastBarTs > windowEnd) {
      entry = undefined;
      this.cache.delete(cacheKey);
    }

    /* Session VWAP re-anchors at each UTC day boundary; the reference's own
       `window.from` is where the SERIES begins, not where today's session does. */
    if (level.source === "vwap") {
      const day = utcDayStart(windowEnd);
      if (entry && entry.sessionDay !== day) {
        entry = undefined;
        this.cache.delete(cacheKey);
      }
    }

    if (!entry) {
      const created = this.newEntry(level, windowEnd);
      if (!created) return unavailable("Level parameters are not valid for this source.");
      entry = created;
      this.cache.set(cacheKey, entry);
    }

    const effectiveAnchor = level.source === "vwap" ? Math.max(anchor, utcDayStart(windowEnd)) : anchor;
    const fetchFrom = entry.lastBarTs === null ? effectiveAnchor : entry.lastBarTs + 1;

    if (fetchFrom <= windowEnd) {
      let bars: CandleNumeric[];
      try {
        bars = this.candles(ctx.symbol, ctx.intervalMin, fetchFrom, windowEnd);
      } catch (err) {
        log.error(`Failed to read candles for ${ctx.symbol}/${ctx.intervalMin}m`, err);
        return unavailable("Could not read candle history for this level.");
      }
      for (const bar of bars) {
        entry.vwap?.add(bar);
        entry.cvd?.add(bar);
        entry.profile?.add(bar);
        entry.lastBarTs = bar.timestamp;
      }
    }

    const value = this.readField(level, entry);

    /* A closed window that `asOf` has now passed can never change again, so the
       answer is deterministic forever — freeze it and stop touching the DB. */
    if (level.window.to !== "developing" && ctx.asOf >= level.window.to && value.price !== null) {
      entry.frozen = value;
    }

    return value;
  }

  private newEntry(level: DerivedLevel, windowEnd: number): CacheEntry | null {
    switch (level.source) {
      case "vwap":
        return { vwap: new AnchoredVwapAccumulator(), lastBarTs: null, sessionDay: utcDayStart(windowEnd) };
      case "avwap":
        return { vwap: new AnchoredVwapAccumulator(), lastBarTs: null };
      case "cvd":
        return { cvd: new CvdAccumulator(), lastBarTs: null };
      case "volume_profile": {
        try {
          const params = level.params as unknown as VolumeProfileParams;
          return { profile: new VolumeProfileAccumulator(params), lastBarTs: null };
        } catch (err) {
          log.warn(`Invalid volume-profile params on level ${makeLevelKey(level)}`, err);
          return null;
        }
      }
      default:
        return null;
    }
  }

  private readField(level: DerivedLevel, entry: CacheEntry): ResolvedLevel {
    if (entry.lastBarTs === null) {
      return unavailable("No candle history cached for this level's window yet.");
    }

    if (entry.cvd) {
      const v = entry.cvd.value;
      return v === null
        ? unavailable("CVD is unavailable — the aggressor split is unknown for some bars in this window.")
        : { price: v };
    }

    if (entry.vwap) {
      const { vwap, stdDev } = entry.vwap.current();
      if (vwap === null) return unavailable("No volume in this level's window yet.");

      const field = level.field ?? "vwap";
      if (field === "vwap") return { price: vwap };

      const band = /^(upper|lower)_(\d+(?:\.\d+)?)$/.exec(field);
      if (!band) return unavailable(`Unknown VWAP field "${field}".`);
      if (stdDev === null) return unavailable("Not enough data for VWAP bands yet.");

      const multiplier = parseFloat(band[2]!);
      return { price: band[1] === "upper" ? vwap + multiplier * stdDev : vwap - multiplier * stdDev };
    }

    if (entry.profile) {
      let result;
      try {
        result = entry.profile.result();
      } catch {
        return unavailable("No volume in this profile's window yet.");
      }
      const field = level.field ?? "poc";
      const price =
        field === "poc" ? result.poc : field === "vah" ? result.vah : field === "val" ? result.val : null;
      if (price === null) return unavailable(`Unknown volume-profile field "${field}".`);
      return { price, pocBinIndex: result.pocBinIndex };
    }

    return unavailable("Level source has no accumulator.");
  }

  /* ── Drift ────────────────────────────────────────────────────────── */

  /**
   * How far the level has wandered from where it was when the plan was armed,
   * and whether that exceeds what the trader agreed to.
   *
   * The danger being guarded (plan §17.6): a plan armed against VAH at 71,800
   * that fires three days later at 74,200 is the same words describing a
   * different trade, with a stop/target geometry nobody approved.
   */
  private withDrift(level: DerivedLevel, resolved: ResolvedLevel, ctx: LevelContext): ResolvedLevel {
    const price = resolved.price!;
    const base = level.resolvedAtArm;
    const tol = level.driftTolerance ?? {};
    const out: ResolvedLevel = { ...resolved };

    if (!Number.isFinite(base)) {
      out.drifted = false;
      return out;
    }

    /* CVD accumulates from an arbitrary origin and can legitimately sit at or
       cross zero, so a percentage of it is not a measure of anything. Leave
       driftPct undefined rather than report a number that means nothing. */
    if (base !== 0) out.driftPct = ((price - base) / Math.abs(base)) * 100;

    let drifted = false;

    if (tol.pct !== undefined && out.driftPct !== undefined) {
      if (Math.abs(out.driftPct) > tol.pct) drifted = true;
    }

    if (tol.atr !== undefined) {
      const atr = this.currentAtr(ctx);
      if (atr === null) {
        /* A guard that cannot measure the thing it guards fails closed — the
           same rule the risk engine's quote cap now follows. The level resolves
           to nothing rather than being used with its drift guard inoperative:
           an unguarded developing level is precisely what §17.6 forbids. */
        return {
          price: null,
          unavailableReason: "ATR drift tolerance could not be measured for this level.",
          drifted: true,
        };
      } else if (Math.abs(price - base) > tol.atr * atr) {
        drifted = true;
      }
    }

    /* POC does not glide, it teleports between bins. "The mode moved to a
       different bin" is the real event; a percentage is the wrong shape for a
       discontinuous value. */
    if (tol.binChange && level.source === "volume_profile" && resolved.pocBinIndex !== undefined) {
      const binWidth = (level.params as { binWidth?: number } | undefined)?.binWidth;
      if (typeof binWidth === "number" && binWidth > 0) {
        if (Math.floor(price / binWidth) !== Math.floor(base / binWidth)) drifted = true;
      }
    }

    out.drifted = drifted;
    return out;
  }

  /** ATR(14) on the eval interval, ending at the bar being evaluated. Only
   *  fetched when a level actually configures an ATR tolerance. */
  private currentAtr(ctx: LevelContext, period = 14): number | null {
    const span = ctx.intervalMin * 60_000 * (period * 4);
    let bars: CandleNumeric[];
    try {
      bars = this.candles(ctx.symbol, ctx.intervalMin, ctx.asOf - span, ctx.asOf);
    } catch {
      return null;
    }
    if (bars.length < period + 1) return null;

    const result = computeFromCandles(bars, "atr", { period });
    for (let i = result.values.length - 1; i >= 0; i--) {
      const v = result.values[i];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
    return null;
  }
}

/** Shared instance for the engines. A replay should construct its own so its
 *  accumulator state can't be polluted by (or pollute) live resolution. */
export const levelResolver = new LevelResolver();
