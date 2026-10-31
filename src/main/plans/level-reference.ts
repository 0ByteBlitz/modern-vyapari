/**
 * Promote a drawing into a **plan reference** (plan §17, roadmap S2-2).
 *
 * `chart_drawings` stores KLineChart overlay points — geometry. Two timestamps
 * and two prices tell you where ink sits on a canvas; they do not say *what the
 * trader meant*. So a fib drawn on the chart is invisible to the engine, and a
 * level the engine resolves has no way to appear on the chart. That is two
 * definitions of the same idea, which is the bug class this codebase keeps
 * paying for (candles, VAH, the fill model).
 *
 * The fix is the same one used everywhere else here: **one definition, two
 * consumers.** A `level_references` row holds a `PriceLevel` — the semantics.
 * The chart renders *from* it and the engine resolves *from* it. Drawing stays
 * the authoring gesture: you draw, then promote.
 *
 * This module is pure. It maps a drawing to a level or **refuses with a
 * reason** — and the refusals are the point. A drawing that cannot become a
 * resolvable level must not become a plausible-looking one, because a plan
 * armed against a level nobody can compute evaluates false forever while
 * looking armed.
 */

import type {
  StaticLevel,
  DerivedLevel,
  DerivedLevelField,
  ProfileDistribution,
} from "../../shared/levels";

/**
 * What a promotion produces: a level definition **without** `resolvedAtArm`.
 *
 * A drawing is promoted long before any plan is armed, so there is no "value at
 * arm" yet — and inventing one (0, NaN, today's price) would put a fabricated
 * number in the exact field every drift check measures against. Arming fills it
 * in, at which point it is a real measurement. Until then the field is absent,
 * which is a state the type system can see.
 */
export type LevelDraft = StaticLevel | Omit<DerivedLevel, "resolvedAtArm">;

/** A geometry point as persisted in `chart_drawings.points`. */
export interface DrawingPoint {
  timestamp: number;
  value: number;
}

export interface PromotableDrawing {
  /** KLineChart overlay name, e.g. "horizontalStraightLine", "rect". */
  kind: string;
  points: DrawingPoint[];
}

/** Extra choices the drawing itself cannot carry. */
export interface PromoteOptions {
  /** Which output of a multi-value reference is wanted (POC, VAH, VAL…). */
  field?: DerivedLevelField;
  /**
   * Bin height in price units, for profile references.
   *
   * **Required, never inferred.** An automatic bin width changes as history
   * grows, so the level would move for a reason that has nothing to do with the
   * market — and a plan armed today would silently resolve differently next
   * week. Suggesting one is the caller's job (`suggestBinWidth`), agreeing to
   * it is the trader's.
   */
  binWidth?: number;
  valueAreaPct?: number;
  distribution?: ProfileDistribution;
}

export type PromoteResult =
  | { ok: true; level: LevelDraft; label: string }
  | { ok: false; reason: string };

/* ── Kind → meaning ─────────────────────────────────────────────────── */

/** Drawings that mean "this price matters", regardless of when. */
const HORIZONTAL_KINDS = new Set([
  "horizontalStraightLine",
  "horizontalRayLine",
  "horizontalSegment",
  "priceLine",
  "simpleTag",
]);

/** Sloping lines. Geometrically a price *function of time*, not a level. */
const SLOPING_KINDS = new Set([
  "segment",
  "rayLine",
  "straightLine",
  "parallelStraightLine",
  "priceChannelLine",
]);

/** Not resolvable until Fibonacci becomes data (S2-1). */
const FIB_KINDS = new Set(["fibonacciLine", "fibonacciExtension", "fibonacciCircle", "gannBox"]);

/** Human-labelled interpretation, never mechanically resolvable (§17 tier 3). */
const INTERPRETIVE_KINDS = new Set([
  "threeWaves",
  "fiveWaves",
  "eightWaves",
  "anyWaves",
  "abcd",
  "xabcd",
]);

/** Advisory or decorative; carries no price the engine should ever act on. */
const NON_LEVEL_KINDS = new Set([
  "positionTool",
  "measureTool",
  "simpleAnnotation",
  "circle",
  "triangle",
  "arrow",
]);

/**
 * Turn a drawing into a `PriceLevel`, or say why it cannot be one.
 *
 * `now` is unused deliberately — promotion must not depend on the wall clock,
 * or the same drawing would promote differently at different times.
 */
export function drawingToLevel(
  drawing: PromotableDrawing,
  opts: PromoteOptions = {}
): PromoteResult {
  const points = drawing.points ?? [];
  const kind = drawing.kind;

  if (points.length === 0) return { ok: false, reason: "That drawing has no points to read a price from." };

  /* Horizontal → a static level. The simplest and most common promotion:
     "this price matters". Fixed forever, which is exactly what was drawn. */
  if (HORIZONTAL_KINDS.has(kind)) {
    const price = points[0]?.value;
    if (price === undefined || !Number.isFinite(price)) {
      return { ok: false, reason: "That drawing has no usable price." };
    }
    return { ok: true, level: { kind: "static", price }, label: `${price}` };
  }

  /* A rectangle selects a time window, so it promotes to a FIXED-RANGE volume
     profile — the window is closed, which makes the level deterministic
     forever and exempt from point-in-time replay concerns. */
  if (kind === "rect") {
    const [a, b] = points;
    if (!a || !b) return { ok: false, reason: "A rectangle needs two corners to define a range." };
    const from = Math.min(a.timestamp, b.timestamp);
    const to = Math.max(a.timestamp, b.timestamp);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return { ok: false, reason: "That rectangle does not span a time range." };
    }
    if (!Number.isFinite(opts.binWidth as number) || (opts.binWidth as number) <= 0) {
      /* Never chosen automatically: an automatic width changes as history
         grows, so the level would move for a reason unrelated to the market. */
      return { ok: false, reason: "Enter a bin width for the volume profile." };
    }
    const field = opts.field ?? "poc";
    return {
      ok: true,
      label: `${String(field).toUpperCase()} (fixed range)`,
      level: {
        kind: "derived",
        source: "volume_profile",
        field,
        params: {
          binWidth: opts.binWidth,
          valueAreaPct: opts.valueAreaPct ?? 70,
          distribution: opts.distribution ?? "uniform",
        },
        window: { from, to },
        /* A closed window resolves to one value forever, so there is nothing to
           drift and nothing to snapshot against. */
        resolve: "snapshot_at_arm",
        driftTolerance: {},
        onDrift: "invalidate",
      },
    };
  }

  /* ── Refusals ─────────────────────────────────────────────────────
     Each says what cannot be used and what to do instead. The reasoning behind
     each rule stays here in the comments — a refusal the trader reads five
     times should not re-argue its case every time. */

  if (SLOPING_KINDS.has(kind)) {
    /* A price that varies with time; no `PriceLevel` source expresses one. */
    return {
      ok: false,
      reason: "A sloping line isn't a fixed price. Use one of its ends, or an anchored VWAP.",
    };
  }

  if (FIB_KINDS.has(kind)) {
    /* Not resolvable until S2-1 makes ratio sets data. Promoting one now yields
       a level that evaluates false forever while looking armed. */
    return { ok: false, reason: "Fibonacci levels aren't supported yet." };
  }

  if (INTERPRETIVE_KINDS.has(kind)) {
    /* A human reading, not a computed level. No auto-counter will be built —
       one that revises itself is repainting. S3-4 uses Elliott's rules as an
       invalidation source instead. */
    return { ok: false, reason: "Wave counts are your reading, not a price the engine can track." };
  }

  if (NON_LEVEL_KINDS.has(kind)) {
    return { ok: false, reason: `A ${kind} has no price to track.` };
  }

  return { ok: false, reason: `A ${kind} can't be turned into a level.` };
}

/** Can this drawing kind be promoted at all? For enabling/disabling the action. */
export function isPromotable(kind: string): boolean {
  return HORIZONTAL_KINDS.has(kind) || kind === "rect";
}
