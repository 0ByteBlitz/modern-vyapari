/** Typed access to the preload bridge. */

// Payload shapes are defined once in the shared IPC contract
// (src/shared/ipc-types.ts) and re-exported here, so components can keep
// importing them from "@/lib/api" while main and renderer stay in lockstep.
import type {
  SetupStatus,
  Session,
  Candle,
  BasisStats,
  CandleCoverage,
  CandleRepairResult,
  CandleRepairProgress,
  CvdSeries,
  VolumeProfileView,
  DerivativesMetrics,
  PaperPositionRecord,
  PaperStats,
  PaperEquityPoint,
  PaperVsBacktestComparison,
  OrderRecord,
  JournalEntry,
  ActivityEvent,
  SessionSummary,
  PortfolioSummary,
  ChartDrawing,
  LevelReferenceView,
  StrategyRow,
  ArchivePlan,
  ArchivePositionPreview,
  ArchiveStepId,
  ArchiveStepEvent,
  ArchiveSummary,
  AiModelInfo,
} from "@shared/ipc-types";
import { isUserFacingError, type UserFacingError } from "@shared/errors";

export type {
  SetupStatus,
  Session,
  Candle,
  BasisStats,
  CandleCoverage,
  CandleRepairResult,
  CandleRepairProgress,
  CvdSeries,
  VolumeProfileView,
  DerivativesMetrics,
  PaperPositionRecord,
  PaperStats,
  PaperEquityPoint,
  PaperVsBacktestComparison,
  OrderRecord,
  JournalEntry,
  ActivityEvent,
  SessionSummary,
  PortfolioSummary,
  ChartDrawing,
  LevelReferenceView,
  StrategyRow,
  ArchivePlan,
  ArchivePositionPreview,
  ArchiveStepId,
  ArchiveStepEvent,
  ArchiveSummary,
  UserFacingError,
  AiModelInfo,
};


export interface Balance {
  currency: string;
  available: string;
  reserved: string;
  staked?: string;
  total: string;
}


/** Failures cross IPC as a code + a short human sentence — never an internal
 *  message. See `src/shared/errors.ts`. */
export type Result<T> = T | UserFacingError;

export interface Ticker {
  symbol: string;
  bid: string;
  ask: string;
  mid: string;
  last_price: string;
}

export interface PairConfig {
  base: string;
  quote: string;
  base_step: string;
  quote_step: string;
  min_order_size: string;
  max_order_size: string;
  min_order_size_quote: string;
  status: string;
}


export interface ChatMessage {
  id?: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export type HelloAvailability = "available" | "unavailable" | "unsupported-platform";

export interface HelloResult {
  verified: boolean;
  availability: HelloAvailability;
  detail?: string;
}

export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ── Phase 2 types ─────────────────────────────────────────────────── */












export interface BacktestRow {
  id: number;
  session_id: number;
  strategy_id: number | null;
  params_json: string;
  result_json: string | null;
  status: string;
  created_at: number;
}

/* ── Scenario plans ─────────────────────────────────────────────────── */

export type PlanState = "draft" | "planned" | "triggered" | "closed" | "expired" | "invalidated";

export interface PlanAssumptionView {
  text: string;
  tag?: string;
}

/** A level definition as authored: a plain price, or a promoted reference.
 *  Before arming it has no `resolvedAtArm` — that value does not exist yet. */
export type LevelDraftView =
  | { kind: "static"; price: number }
  | Record<string, unknown>;

/**
 * Would this plan fire? **Structural, never statistical** — fires / never fires
 * / fires constantly, reachable, exclusive. There is deliberately no PnL, win
 * rate or expectancy here: a plan is a one-shot bet on a path and is never
 * backtested.
 */
export interface PlanDryRun {
  verdict: "fires" | "never_fires" | "fires_constantly" | "already_over" | "cannot_evaluate";
  /** One sentence for the owner. */
  headline: string;
  barsExamined: number;
  from: number | null;
  to: number | null;
  intervalMin: number;
  branches: Array<{
    id: string;
    label: string;
    firedBars: number;
    firstFireAt: number | null;
    unreachable: boolean;
    constant: boolean;
    overlappingBars: number;
  }>;
  invalidationBars: number;
  invalidatedNow: boolean;
  problems: string[];
  notes: string[];
}

/**
 * How the PLANNER is calibrated, by assumption tag — never how a plan
 * performed. A plan is a one-shot bet with no sample; the person writing them
 * repeats, and whether "range reclaim holds" tends to hold is answerable.
 */
export interface TagCalibration {
  tag: string | null;
  resolved: number;
  triggered: number;
  invalidatedAfterTrigger: number;
  expiredUnfired: number;
  reachedTarget: number;
  stoppedOut: number;
  /** Share of the forecast move reached, averaged. Not PnL. */
  capturedShare: number | null;
  /** Excluded from the rates: the app was not watching for part of their life. */
  unwatched: number;
  /** Null below `minSample` — a rate from four plans is a guess. */
  triggerRate: number | null;
  invalidationRate: number | null;
}

export interface CalibrationRecord {
  tags: TagCalibration[];
  overall: TagCalibration;
  stillOpen: number;
  minSample: number;
  empty: boolean;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Calls whose model had no published price. Shown, never folded into 0. */
  unpricedCalls: number;
}

/**
 * Measured spend, not an account balance.
 *
 * Anthropic exposes no credit-balance endpoint, and its cost reports need an
 * Admin key that individual accounts cannot create. So this is what the app
 * itself has spent, computed from the `usage` block on every response.
 */
export interface UsageReport {
  today: UsageTotals;
  last30Days: UsageTotals;
  allTime: UsageTotals;
  byModel: Array<{ model: string; calls: number; costUsd: number; unpriced: number }>;
  byPurpose: Array<{ purpose: string; calls: number; costUsd: number }>;
  cacheSavedUsd: number;
  /** Attribution across simulated and live. The total is not split by mode:
      the bill is one bill, so the shared store holds every row. */
  byMode: Array<{ mode: string; calls: number; costUsd: number }>;
  scope: string;
}

export type AppMode = "simulated" | "live";

/**
 * Which world this process is in.
 *
 * `mode` is what is running now; `pending` is what the next launch will use.
 * They differ between choosing a mode and restarting, and the UI has to be able
 * to say which is which — a screen that showed only the pending value would be
 * telling the owner they are live while the engine is still simulated.
 */
export interface AppModeStatus {
  mode: AppMode;
  pending: AppMode;
  canPlaceOrders: boolean;
}

/** Notification channel state plus outbox health. */
export interface NotifyStatus {
  configured: boolean;
  /** An address, not a secret — shown back so a wrong one is visible. */
  chatId: string | null;
  stats: { pending: number; delivered: number; abandoned: number };
  /** Messages the app gave up on. The owner was told no other way. */
  abandoned: Array<{ kind: string; title: string; attempts: number }>;
}

/** One agent capability, as the tools menu sees it. */
export interface AgentToolInfo {
  id: string;
  label: string;
  group: "session" | "analysis" | "web" | "browser";
  description: string;
  /** Billed per use on top of tokens. */
  costly?: boolean;
  /** Pulls untrusted external content into the conversation. */
  untrusted?: boolean;
  enabled: boolean;
  /** Set when the MODEL refuses it — not something the owner chose. */
  unavailableReason?: string;
}

export interface PlanBranchView {
  rowId?: number;
  id: string;
  label: string;
  /** As STORED: the compiled ConditionGroup. Authoring uses an intent — see
   *  `PlanInputView`. */
  trigger: unknown;
  entry: LevelDraftView;
  stop: LevelDraftView;
  targets: LevelDraftView[];
  budgetSharePct: number;
  status?: string;
  triggeredAt?: number | null;
  positionId?: number | null;
}

export interface StoredPlanView {
  rowId: number;
  slug: string;
  sessionId: number;
  pair: string;
  thesis: string;
  assumptions: PlanAssumptionView[];
  invalidation: unknown;
  expiresAt: number;
  risk: { maxQuote: number; maxQuotePerBranch?: number };
  ocoExclusive: boolean;
  evalInterval: string;
  state: PlanState;
  armedAt: number | null;
  outcomeReason: string | null;
  notes?: string;
  branches: PlanBranchView[];
}

/** An authored condition. The renderer describes; main compiles it into the
 *  group the engine evaluates — see `plans/condition-intent.ts`. */
export interface ConditionIntentView {
  subject: "price";
  operator: "above" | "below" | "crosses_above" | "crosses_below";
  value: number | Record<string, unknown>;
}

export interface PlanInputView {
  sessionId: number;
  slug: string;
  pair: string;
  thesis: string;
  assumptions: PlanAssumptionView[];
  invalidation: ConditionIntentView;
  expiresAt: number;
  risk: { maxQuote: number; maxQuotePerBranch?: number };
  ocoExclusive?: boolean;
  evalInterval?: string;
  notes?: string;
  /* A branch AS AUTHORED: its trigger is an intent, not the ConditionGroup a
     stored branch carries. The two shapes are deliberately distinct — the
     renderer never constructs what the engine evaluates. */
  branches: Array<{
    id: string;
    label: string;
    trigger: ConditionIntentView;
    entry: LevelDraftView;
    stop: LevelDraftView;
    targets: LevelDraftView[];
    budgetSharePct: number;
  }>;
}

export interface ArmResultView {
  ok: boolean;
  errors: string[];
  warnings: string[];
  resolved: Array<{ where: string; label: string; price: number }>;
}

/** Venue capabilities as they cross to the renderer. */
export interface VenueInfo {
  id: string;
  displayName: string;
  venueSideProtectiveOrders: boolean;
  venueSideOco: boolean;
  dailyOrderLimit: number | null;
  canPlaceOrders: boolean;
}

export interface AlertRecord {
  id: number;
  session_id: number | null;
  label: string;
  symbol: string;
  intervalMin: number;
  condition: any;
  status: string;
  triggered_at: number | null;
  created_at: number;
}

export interface AlertEvent {
  alertId: number;
  label: string;
  symbol: string;
  intervalMin: number;
  condition: any;
  triggeredAt: number;
  currentValue: number | null;
}

export interface RendererApi {
  setupStatus(): Promise<Result<SetupStatus>>;
  generateKeys(): Promise<Result<{ publicKeyPem: string }>>;
  saveApiKey(apiKey: string): Promise<Result<{ ok: true }>>;
  saveAnthropicApiKey(apiKey: string): Promise<Result<{ ok: true }>>;
  saveBrowserbaseKey(apiKey: string): Promise<Result<{ ok: true }>>;
  clearBrowserbaseKey(): Promise<Result<{ ok: true }>>;
  getBalances(): Promise<Result<Balance[]>>;
  /** Revolut X candles — venue reconciliation only. Do NOT chart from this;
   *  Binance is the single analysis feed (see getAnalysisCandles). */
  getCandles(symbol: string, intervalMinutes: number, sinceMs?: number, untilMs?: number): Promise<Result<Candle[]>>;
  /** Binance candles from the local cache, auto-backfilled. The one source for
   *  charts and indicators, so a chart always agrees with the engine. */
  getAnalysisCandles(symbol: string, intervalMinutes: number, limit?: number): Promise<Result<Candle[]>>;
  /** One-shot Binance 24h snapshot — first paint for the market list. */
  getTickerSnapshot(): Promise<Result<{ symbol: string; price: number; change24h: number; volume24h: number }[]>>;
  /** Cross-venue derivatives: Binance futures + Hyperliquid perps, never blended. */
  getDerivatives(symbol: string): Promise<Result<DerivativesMetrics>>;
  /** Measured Revolut X vs. Binance spread for a pair. */
  getBasisStats(symbol: string, sinceMs?: number): Promise<Result<BasisStats>>;
  /** CVD computed in main. The chart renders these values and never derives
   *  its own — the chart must draw the numbers the engine would decide on. */
  getCvdSeries(symbol: string, intervalMin: number, opts?: { anchorMs?: number; limit?: number }): Promise<Result<CvdSeries>>;
  /** Volume profile computed in main. Omit `binWidth` to have one suggested;
   *  anything persisting the result must send that width back, or the level
   *  moves as history grows. */
  getVolumeProfile(req: {
    symbol: string;
    intervalMin: number;
    fromMs?: number;
    toMs?: number;
    binWidth?: number;
    valueAreaPct?: number;
    distribution?: "uniform" | "close_weighted" | "ohlc";
  }): Promise<Result<VolumeProfileView>>;
  /** How much cached history has a known aggressor split — what CVD needs. */
  getCandleCoverage(): Promise<Result<CandleCoverage[]>>;
  /** Refetch history so `taker_buy_volume` heals. Omit both arguments to
   *  repair every incomplete symbol/interval. Safe to re-run. */
  repairCandleHistory(symbol?: string, intervalMin?: number): Promise<Result<CandleRepairResult[]>>;
  onCandleRepairProgress(cb: (p: CandleRepairProgress) => void): () => void;
  getTickers(symbols?: string[]): Promise<Result<Ticker[]>>;
  getPairs(): Promise<Result<Record<string, PairConfig>>>;
  /** Pairs a session can be created for. Venue in live mode, analysis feed in
   *  simulated — the venue is the wrong authority when there is no venue. */
  getTradablePairs(): Promise<Result<Record<string, { base: string; quote: string; status: string }>>>;
  /** The active venue and what it can do. Presence/booleans only — a label
   *  source, never credential material. */
  getVenueInfo(): Promise<Result<{ active: VenueInfo; available: VenueInfo[] }>>;
  dbInfo(): Promise<Result<{ schemaVersion: string; sessionCount: number }>>;
  // Diagnostics — internal detail lives in the log file, not in error messages.
  getLogPath(): Promise<Result<{ path: string }>>;
  getRecentLogs(maxLines?: number): Promise<Result<{ lines: string[] }>>;
  revealLogs(): Promise<Result<{ ok: true }>>;
  copyToClipboard(text: string): Promise<Result<{ ok: true }>>;
  // Binance WS feed
  subscribeBinanceCandles(symbol: string, intervalMinutes: number): void;
  unsubscribeBinanceCandles(symbol: string, intervalMinutes: number): void;
  /** Tell main what the Research chart is showing, so agent chart tools match it. */
  reportResearchView(v: { symbol: string; intervalMin: number; bounds: { x: number; y: number; width: number; height: number } | null }): void;
  reportResearchClosed(): void;
  subscribeBinanceTickers(): void;
  unsubscribeBinanceTickers(): void;
  onBinanceTickerUpdate(callback: (data: any[]) => void): () => void;
  onCandleUpdate(callback: (data: { symbol: string; intervalMin: number; candle: Candle }) => void): () => void;
  // Chat
  getChatHistory(sessionId: number): Promise<Result<ChatMessage[]>>;
  clearChatHistory(sessionId: number): Promise<Result<{ ok: true }>>;
  compactChatHistory(sessionId: number): Promise<Result<{ ok: boolean; summary?: string; error?: string }>>;
  getAiModels(): Promise<Result<AiModelInfo[]>>;
  sendChatMessage(sessionId: number, messages: { role: string; content: string | any[] }[], params?: { model: string; effort: string; capabilities?: { adaptive: boolean; extended: boolean } }): void;
  onChatChunk(callback: (data: { text: string }) => void): () => void;
  onChatComplete(callback: () => void): () => void;
  onChatError(callback: (data: { error: string }) => void): () => void;
  /** The turn succeeded but did something differently — e.g. a model that
   *  can't search the web. Rendered quietly, never as a failure. */
  onChatNotice(callback: (data: { text: string }) => void): () => void;
  /** Presence and outbox health. The bot token never crosses IPC. */
  /** Simulated or live. `pending` is what the NEXT launch will use. */
  /** What this app has spent. Not an account balance — none is exposed. */
  usageReport(): Promise<Result<UsageReport>>;
  /** The one paper balance. Sessions are workspaces; cash is not theirs. */
  paperAccount(): Promise<Result<{ balance: number; initialBalance: number; updatedAt: number }>>;
  setPaperBalance(startingBalance: number): Promise<Result<{ ok: true }>>;
  appModeStatus(): Promise<Result<AppModeStatus>>;
  setAppMode(mode: AppMode): Promise<Result<{ ok: true; restartRequired: boolean }>>;
  notifyStatus(): Promise<Result<NotifyStatus>>;
  saveTelegram(botToken: string, chatId: string): Promise<Result<{ ok: true }>>;
  clearTelegram(): Promise<Result<{ ok: true }>>;
  testNotification(): Promise<Result<{ ok: true } | { ok: false; reason: string }>>;
  listAgentTools(model?: string): Promise<Result<AgentToolInfo[]>>;
  setAgentTool(id: string, enabled: boolean): Promise<Result<{ ok: true }>>;
  resetAgentTools(): Promise<Result<{ ok: true }>>;
  // Sessions (Phase 1)
  listSessions(includeArchived?: boolean): Promise<Result<Session[]>>;
  createSession(pair: string): Promise<Result<Session>>;
  setSessionStatus(id: number, status: Session["status"]): Promise<Result<Session>>;
  /** What archiving this session would do — shown before anything happens. */
  archivePlan(id: number): Promise<Result<ArchivePlan>>;
  /** Runs the wind-down; progress arrives on `onArchiveStep`. */
  archiveSession(id: number): Promise<Result<ArchiveSummary>>;
  onArchiveStep(callback: (event: ArchiveStepEvent) => void): () => void;
  selectSession(id: number | null): Promise<Result<Session | null>>;
  getSelectedSession(): Promise<Result<Session | null>>;
  // Security (app-launch gate)
  checkWindowsHello(): Promise<Result<HelloAvailability>>;
  requestWindowsHello(reason: string): Promise<Result<HelloResult>>;
  // Embedded browser (Phase 1 surface 3)
  browserShow(): Promise<Result<{ ok: true }>>;
  browserHide(): Promise<Result<{ ok: true }>>;
  browserSetBounds(bounds: BrowserBounds): Promise<Result<{ ok: true }>>;
  browserNavigate(url: string): Promise<Result<{ ok: true }>>;
  browserGoHome(): Promise<Result<{ ok: true }>>;
  browserGoBack(): Promise<Result<{ ok: true }>>;
  browserGoForward(): Promise<Result<{ ok: true }>>;
  browserReload(): Promise<Result<{ ok: true }>>;
  browserGetState(): Promise<Result<BrowserState | null>>;
  onBrowserState(callback: (state: BrowserState) => void): () => void;
  // Phase 2: Strategies
  listStrategies(sessionId: number): Promise<Result<StrategyRow[]>>;
  getStrategy(id: number): Promise<Result<StrategyRow | null>>;
  setStrategyState(id: number, state: string): Promise<Result<StrategyRow>>;
  deleteStrategy(id: number): Promise<Result<{ ok: true }>>;
  // Phase 3: Paper positions (read-only)
  listPaperPositions(sessionId: number, strategyId?: number): Promise<Result<PaperPositionRecord[]>>;
  getPaperStats(sessionId: number): Promise<Result<PaperStats>>;
  getPaperEquityCurve(sessionId: number): Promise<Result<PaperEquityPoint[]>>;
  getStrategyComparisons(sessionId: number): Promise<Result<PaperVsBacktestComparison[]>>;
  listOrders(sessionId: number, limit?: number): Promise<Result<OrderRecord[]>>;
  approveOrder(orderId: number): Promise<Result<{ success: boolean }>>;
  rejectOrder(orderId: number): Promise<Result<{ success: boolean }>>;
  listJournal(
    sessionId: number,
    opts?: { kind?: string; query?: string; limit?: number }
  ): Promise<Result<JournalEntry[]>>;
  journalCounts(sessionId: number): Promise<Result<Record<string, number>>>;
  listActivity(limit?: number): Promise<Result<ActivityEvent[]>>;
  portfolioSummary(includeArchived?: boolean): Promise<Result<PortfolioSummary>>;
  tripKillSwitch(reason?: string): Promise<Result<{ active: boolean; reason: string }>>;
  resetKillSwitch(): Promise<Result<{ active: boolean; reason: string }>>;
  getKillSwitchStatus(): Promise<Result<{ active: boolean; reason: string }>>;
  listDrawings(symbol: string, intervalMin?: number): Promise<Result<ChartDrawing[]>>;
  saveDrawing(d: {
    id?: number;
    symbol: string;
    intervalMin: number | null;
    kind: string;
    points: unknown;
    extend?: unknown;
    locked?: boolean;
  }): Promise<Result<ChartDrawing>>;
  deleteDrawing(id: number): Promise<Result<{ ok: true }>>;
  clearDrawings(symbol: string): Promise<Result<{ deleted: number }>>;
  /* Plan references (S2-2) — the semantic layer over drawings. The chart
     renders from these and the engine resolves from them, so a level drawn on
     screen and a level a plan triggers on are one definition. */
  listLevelReferences(symbol: string, intervalMin?: number): Promise<Result<LevelReferenceView[]>>;
  /* Returns a REFUSAL rather than throwing when a drawing can't become a
     resolvable level — the reason is meant to be shown, since "it silently did
     nothing" is how a trader ends up believing in a level the engine can't see. */
  promoteDrawing(
    drawingId: number,
    opts?: { field?: string; binWidth?: number; valueAreaPct?: number; distribution?: string; label?: string }
  ): Promise<Result<{ ok: true; reference: LevelReferenceView } | { ok: false; reason: string }>>;
  deleteLevelReference(id: number): Promise<Result<{ ok: true }>>;
  /* Scenario plans (S3-1/S3-2). The falsifiability gate lives in main and is
     never re-implemented here — a UI copy of the rule that decides whether
     unvalidated conviction reaches real money would be a second definition of
     the one thing that must have exactly one. */
  listPlans(sessionId: number, states?: PlanState[]): Promise<Result<StoredPlanView[]>>;
  getPlan(id: number): Promise<Result<StoredPlanView | null>>;
  createPlan(input: PlanInputView): Promise<Result<{ ok: true; plan: StoredPlanView } | { ok: false; reason: string }>>;
  updatePlan(id: number, input: PlanInputView): Promise<Result<{ ok: boolean; reason?: string }>>;
  deletePlan(id: number): Promise<Result<{ ok: boolean; reason?: string }>>;
  /** Returns the gate's verdict AND what each derived level resolved to, so the
   *  concrete numbers can be shown before committing rather than after. */
  armPlan(id: number): Promise<Result<ArmResultView>>;
  /** Would this plan fire? Structural only — there is no PnL in the reply. */
  dryRunPlan(id: number): Promise<Result<PlanDryRun>>;
  /** Omit the session for the cross-session record, which is the useful one. */
  planCalibration(sessionId?: number): Promise<Result<CalibrationRecord>>;
  transitionPlan(id: number, to: PlanState, reason?: string): Promise<Result<{ ok: boolean; reason?: string }>>;
  // Phase 2: Backtests
  listBacktests(sessionId: number): Promise<Result<BacktestRow[]>>;
  getBacktestResult(id: number): Promise<Result<any>>;
  // Phase 2: Alerts
  listAlerts(sessionId?: number): Promise<Result<AlertRecord[]>>;
  removeAlert(alertId: number): Promise<Result<{ ok: true }>>;
  onAlertTriggered(callback: (event: AlertEvent) => void): () => void;
  /** Agent-driven navigation — the agent switches the UI to the surface it's
   *  working on so the user sees what the agent is doing in real time. */
  onAgentNavigate(callback: (surface: string) => void): () => void;
  onAgentActing(callback: (acting: boolean) => void): () => void;
  onDataUpdated(callback: (data: { kind: string }) => void): () => void;
  // Phase 2: Indicators
  listIndicatorCatalog(): Promise<Result<any[]>>;
  computeIndicators(symbol: string, intervalMin: number, indicators: any[], limit?: number): Promise<Result<any[]>>;
  // Window controls
  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowClose(): Promise<void>;
}

export function isError<T>(r: Result<T>): r is UserFacingError {
  return isUserFacingError(r);
}

/** The sentence to show the user, with its hint when there is one. */
export function errorText(e: UserFacingError): string {
  return e.hint ? `${e.message} ${e.hint}` : e.message;
}

export const api: RendererApi = (window as unknown as { api: RendererApi }).api;
