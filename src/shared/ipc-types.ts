/**
 * The IPC contract — the single definition of every shape that crosses the
 * main↔renderer boundary.
 *
 * These types used to be declared twice, once in `src/main/**` and once in
 * `src/renderer/lib/api.ts`, with nothing checking the two against each other.
 * They drifted (adding `hasBrowserbaseKey` to one copy broke the build; a
 * mismatched optional field would have failed *silently*, which is worse).
 * Both sides now import from here, so a change to a payload is a change in one
 * place and every consumer typechecks against it.
 *
 * Rules for anything added here:
 *   • Type-only. No values, no imports from electron/node/react — this file is
 *     compiled into both the CommonJS main bundle and the ESM renderer bundle.
 *   • Money stays a string end to end (project rule: no float arithmetic on
 *     prices or quantities). Timestamps are ms epoch numbers.
 *   • Never model a secret here. Credential state crosses as booleans only.
 */

/* ── Setup / credentials ─────────────────────────────────────────────── */

export interface SetupStatus {
  hasKeyPair: boolean;
  hasApiKey: boolean;
  hasAnthropicApiKey: boolean;
  /** Presence only — the Browserbase key itself never crosses IPC. */
  hasBrowserbaseKey: boolean;
  publicKeyPem: string | null;
}

/* ── Sessions ────────────────────────────────────────────────────────── */

export interface Session {
  id: number;
  uuid: string;
  pair: string;
  status: "active" | "paused" | "archived";
  risk_config?: string;
  /* No `paper_balance`. Cash moved to ONE account (schema v20) because a
     per-session balance defaulting to 10,000 meant the portfolio total was a
     count of sessions. The column still exists as history and nothing
     maintains it — leaving it on this type would let a caller read a stale
     10,000 and believe it. */
  created_at: number;
  updated_at: number;
}

/* ── Market data ─────────────────────────────────────────────────────── */

export interface Candle {
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  /** Taker (aggressor) BUY base volume. `null`/absent = **unknown**, never 0
   *  (delta is `2 × takerBuy − volume`, so zero would read as pure selling).
   *  Unknown for every bar cached before schema v11. */
  takerBuyVolume?: string | null;
}

export interface TickerSnapshotRow {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
}

/** Measured Revolut X vs. Binance spread — see `data/basis-monitor.ts`. */
export interface BasisStats {
  symbol: string;
  sampleCount: number;
  from: number | null;
  to: number | null;
  medianRevxSpreadBps: number | null;
  p90RevxSpreadBps: number | null;
  medianBinSpreadBps: number | null;
  medianBasisBps: number | null;
  maxAbsBasisBps: number | null;
}

/**
 * How much of a cached symbol/interval has a known aggressor split, which is
 * what CVD and the volume profile's buy/sell breakdown need. See
 * `data/candle-repair.ts` — every bar cached before schema v11 is unknown, and
 * heals only when refetched.
 */
export interface CandleCoverage {
  symbol: string;
  intervalMin: number;
  totalBars: number;
  knownBars: number;
  /** 0..1. `1` means CVD works over the whole cached range. */
  coverage: number;
  oldestMs: number | null;
  newestMs: number | null;
  firstUnknownMs: number | null;
  lastUnknownMs: number | null;
  repairable: boolean;
  blockedReason?: string;
}

/** Outcome of a history repair. Reports measured before/after rather than
 *  claiming success — `stillUnknown` can legitimately be non-zero when Binance
 *  no longer serves that far back. */
export interface CandleRepairResult {
  symbol: string;
  intervalMin: number;
  before: CandleCoverage;
  after: CandleCoverage;
  barsFetched: number;
  stillUnknown: number;
  healed: number;
}

/** Progress event pushed on `candles:repairProgress` during a repair. */
export interface CandleRepairProgress {
  symbol: string;
  intervalMin: number;
  cursorMs: number;
  barsWritten: number;
  batches: number;
}

/**
 * Cumulative volume delta, computed in main and rendered by the chart.
 *
 * `cvd: null` on a point means the aggressor split was unknown for some bar at
 * or before it — a gap, not a flattening. Absolute value is meaningless (it
 * accumulates from an arbitrary anchor); only slope and divergence carry
 * information. Binance **spot** flow — never a claim about Revolut X's book.
 */
export interface CvdPointView {
  timestamp: number;
  delta: number | null;
  cvd: number | null;
}

export interface CvdSeries {
  symbol: string;
  intervalMin: number;
  anchorMs: number | null;
  points: CvdPointView[];
  /** Fraction of bars with a known aggressor split, 0..1. */
  coverage: number;
  firstUnknownAt: number | null;
  /** Earliest anchor from which CVD is computable with no gaps. */
  suggestedAnchor: number | null;
  barsUsed: number;
}

export interface ProfileBinView {
  low: number;
  high: number;
  mid: number;
  volume: number;
  /** Null when any contributing bar's aggressor split was unknown. Never
   *  0-as-unknown: a partial sum presented as the bin's buy volume would be
   *  short by exactly the bars that couldn't be read. */
  buyVolume: number | null;
}

/**
 * A persisted plan reference (S2-2) as it crosses to the renderer.
 *
 * `level` is a `PriceLevel` **without** `resolvedAtArm` — a reference is created
 * long before any plan is armed, so there is no value-at-arm yet. It is typed
 * loosely here because `shared/levels.ts` owns that shape and this file imports
 * nothing; the renderer narrows it via `isPriceLevelLike`.
 */
export interface LevelReferenceView {
  id: number;
  symbol: string;
  interval_min: number | null;
  label: string;
  level: unknown;
  /** The drawing it was promoted from, or null once that drawing was deleted —
   *  erasing the ink does not erase the meaning. */
  drawing_id: number | null;
  created_at: number;
  updated_at: number;
}

/** Volume profile computed in main. `approximate` is always true — a profile
 *  from OHLCV is an estimate, and every display must say so. */
export interface VolumeProfileView {
  symbol: string;
  intervalMin: number;
  bins: ProfileBinView[];
  poc: number;
  pocBinIndex: number;
  vah: number;
  val: number;
  totalVolume: number;
  barsUsed: number;
  binWidth: number;
  valueAreaPct: number;
  distribution: "uniform" | "close_weighted" | "ohlc";
  window: { from: number; to: number };
  deltaKnown: boolean;
  approximate: true;
  /** True when the caller did not specify a bin width and one was proposed.
   *  Anything persisting this profile must send the returned width back, or
   *  the level moves as history grows. */
  binWidthWasSuggested: boolean;
}

/** Cross-venue derivatives. Venues stay separately labelled and are never
 *  blended into one number — the divergence is itself the signal. */
export interface DerivativesMetrics {
  symbol: string;
  binance: {
    openInterest: { symbol: string; openInterest: string; timestamp: number } | null;
    fundingRate: { symbol: string; lastFundingRate?: string; nextFundingTime?: number; markPrice?: string } | null;
  } | null;
  hyperliquid: {
    coin?: string;
    openInterest?: string;
    funding?: string;
    markPrice?: string;
    [k: string]: unknown;
  } | null;
  predictedFundingByVenue: Record<string, { fundingRate: string; nextFundingTime: number }> | null;
  errors: string[];
}

/* ── Paper trading ───────────────────────────────────────────────────── */

export interface PaperPositionRecord {
  id: number;
  session_id: number;
  /* Exactly one owner is set — schema v15 enforces it with a CHECK. */
  strategy_id: number | null;
  strategy_name: string | null;
  plan_branch_id: number | null;
  plan_id: number | null;
  plan_name: string | null;
  branch_name: string | null;
  symbol: string;
  side: string;
  entry_price: string;
  quantity: string;
  entry_fee: string;
  stop_price: string | null;
  target_price: string | null;
  status: "open" | "closed";
  exit_price: string | null;
  exit_reason: string | null;
  realized_pnl: string | null;
  fees_total: string | null;
  opened_at: number;
  closed_at: number | null;
  reviewed: number;
}

export interface PaperStats {
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  totalFees: number;
  /** Cash only — excludes mark-to-market on any open position. */
  cashBalance: number;
}

export interface PaperEquityPoint {
  timestamp: number;
  /** Always 0. Cash is an account fact (v20); a session's curve is its P&L. */
  cashBalance: number;
  realizedPnl: number;
  /** Open positions marked to the analysis feed at that bar. */
  unrealisedPnl: number;
  /** realised + unrealised — cumulative P&L from zero, which is what a
   *  workspace's curve honestly is. Anchoring each session at the account's
   *  starting balance is how three sessions came to plot 30,000. */
  pnl: number;
}

export interface PaperVsBacktestComparison {
  strategyId: number;
  strategyName: string;
  state: string;
  backtestCount: number;
  expectedWinRate: number | null;
  expectedPnl: number | null;
  paperTrades: number;
  paperWinRate: number;
  paperRealizedPnl: number;
  divergenceWinRate: number | null;
  overfittingWarning: boolean;
}

/* ── Read models for the UI ──────────────────────────────────────────── */

export interface OrderRecord {
  id: number;
  session_id: number;
  strategy_id: number | null;
  strategy_name: string | null;
  client_order_id: string;
  symbol: string;
  side: string;
  type: string;
  quantity: string | null;
  quote_amount: string | null;
  price: string | null;
  status: string;
  mode: string;
  created_at: number;
  fee: string | null;
}

export interface JournalEntry {
  id: number;
  session_id: number;
  kind: string;
  content: string;
  tags: string;
  ref_strategy_id: number | null;
  created_at: number;
}

export interface ActivityEvent {
  id: number;
  action: string;
  detail: string;
  created_at: number;
}

export interface SessionSummary {
  id: number;
  uuid: string;
  pair: string;
  status: string;
  /* No cashBalance. A session is a workspace, not an account (schema v20) —
     a per-session figure would be a second definition of available capital. */
  openCount: number;
  closedCount: number;
  wins: number;
  realizedPnl: number;
  fees: number;
  strategyCount: number;
  armedCount: number;
  lastActivityAt: number | null;
}

export interface PortfolioSummary {
  sessions: SessionSummary[];
  totals: {
    /** Spendable. Drops by the full entry when a position opens. */
    cashBalance: number;
    /** cash + open positions marked to the analysis feed. What it is worth. */
    equity: number;
    /** Mark minus entry across open positions. Zero when nothing is open. */
    unrealisedPnl: number;
    /** Open positions with no recent candle, valued at cost. Said, not hidden. */
    unpricedPositions: number;
    realizedPnl: number;
    fees: number;
    openCount: number;
    closedCount: number;
    wins: number;
    sessions: number;
  };
}

/* ── Session archive (wind-down) ─────────────────────────────────────── */

/** The ordered steps of an archive, in execution order. */
export type ArchiveStepId =
  | "close_positions"
  | "retire_strategies"
  | "clear_alerts"
  | "release_streams"
  | "archive_session";

export interface ArchivePositionPreview {
  id: number;
  symbol: string;
  strategyName: string;
  quantity: string;
  entryPrice: string;
  /** Null when we have no recent price — archiving is blocked in that case. */
  lastPrice: string | null;
  /** Marked to `lastPrice`, net of the exit fee. Becomes realised on archive. */
  unrealizedPnl: number | null;
  openedAt: number;
}

/** What archiving would actually do — computed in main, stated in the UI. */
export interface ArchivePlan {
  sessionId: number;
  pair: string;
  status: Session["status"];
  openPositions: ArchivePositionPreview[];
  armedStrategies: number;
  retirableStrategies: number;
  totalStrategies: number;
  activeAlerts: number;
  /** Kept, not deleted — stated so it's clear archiving isn't destruction. */
  journalEntries: number;
  closedTrades: number;
  realizedPnl: number;
}

export interface ArchiveStepEvent {
  sessionId: number;
  step: ArchiveStepId;
  status: "running" | "done" | "failed";
  detail?: string;
}

export interface ArchiveSummary {
  sessionId: number;
  pair: string;
  closed: number;
  retired: number;
  alertsCleared: number;
  /** PnL realised by the wind-down itself, separate from prior trades. */
  realizedOnClose: number;
}

/* ── Research ────────────────────────────────────────────────────────── */

export interface ChartDrawing {
  id: number;
  symbol: string;
  /** NULL means the drawing shows on every timeframe (price levels). */
  interval_min: number | null;
  kind: string;
  /** JSON: [{ timestamp, value }] */
  points: string;
  extend: string;
  locked: number;
  created_at: number;
  updated_at: number;
}

/* ── Strategies ──────────────────────────────────────────────────────── */

/** The strategy lifecycle. Defined here rather than in the strategy module so
 *  the renderer can reason about states without importing engine code — and
 *  so both sides agree on the spelling of a state that gates real money. */
export type StrategyState =
  | "draft"
  | "backtested"
  | "paper"
  | "live_supervised"
  | "live_auto"
  | "retired";

/* ── Scenario plans (§17, roadmap S3-1) ──────────────────────────────── */

/**
 * The scenario-plan lifecycle. Here rather than in the plan module for the same
 * reason as `StrategyState`: the renderer must agree on the spelling of a state
 * that gates real money.
 *
 * **There is deliberately no `live_auto`.** A plan's licence to trade comes from
 * falsifiability, not from a validated edge, and unattended automation without a
 * validated edge is exactly what plan §17 refuses. The state not existing is a
 * stronger guarantee than a check that could be forgotten.
 *
 * `expired` and `invalidated` are separate terminal states on purpose:
 *   • `expired`     — the clock ran out; the thesis was never tested.
 *   • `invalidated` — the thesis was tested and proved wrong (or a developing
 *                     level drifted past its tolerance).
 * Collapsing them would destroy the calibration record's most useful
 * distinction — plans that never fired vs. plans that fired and were wrong.
 */
export type PlanState =
  | "draft"
  | "planned"
  | "triggered"
  | "closed"
  | "expired"
  | "invalidated";

export interface StrategyRow {
  id: number;
  session_id: number;
  name: string;
  version: number;
  spec_json: string;
  state: StrategyState;
  description: string;
  backtest_count: number;
  last_evaluated_at: number | null;
  created_at: number;
}

/* ── AI models ──────────────────────────────────────────────────────── */

/**
 * A model the active AI provider offers, in the app's own shape — not any one
 * vendor's. The field names match what the chat panel has always read, so the
 * Anthropic adapter maps 1:1 and other adapters map into it.
 */
export interface AiModelInfo {
  id: string;
  display_name: string;
  /** Which provider offers it (`"anthropic"`, …). */
  provider: string;
  capabilities: {
    /** Adaptive reasoning controlled by an effort level. */
    effort: { supported: boolean };
    /** Extended thinking controlled by a token budget. */
    thinking: { supported: boolean };
  };
  /** The adapter's suggested default — its cheapest capable model. */
  recommended?: boolean;
}
