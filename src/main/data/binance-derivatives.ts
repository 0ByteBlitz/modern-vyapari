/**
 * Free, keyless derivatives market data from Binance's public Futures API —
 * replaces the Coinglass tool (which has no free tier as of 2026 and was
 * targeting a deprecated v2 endpoint anyway). Same exchange the app already
 * pulls candles from via binance-ws.ts, so no new trust boundary or secret.
 *
 * Trade-off vs. Coinglass: this is Binance-only positioning data, not
 * aggregated across exchanges. For a Revolut X spot bot that's a reasonable
 * proxy for market-wide sentiment, not a claim of venue-matched data.
 */

import { toFeedSymbol } from "../integrations/feed/symbols";

const FUTURES_BASE_URL = "https://fapi.binance.com";

/** "BTC-USD" / "ETH-USDT" -> "BTCUSDT" (Binance's USDT-margined perpetual symbol). */
function toFuturesSymbol(symbol: string): string {
  const base = symbol.split("-")[0] || symbol;
  return toFeedSymbol(`${base}-USD`) ?? `${base.toUpperCase()}USDT`;
}

async function fetchBinanceFutures(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${FUTURES_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.append(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance futures API error: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }
  return res.json();
}

export async function getOpenInterest(symbol: string): Promise<{ symbol: string; openInterest: string; timestamp: number }> {
  const futuresSymbol = toFuturesSymbol(symbol);
  const data = await fetchBinanceFutures("/fapi/v1/openInterest", { symbol: futuresSymbol });
  return { symbol: futuresSymbol, openInterest: data.openInterest, timestamp: data.time };
}

export async function getFundingRate(symbol: string): Promise<{
  symbol: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  timestamp: number;
}> {
  const futuresSymbol = toFuturesSymbol(symbol);
  // premiumIndex carries the current mark price plus the last settled /
  // next-scheduled funding rate in one call (no auth required).
  const data = await fetchBinanceFutures("/fapi/v1/premiumIndex", { symbol: futuresSymbol });
  return {
    symbol: futuresSymbol,
    markPrice: data.markPrice,
    lastFundingRate: data.lastFundingRate,
    nextFundingTime: data.nextFundingTime,
    timestamp: data.time,
  };
}

/**
 * Fetches open interest and funding rate independently (not Promise.all) so
 * one failing — e.g. a pair with no Binance USDT-M futures listing — doesn't
 * take down the other. Never throws; failures are reported per-metric.
 */
export async function getDerivativesMetrics(symbol: string): Promise<{
  symbol: string;
  openInterest: Awaited<ReturnType<typeof getOpenInterest>> | null;
  fundingRate: Awaited<ReturnType<typeof getFundingRate>> | null;
  errors: string[];
}> {
  const [oiResult, fundingResult] = await Promise.allSettled([getOpenInterest(symbol), getFundingRate(symbol)]);

  const errors: string[] = [];

  const openInterest = oiResult.status === "fulfilled" ? oiResult.value : null;
  if (oiResult.status === "rejected") {
    errors.push(`open interest unavailable: ${oiResult.reason instanceof Error ? oiResult.reason.message : String(oiResult.reason)}`);
  }

  const fundingRate = fundingResult.status === "fulfilled" ? fundingResult.value : null;
  if (fundingResult.status === "rejected") {
    errors.push(`funding rate unavailable: ${fundingResult.reason instanceof Error ? fundingResult.reason.message : String(fundingResult.reason)}`);
  }

  return { symbol, openInterest, fundingRate, errors };
}
