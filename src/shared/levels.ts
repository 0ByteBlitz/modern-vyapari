/**
 * Price levels as REFERENCES rather than numbers (plan §17.6).
 *
 * A scenario plan's price points are not all the same kind of thing:
 *
 *   • **static**          — a number the trader picked. Fixed forever.
 *   • **frozen-derived**  — computed from a CLOSED window (fixed-range volume
 *                           profile, AVWAP with a fixed end). Deterministic:
 *                           the window can never change, so it resolves to one
 *                           stable value forever.
 *   • **developing**      — session VWAP, anchored-profile POC, CVD. MOVES
 *                           EVERY BAR.
 *
 * The third kind is why this file exists. A plan armed against "VAH" at 71,800
 * that fires three days later at 74,200 is the same words describing a
 * different trade, with a stop/target geometry the trader never agreed to. So a
 * developing reference must carry what it was worth when armed, how far it is
 * allowed to move, and what happens when it moves further than that.
 *
 * Type-only + pure. Compiles into both the CJS main bundle and the ESM renderer
 * bundle, so: no electron/node/react imports, ever.
 */

/* ── Anchored accumulators ──────────────────────────────────────────── */

/**
 * How a bar's volume is spread across its price range when building a profile.
 *
 * Volume profile from OHLCV is an **approximation, not a measurement** — a true
 * profile needs trade-level data. The distribution rule materially moves the
 * POC, so it is part of a reference's identity and is always persisted.
 */
export type ProfileDistribution =
  /** Spread evenly across high→low. The default: no hidden weighting assumption. */
  | "uniform"
  /** Triangular, peaking at the close. Assumes late-bar volume dominates. */
  | "close_weighted"
  /** Split in four equal parts at open/high/low/close. */
  | "ohlc";

/** The end of an accumulation window. `"developing"` = up to the latest bar. */
export type WindowEnd = number | "developing";

export interface AnchoredWindow {
  /** Anchor timestamp (ms). Bars at or after this are accumulated. */
  from: number;
  to: WindowEnd;
}

export interface VolumeProfileParams {
  /**
   * Bin height in PRICE UNITS. Required for developing profiles.
   *
   * **Never "auto".** An auto bin width changes as history grows, so the level
   * would move for a reason that has nothing to do with the market — and a plan
   * armed today would silently resolve differently next week.
   */
  binWidth?: number;
  /**
   * Alternative to `binWidth`: divide the window's range into N bins. Only
   * valid for a CLOSED window — with a developing one the range grows, so the
   * bin boundaries (and therefore the POC) would drift on their own.
   */
  binCount?: number;
  /** Share of total volume enclosed by the value area. 70 is convention, not law. */
  valueAreaPct: number;
  distribution: ProfileDistribution;
}

export interface VwapParams {
  /** Standard-deviation band multipliers, e.g. [1, 2]. Empty = no bands. */
  bands?: number[];
}

/* ── Price levels ───────────────────────────────────────────────────── */

export type DerivedLevelSource =
  | "vwap"
  | "avwap"
  | "volume_profile"
  | "cvd"
  | "ichimoku"
  | "fib";

/** Which output of a multi-value reference the level refers to. */
export type DerivedLevelField =
  | "poc"
  | "vah"
  | "val"
  | "vwap"
  | "upper_1" | "lower_1" | "upper_2" | "lower_2"
  | "tenkan" | "kijun" | "senkou_a" | "senkou_b" | "chikou"
  | "cvd"
  | string;

/**
 * How a derived level is pinned in time.
 *
 *  • `snapshot_at_arm`     — freeze the value computed when the plan was armed.
 *                            The trader's thesis was about that price; honour it.
 *  • `snapshot_at_trigger` — recompute once, at trigger, then freeze.
 *  • `live`                — re-resolve every bar. Only sane with a drift guard.
 */
export type LevelResolution = "snapshot_at_arm" | "snapshot_at_trigger" | "live";

/**
 * How far a live level may wander from `resolvedAtArm` before the plan stops
 * being the plan that was approved. At least one field must be set.
 */
export interface DriftTolerance {
  /** Percentage move of the level itself. */
  pct?: number;
  /** Move measured in ATR, so tolerance scales with the pair's volatility. */
  atr?: number;
  /**
   * For volume-profile POC only: trip when the POC moves to a different BIN.
   *
   * POC does not glide like VWAP — it sits in one bin until another overtakes
   * it, then teleports. A percentage tolerance is the wrong shape for a
   * discontinuous value; "the mode moved" is the real event.
   */
  binChange?: boolean;
}

/** What to do when the drift tolerance is exceeded. */
export type DriftAction =
  /** Hold and ask the operator to re-approve against the new geometry. */
  | "reconfirm"
  /** Kill the plan. The default — see the note on `onDrift` below. */
  | "invalidate";

export interface StaticLevel {
  kind: "static";
  price: number;
}

export interface DerivedLevel {
  kind: "derived";
  source: DerivedLevelSource;
  /** Source-specific parameters (`VolumeProfileParams`, `VwapParams`, …).
   *  Persisted verbatim so a level's identity survives a default changing. */
  params: Record<string, unknown>;
  window: AnchoredWindow;
  field?: DerivedLevelField;
  resolve: LevelResolution;
  /**
   * What the level was worth when the plan was armed. Recorded even for
   * `live`, because it is the baseline every drift check measures against —
   * without it "has this moved?" is unanswerable.
   */
  resolvedAtArm: number;
  driftTolerance: DriftTolerance;
  /**
   * Default `"invalidate"`. A stale plan that quietly asks for approval gets
   * approved reflexively at 3am; one that expires forces deliberate
   * re-authoring. `"reconfirm"` is for POC bin changes, where the level moving
   * is expected behaviour rather than evidence the thesis went stale.
   */
  onDrift: DriftAction;
}

export type PriceLevel = StaticLevel | DerivedLevel;

/* ── Resolution result ──────────────────────────────────────────────── */

/**
 * The outcome of resolving a `PriceLevel` at a point in time.
 *
 * `price: null` means **unresolvable**, which is not an error — insufficient
 * history, or an unknown aggressor split for CVD. A caller must treat null as
 * "no opinion" and never substitute a fallback number: a level nobody could
 * compute is exactly the value that must not silently become a trigger.
 */
export interface ResolvedLevel {
  price: number | null;
  /** Why it could not be resolved, for display and logs. */
  unavailableReason?: string;
  /** Bins the POC occupied, when the source is a volume profile. */
  pocBinIndex?: number;
  /** Movement from `resolvedAtArm`, as a signed percentage. */
  driftPct?: number;
  /** True when the drift tolerance has been exceeded. */
  drifted?: boolean;
}

/* ── Display ────────────────────────────────────────────────────────── */

const SOURCE_LABELS: Record<DerivedLevelSource, string> = {
  vwap: "VWAP",
  avwap: "AVWAP",
  volume_profile: "Volume profile",
  cvd: "CVD",
  ichimoku: "Ichimoku",
  fib: "Fib",
};

const FIELD_LABELS: Record<string, string> = {
  poc: "POC",
  vah: "VAH",
  val: "VAL",
  tenkan: "Tenkan",
  kijun: "Kijun",
  senkou_a: "Senkou A",
  senkou_b: "Senkou B",
  chikou: "Chikou",
};

/** Human-readable name for a level — "VAH (fixed range)", "AVWAP", "72000". */
export function formatLevel(level: PriceLevel): string {
  if (level.kind === "static") return String(level.price);
  const source = SOURCE_LABELS[level.source] ?? level.source;
  const field = level.field ? (FIELD_LABELS[level.field] ?? level.field) : null;
  const name = field ? `${field}` : source;
  const scope = level.window.to === "developing" ? "developing" : "fixed range";
  return `${name} (${scope})`;
}

/**
 * Render a condition threshold for display.
 *
 * Centralised because five separate surfaces (journal text, alert toast, alerts
 * page, research chart, workbench spec view) each did
 * `Array.isArray(v) ? v.join(...) : v` — which silently becomes
 * `[object Object]` the moment a threshold is a `PriceLevel` rather than a
 * number. One formatter means adding a level source updates every surface.
 */
export function describeThreshold(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map((v) => describeThreshold(v)).join(" – ");
  if (isPriceLevelLike(value)) return formatLevel(value as PriceLevel);
  return String(value);
}

/** Structural check usable from either bundle without importing the evaluator. */
export function isPriceLevelLike(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  return kind === "static" || kind === "derived";
}

/** Does this level move on its own once armed? */
export function isDeveloping(level: PriceLevel): boolean {
  return level.kind === "derived" && level.window.to === "developing" && level.resolve === "live";
}

/** A level that resolves to one stable value forever — the safest kind to plan
 *  against, and the only kind exempt from point-in-time replay concerns. */
export function isFrozen(level: PriceLevel): boolean {
  if (level.kind === "static") return true;
  return level.window.to !== "developing" || level.resolve !== "live";
}
