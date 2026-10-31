/**
 * Backtest types — result shapes, config, and trade records.
 * Separated from backtester.ts so the service layer, IPC, and renderer
 * can import these without pulling in the full engine.
 */

/* ── Config ─────────────────────────────────────────────────────────── */

export interface BacktestConfig {
  /** Taker fee in basis points (default 25 = Revolut X standard tier). */
  feeRateTakerBps: number;
  /** Maker fee in basis points (default 15). */
  feeRateMakerBps: number;
  /** Flat slippage estimate in basis points (default 5). */
  slippageBps: number;
  /** Starting capital in quote currency (e.g. USD). */
  initialCapital: number;
  /** Walk-forward split ratio: fraction of data for in-sample training.
   *  Default 0.7 = 70% in-sample, 30% out-of-sample.
   *  Set to 1.0 to disable walk-forward and use all data. */
  walkForwardSplit: number;
  /** Number of days of historical data to backtest against. Default 30. */
  daysToTest?: number;
}

/** Sensible defaults matching Revolut X's standard fee tier. */
export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  feeRateTakerBps: 25,
  feeRateMakerBps: 15,
  slippageBps: 5,
  initialCapital: 10_000,
  walkForwardSplit: 0.7,
};

/* ── Trade record ───────────────────────────────────────────────────── */

export interface BacktestTrade {
  /** Bar index of entry (within the tested candle range). */
  entryBar: number;
  entryTimestamp: number;
  exitTimestamp: number;
  side: "buy";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  /** Gross PnL before fees and slippage (price difference × quantity). */
  grossPnl: number;
  /** Total fees paid (entry + exit). */
  fees: number;
  /** Total slippage cost (entry + exit). */
  slippage: number;
  /** Net PnL after fees and slippage. */
  netPnl: number;
  /** What triggered the entry. */
  entryReason: string;
  /** What triggered the exit (exit_signal | stop_loss | take_profit | end_of_data). */
  exitReason: string;
  /** Trade duration in milliseconds. */
  durationMs: number;
}

/* ── Metrics ────────────────────────────────────────────────────────── */

export interface BacktestMetrics {
  /** Total return as a percentage of initial capital. */
  totalReturn: number;
  /** Annualized return (CAGR). */
  annualizedReturn: number;
  /** Maximum peak-to-trough drawdown as a percentage. */
  maxDrawdown: number;
  /** Duration of the worst drawdown in milliseconds. */
  maxDrawdownDurationMs: number;
  /** Percentage of trades that were profitable. */
  winRate: number;
  /** Gross profit / gross loss (> 1 is good). */
  profitFactor: number;
  /** Annualized Sharpe ratio (assumes 0% risk-free rate). */
  sharpeRatio: number;
  /** Total number of round-trip trades. */
  totalTrades: number;
  /** Average trade duration in milliseconds. */
  avgTradeDurationMs: number;
  /** Total fees paid in quote currency. */
  totalFees: number;
  /** Total slippage cost in quote currency. */
  totalSlippage: number;
  /** Net PnL in quote currency (after fees and slippage). */
  netPnl: number;
  /** Gross PnL in quote currency (before fees and slippage). */
  grossPnl: number;
}

/** An empty metrics object for edge cases (no trades). */
export function emptyMetrics(): BacktestMetrics {
  return {
    totalReturn: 0,
    annualizedReturn: 0,
    maxDrawdown: 0,
    maxDrawdownDurationMs: 0,
    winRate: 0,
    profitFactor: 0,
    sharpeRatio: 0,
    totalTrades: 0,
    avgTradeDurationMs: 0,
    totalFees: 0,
    totalSlippage: 0,
    netPnl: 0,
    grossPnl: 0,
  };
}

/* ── Equity curve ───────────────────────────────────────────────────── */

export interface EquityPoint {
  timestamp: number;
  /** Total portfolio value (cash + unrealized). */
  equity: number;
  /** Current drawdown from peak as a percentage (0 = at peak). */
  drawdown: number;
}

/* ── Full result ────────────────────────────────────────────────────── */

export interface BacktestResult {
  /** The strategy spec ID that was backtested. */
  strategyId: string;
  /** Trading pair. */
  pair: string;
  /** Config used for this backtest run. */
  config: BacktestConfig;
  /** Data range that was used. */
  dataRange: {
    from: number;
    to: number;
    bars: number;
    days: number;
  };
  /** In-sample metrics (training set, or full data if walk-forward disabled). */
  inSample: BacktestMetrics;
  /** Out-of-sample metrics (validation set). Null if walk-forward is disabled. */
  outOfSample: BacktestMetrics | null;
  /** Equity curve over the full data range. */
  equityCurve: EquityPoint[];
  /** Complete trade log. */
  tradeLog: BacktestTrade[];
  /** Warnings (low trade count, potential overfit, insufficient data, etc.). */
  warnings: string[];
  /** When this backtest completed (ms epoch). */
  completedAt: number;
}
