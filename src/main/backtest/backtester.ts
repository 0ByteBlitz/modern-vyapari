/**
 * Backtester engine (plan §10) — replays cached candles through a strategy spec.
 *
 * Pure function: no side effects beyond returning a BacktestResult. The service
 * layer (backtest-service.ts) handles DB persistence, progress reporting, etc.
 *
 * Features:
 *   - Fee model (taker/maker rates)
 *   - Slippage estimate (flat bps)
 *   - Walk-forward validation (70/30 split to catch overfitting)
 *   - Equity curve + drawdown tracking
 *   - Per-trade log
 *   - Minimum 30-trade gate + 90-day data requirement
 */

import type { CandleNumeric } from "../insights/indicator-types";
import { makeIndicatorKey } from "../insights/indicator-types";
import { computeFromCandles } from "../insights/indicators";
import type { StrategySpec, Condition, ConditionGroup } from "../strategy/strategy-spec";
import { evaluateConditionGroup, extractRequiredIndicators, isCondition } from "../strategy/strategy-spec";
import type {
  BacktestConfig,
  BacktestResult,
  BacktestMetrics,
  BacktestTrade,
  EquityPoint,
} from "./backtest-types";
import { DEFAULT_BACKTEST_CONFIG, emptyMetrics } from "./backtest-types";

/* ── Helpers ────────────────────────────────────────────────────────── */

function applySlippage(price: number, side: "buy" | "sell", slippageBps: number): number {
  const factor = slippageBps / 10_000;
  return side === "buy" ? price * (1 + factor) : price * (1 - factor);
}

const MS_PER_DAY = 86_400_000;
const MS_PER_YEAR = 365.25 * MS_PER_DAY;
const MIN_TRADES = 30;
const MIN_DAYS = 90;

/**
 * Build flat indicator value maps at a given bar index.
 * Returns { current, previous } maps keyed by makeIndicatorKey().
 *
 * For multi-output indicators, each output field becomes its own key:
 *   makeIndicatorKey("macd", params, "histogram") → value
 *
 * For "price" and "volume" pseudo-indicators, we insert candle values directly.
 */
function buildValueMaps(
  barIdx: number,
  candles: CandleNumeric[],
  indicatorArrays: Map<string, { name: string; params: Record<string, number | string>; values: unknown[] }>
): {
  current: Map<string, number | null>;
  previous: Map<string, number | null>;
} {
  const current = new Map<string, number | null>();
  const previous = new Map<string, number | null>();

  // Price and volume pseudo-indicators
  const c = candles[barIdx];
  const p = barIdx > 0 ? candles[barIdx - 1] : null;
  for (const field of ["open", "high", "low", "close"] as const) {
    const key = makeIndicatorKey("price", {}, field);
    current.set(key, c ? c[field] : null);
    previous.set(key, p ? p[field] : null);
  }
  const volKey = makeIndicatorKey("volume", {});
  current.set(volKey, c?.volume ?? null);
  previous.set(volKey, p?.volume ?? null);

  // Computed indicators
  for (const [baseKey, data] of indicatorArrays) {
    const curVal = data.values[barIdx];
    const prevVal = barIdx > 0 ? data.values[barIdx - 1] : null;

    if (curVal !== null && curVal !== undefined && typeof curVal === "object") {
      // Multi-output: expand each field
      const curObj = curVal as Record<string, number>;
      const prevObj = prevVal != null && typeof prevVal === "object" ? (prevVal as Record<string, number>) : null;

      for (const field of Object.keys(curObj)) {
        const fieldKey = makeIndicatorKey(data.name, data.params, field);
        current.set(fieldKey, curObj[field] ?? null);
        previous.set(fieldKey, prevObj?.[field] ?? null);
      }
      // Also set the base key to the first field value for single-field access
      const firstField = Object.keys(curObj)[0];
      if (firstField) {
        current.set(baseKey, curObj[firstField] ?? null);
        previous.set(baseKey, prevObj?.[firstField] ?? null);
      }
    } else {
      // Single-output
      current.set(baseKey, typeof curVal === "number" ? curVal : null);
      previous.set(baseKey, typeof prevVal === "number" ? (prevVal as number) : null);
    }
  }

  return { current, previous };
}

/**
 * Compute metrics from a completed trade log.
 */
function computeMetrics(
  trades: BacktestTrade[],
  equityCurve: EquityPoint[],
  initialCapital: number,
  durationMs: number
): BacktestMetrics {
  if (trades.length === 0) return emptyMetrics();

  const totalTrades = trades.length;
  const winners = trades.filter((t) => t.netPnl > 0);
  const losers = trades.filter((t) => t.netPnl <= 0);

  const grossProfit = winners.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.netPnl, 0));

  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const totalSlippage = trades.reduce((s, t) => s + t.slippage, 0);
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const grossPnl = trades.reduce((s, t) => s + t.grossPnl, 0);

  const totalReturn = (netPnl / initialCapital) * 100;

  // Annualized return (CAGR)
  const years = durationMs / MS_PER_YEAR;
  const finalEquity = initialCapital + netPnl;
  const annualizedReturn =
    years > 0 && finalEquity > 0
      ? (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100
      : 0;

  // Max drawdown from equity curve
  let peak = initialCapital;
  let maxDD = 0;
  let maxDDDuration = 0;
  let ddStart = 0;

  for (const pt of equityCurve) {
    if (pt.equity > peak) {
      peak = pt.equity;
      ddStart = pt.timestamp;
    }
    const dd = ((peak - pt.equity) / peak) * 100;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDDuration = pt.timestamp - ddStart;
    }
  }

  // Sharpe ratio (daily returns, annualized, 0% risk-free)
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!;
    const cur = equityCurve[i]!;
    if (prev.equity > 0) {
      dailyReturns.push((cur.equity - prev.equity) / prev.equity);
    }
  }
  const meanReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const variance =
    dailyReturns.length > 1
      ? dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (dailyReturns.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

  const avgTradeDurationMs =
    trades.reduce((s, t) => s + t.durationMs, 0) / totalTrades;

  return {
    totalReturn,
    annualizedReturn,
    maxDrawdown: maxDD,
    maxDrawdownDurationMs: maxDDDuration,
    winRate: (winners.length / totalTrades) * 100,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    sharpeRatio,
    totalTrades,
    avgTradeDurationMs,
    totalFees,
    totalSlippage,
    netPnl,
    grossPnl,
  };
}

/* ── Simulation core ────────────────────────────────────────────────── */

interface SimulationOutput {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  finalCash: number;
}

function simulate(
  spec: StrategySpec,
  candles: CandleNumeric[],
  config: BacktestConfig,
  indicatorArrays: Map<string, { name: string; params: Record<string, number | string>; values: unknown[] }>,
  startBar: number,
  endBar: number
): SimulationOutput {
  const feeRate = config.feeRateTakerBps / 10_000; // assume taker for simplicity
  let cash = config.initialCapital;
  let position: {
    entryPrice: number;
    entryTime: number;
    quantity: number;
    entryFee: number;
    entrySlippage: number;
    entryBar: number;
    highestPriceSeen: number;
    stopPrice: number | null;
    breakevenMoved: boolean;
    completedTargets: Set<number>;
  } | null = null;

  let peak = config.initialCapital;
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  for (let i = startBar; i < endBar; i++) {
    const candle = candles[i]!;
    const { current, previous } = buildValueMaps(i, candles, indicatorArrays);

    if (position === null) {
      // ── Check entry ──
      if (evaluateConditionGroup(spec.entry, current, previous)) {
        const rawPrice = candle.close;
        const fillPrice = applySlippage(rawPrice, "buy", config.slippageBps);
        const slippageCost = Math.abs(fillPrice - rawPrice);

        // Determine quote amount
        let quoteAmount: number;
        if (spec.sizing.mode === "fixed_quote") {
          quoteAmount = Math.min(spec.sizing.amount, cash);
        } else if (spec.sizing.mode === "percent_balance") {
          quoteAmount = cash * (spec.sizing.amount / 100);
        } else {
          quoteAmount = Math.min(spec.sizing.amount, cash);
        }

        if (quoteAmount <= 0) continue; // can't afford to enter

        const fee = quoteAmount * feeRate;
        const netQuote = quoteAmount - fee;
        const quantity = netQuote / fillPrice;

        cash -= quoteAmount;

        const initialStop = spec.risk.stop_loss_pct
          ? fillPrice * (1 - spec.risk.stop_loss_pct / 100)
          : null;

        position = {
          entryPrice: fillPrice,
          entryTime: candle.timestamp,
          quantity,
          entryFee: fee,
          entrySlippage: slippageCost * quantity,
          entryBar: i,
          highestPriceSeen: fillPrice,
          stopPrice: initialStop,
          breakevenMoved: false,
          completedTargets: new Set<number>(),
        };
      }
    } else {
      // ── Dynamic Position Updates ──
      position.highestPriceSeen = Math.max(position.highestPriceSeen, candle.high);

      // Check Breakeven Trigger
      if (!position.breakevenMoved && spec.risk.breakeven_trigger_pct) {
        const gainPct = ((position.highestPriceSeen - position.entryPrice) / position.entryPrice) * 100;
        if (gainPct >= spec.risk.breakeven_trigger_pct) {
          position.stopPrice = Math.max(position.stopPrice ?? 0, position.entryPrice);
          position.breakevenMoved = true;
        }
      }

      // Check Trailing Stop
      if (spec.risk.trailing_stop_pct) {
        const trailingStop = position.highestPriceSeen * (1 - spec.risk.trailing_stop_pct / 100);
        if (position.stopPrice === null || trailingStop > position.stopPrice) {
          position.stopPrice = trailingStop;
        }
      }

      let shouldExit = false;
      let exitReason = "";
      let rawExitPrice = candle.close;

      // 1. Check Stop-Loss intrabar (against candle.low)
      if (position.stopPrice !== null && candle.low <= position.stopPrice) {
        shouldExit = true;
        exitReason = "stop_loss";
        rawExitPrice = position.stopPrice;
      }

      // 2. Check Multi-Target Trimming (if not stopping out)
      if (!shouldExit && spec.risk.targets && spec.risk.targets.length > 0) {
        for (let tIdx = 0; tIdx < spec.risk.targets.length; tIdx++) {
          const target = spec.risk.targets[tIdx]!;
          if (position.completedTargets.has(tIdx)) continue;

          const targetPrice = position.entryPrice * (1 + target.pct / 100);
          if (candle.high >= targetPrice) {
            const trimQty = position.quantity * target.trim_share;

            if (trimQty >= position.quantity * 0.999) {
              // Full exit on final target
              shouldExit = true;
              exitReason = "take_profit";
              rawExitPrice = targetPrice;
              break;
            } else {
              // Partial trim
              const fillPrice = applySlippage(targetPrice, "sell", config.slippageBps);
              const exitVal = trimQty * fillPrice;
              const exitFee = exitVal * feeRate;
              const netProceeds = exitVal - exitFee;
              const grossPnl = (fillPrice - position.entryPrice) * trimQty;
              const trimEntryFee = (trimQty / position.quantity) * position.entryFee;
              const trimEntrySlippage = (trimQty / position.quantity) * position.entrySlippage;
              const exitSlippage = Math.abs(targetPrice - fillPrice) * trimQty;

              trades.push({
                entryBar: position.entryBar,
                entryTimestamp: position.entryTime,
                exitTimestamp: candle.timestamp,
                side: "buy",
                entryPrice: position.entryPrice,
                exitPrice: fillPrice,
                quantity: trimQty,
                grossPnl,
                fees: trimEntryFee + exitFee,
                slippage: trimEntrySlippage + exitSlippage,
                netPnl: netProceeds - trimQty * position.entryPrice,
                entryReason: "entry_signal",
                exitReason: "take_profit",
                durationMs: candle.timestamp - position.entryTime,
              });

              cash += netProceeds;
              position.quantity -= trimQty;
              position.entryFee -= trimEntryFee;
              position.entrySlippage -= trimEntrySlippage;
              position.completedTargets.add(tIdx);
            }
          }
        }
      }

      // 3. Check Single Take-Profit (legacy) if not multi-target
      if (!shouldExit && (!spec.risk.targets || spec.risk.targets.length === 0) && spec.risk.take_profit_pct) {
        const targetPrice = position.entryPrice * (1 + spec.risk.take_profit_pct / 100);
        if (candle.high >= targetPrice) {
          shouldExit = true;
          exitReason = "take_profit";
          rawExitPrice = targetPrice;
        }
      }

      // 4. Check Exit Signal on closed bar
      if (!shouldExit && evaluateConditionGroup(spec.exit, current, previous)) {
        shouldExit = true;
        exitReason = "exit_signal";
        rawExitPrice = candle.close;
      }

      if (shouldExit) {
        const fillPrice =
          exitReason === "stop_loss" || exitReason === "take_profit"
            ? rawExitPrice
            : applySlippage(rawExitPrice, "sell", config.slippageBps);
        const exitSlippage = Math.abs(rawExitPrice - fillPrice) * position.quantity;
        const exitValue = position.quantity * fillPrice;
        const exitFee = exitValue * feeRate;
        const netProceeds = exitValue - exitFee;

        const grossPnl = (fillPrice - position.entryPrice) * position.quantity;
        const totalFees = position.entryFee + exitFee;
        const totalSlippage = position.entrySlippage + exitSlippage;
        const netPnl = grossPnl - totalFees;

        trades.push({
          entryBar: position.entryBar,
          entryTimestamp: position.entryTime,
          exitTimestamp: candle.timestamp,
          side: "buy",
          entryPrice: position.entryPrice,
          exitPrice: fillPrice,
          quantity: position.quantity,
          grossPnl,
          fees: totalFees,
          slippage: totalSlippage,
          netPnl,
          entryReason: "entry_signal",
          exitReason,
          durationMs: candle.timestamp - position.entryTime,
        });

        cash += netProceeds;
        position = null;
      }
    }

    // Mark-to-market equity
    const mtm = position ? cash + position.quantity * candle.close : cash;
    if (mtm > peak) peak = mtm;
    const drawdown = peak > 0 ? ((peak - mtm) / peak) * 100 : 0;
    equityCurve.push({ timestamp: candle.timestamp, equity: mtm, drawdown });
  }

  // If still holding at end of data, close at last price
  if (position && candles.length > 0) {
    const lastCandle = candles[endBar - 1]!;
    const fillPrice = applySlippage(lastCandle.close, "sell", config.slippageBps);
    const exitValue = position.quantity * fillPrice;
    const exitFee = exitValue * feeRate;
    const netProceeds = exitValue - exitFee;
    const grossPnl = (fillPrice - position.entryPrice) * position.quantity;

    trades.push({
      entryBar: position.entryBar,
      entryTimestamp: position.entryTime,
      exitTimestamp: lastCandle.timestamp,
      side: "buy",
      entryPrice: position.entryPrice,
      exitPrice: fillPrice,
      quantity: position.quantity,
      grossPnl,
      fees: position.entryFee + exitFee,
      slippage: position.entrySlippage + Math.abs(lastCandle.close - fillPrice) * position.quantity,
      netPnl: netProceeds - (position.quantity * position.entryPrice),
      entryReason: "entry_signal",
      exitReason: "end_of_data",
      durationMs: lastCandle.timestamp - position.entryTime,
    });

    cash += netProceeds;
    position = null;
  }

  return { trades, equityCurve, finalCash: cash };
}

/* ── Public API ─────────────────────────────────────────────────────── */

/**
 * Run a backtest: replay candles through a strategy spec.
 *
 * @param spec    The strategy spec to test.
 * @param candles Chronologically sorted candle array (the full dataset).
 * @param config  Backtest configuration (fees, slippage, capital, walk-forward).
 *                Defaults filled from DEFAULT_BACKTEST_CONFIG.
 */
export function runBacktest(
  spec: StrategySpec,
  candles: CandleNumeric[],
  config?: Partial<BacktestConfig>
): BacktestResult {
  const cfg: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  const warnings: string[] = [];

  // ── Data validation ──
  if (candles.length < 2) {
    return {
      strategyId: spec.id,
      pair: spec.pair,
      config: cfg,
      dataRange: { from: 0, to: 0, bars: 0, days: 0 },
      inSample: emptyMetrics(),
      outOfSample: null,
      equityCurve: [],
      tradeLog: [],
      warnings: ["Insufficient candle data (need at least 2 bars)."],
      completedAt: Date.now(),
    };
  }

  const firstTs = candles[0]!.timestamp;
  const lastTs = candles[candles.length - 1]!.timestamp;
  const dataDays = (lastTs - firstTs) / MS_PER_DAY;

  if (dataDays < MIN_DAYS) {
    warnings.push(
      `Data spans only ${dataDays.toFixed(0)} days (minimum recommended: ${MIN_DAYS}). ` +
      `Results may not be statistically meaningful.`
    );
  }

  // ── Pre-compute all required indicators ──
  const requiredIndicators = extractRequiredIndicators(spec);
  const indicatorArrays = new Map<
    string,
    { name: string; params: Record<string, number | string>; values: unknown[] }
  >();

  for (const ind of requiredIndicators) {
    const result = computeFromCandles(candles, ind.name, ind.params);
    const key = makeIndicatorKey(ind.name, ind.params);
    indicatorArrays.set(key, {
      name: ind.name,
      params: ind.params,
      values: result.values,
    });
  }

  // Find the first bar where all indicators have valid (non-null) values
  let effectiveStart = 0;
  for (const data of indicatorArrays.values()) {
    for (let i = 0; i < data.values.length; i++) {
      if (data.values[i] !== null && data.values[i] !== undefined) {
        effectiveStart = Math.max(effectiveStart, i);
        break;
      }
    }
  }
  // Need at least 1 previous bar for crosses_above/below
  effectiveStart = Math.max(effectiveStart, 1);

  // ── Walk-forward split ──
  const useWalkForward = cfg.walkForwardSplit > 0 && cfg.walkForwardSplit < 1;
  const totalBars = candles.length;
  const splitBar = useWalkForward
    ? Math.floor(effectiveStart + (totalBars - effectiveStart) * cfg.walkForwardSplit)
    : totalBars;

  // ── Run in-sample simulation ──
  const inSampleSim = simulate(spec, candles, cfg, indicatorArrays, effectiveStart, splitBar);

  const inSampleDuration =
    splitBar > effectiveStart
      ? candles[splitBar - 1]!.timestamp - candles[effectiveStart]!.timestamp
      : 0;

  const inSample = computeMetrics(
    inSampleSim.trades,
    inSampleSim.equityCurve,
    cfg.initialCapital,
    inSampleDuration
  );

  // ── Run out-of-sample simulation (if walk-forward enabled) ──
  let outOfSample: BacktestMetrics | null = null;
  let oosTrades: BacktestTrade[] = [];
  let oosEquity: EquityPoint[] = [];

  if (useWalkForward && splitBar < totalBars) {
    const oosSim = simulate(spec, candles, cfg, indicatorArrays, splitBar, totalBars);
    oosTrades = oosSim.trades;
    oosEquity = oosSim.equityCurve;

    const oosDuration = candles[totalBars - 1]!.timestamp - candles[splitBar]!.timestamp;
    outOfSample = computeMetrics(oosTrades, oosEquity, cfg.initialCapital, oosDuration);
  }

  // ── Combine trade logs and equity curves ──
  const allTrades = [...inSampleSim.trades, ...oosTrades];
  const fullEquity = [...inSampleSim.equityCurve, ...oosEquity];

  // ── Generate warnings ──
  if (allTrades.length < MIN_TRADES) {
    warnings.push(
      `Only ${allTrades.length} trades (minimum ${MIN_TRADES} for statistical significance). ` +
      `Consider a wider date range or lower entry thresholds.`
    );
  }

  if (outOfSample) {
    // Overfit detection: if in-sample performance significantly exceeds out-of-sample
    const returnRatio =
      outOfSample.totalReturn !== 0
        ? inSample.totalReturn / outOfSample.totalReturn
        : inSample.totalReturn > 0
        ? Infinity
        : 0;

    if (returnRatio > 3 || (inSample.totalReturn > 5 && outOfSample.totalReturn < 0)) {
      warnings.push(
        `⚠ Potential overfitting detected: in-sample return ${inSample.totalReturn.toFixed(1)}% ` +
        `vs out-of-sample ${outOfSample.totalReturn.toFixed(1)}%. ` +
        `The strategy may have memorized historical patterns that don't generalize.`
      );
    }

    if (outOfSample.maxDrawdown > inSample.maxDrawdown * 2) {
      warnings.push(
        `Out-of-sample max drawdown (${outOfSample.maxDrawdown.toFixed(1)}%) is significantly ` +
        `worse than in-sample (${inSample.maxDrawdown.toFixed(1)}%) — another overfitting signal.`
      );
    }
  }

  if (inSample.maxDrawdown > 30) {
    warnings.push(
      `High max drawdown (${inSample.maxDrawdown.toFixed(1)}%) — could you stomach ` +
      `losing ${inSample.maxDrawdown.toFixed(0)}% from peak?`
    );
  }

  return {
    strategyId: spec.id,
    pair: spec.pair,
    config: cfg,
    dataRange: {
      from: firstTs,
      to: lastTs,
      bars: totalBars,
      days: Math.round(dataDays),
    },
    inSample,
    outOfSample,
    equityCurve: fullEquity,
    tradeLog: allTrades,
    warnings,
    completedAt: Date.now(),
  };
}
