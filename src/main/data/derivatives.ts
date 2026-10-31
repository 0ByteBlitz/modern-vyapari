/**
 * Aggregates derivatives data across venues for the `get_derivatives_metrics`
 * chat tool: Binance (CEX, USDT-margined futures) and Hyperliquid (DEX,
 * on-chain perps), plus Hyperliquid's cross-venue predicted-funding
 * comparison. Each source is fetched independently (Promise.allSettled) so
 * one failing — wrong symbol, network hiccup, coin not listed on that venue
 * — never blocks the others. Never throws; failures surface as entries in
 * `errors` while whatever data did come back is still returned.
 */

import * as binance from "./binance-derivatives";
import * as hyperliquid from "./hyperliquid";

export interface CombinedDerivativesMetrics {
  symbol: string;
  binance: {
    openInterest: Awaited<ReturnType<typeof binance.getOpenInterest>> | null;
    fundingRate: Awaited<ReturnType<typeof binance.getFundingRate>> | null;
  } | null;
  hyperliquid: hyperliquid.HyperliquidPerpMetrics | null;
  /** Predicted funding rate for this coin across multiple venues (as reported
   *  by Hyperliquid) — a built-in cross-venue divergence signal. */
  predictedFundingByVenue: Record<string, { fundingRate: string; nextFundingTime: number }> | null;
  errors: string[];
}

function reasonToMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export async function getCombinedDerivativesMetrics(symbol: string): Promise<CombinedDerivativesMetrics> {
  const [binanceResult, hlResult, predictedResult] = await Promise.allSettled([
    binance.getDerivativesMetrics(symbol),
    hyperliquid.getPerpMetrics(symbol),
    hyperliquid.getPredictedFundingComparison(symbol),
  ]);

  const errors: string[] = [];

  let binanceData: CombinedDerivativesMetrics["binance"] = null;
  if (binanceResult.status === "fulfilled") {
    binanceData = { openInterest: binanceResult.value.openInterest, fundingRate: binanceResult.value.fundingRate };
    errors.push(...binanceResult.value.errors.map((e) => `binance ${e}`));
  } else {
    errors.push(`binance: ${reasonToMessage(binanceResult.reason)}`);
  }

  let hyperliquidData: CombinedDerivativesMetrics["hyperliquid"] = null;
  if (hlResult.status === "fulfilled") {
    hyperliquidData = hlResult.value;
    if (hyperliquidData === null) errors.push("hyperliquid: no perp listed for this symbol");
  } else {
    errors.push(`hyperliquid: ${reasonToMessage(hlResult.reason)}`);
  }

  let predictedFunding: CombinedDerivativesMetrics["predictedFundingByVenue"] = null;
  if (predictedResult.status === "fulfilled") {
    predictedFunding = predictedResult.value;
  } else {
    errors.push(`predicted funding comparison: ${reasonToMessage(predictedResult.reason)}`);
  }

  return { symbol, binance: binanceData, hyperliquid: hyperliquidData, predictedFundingByVenue: predictedFunding, errors };
}
