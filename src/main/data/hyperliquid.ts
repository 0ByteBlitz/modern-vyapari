/**
 * Free, keyless perpetuals data from Hyperliquid's public info API — a
 * decentralized (on-chain) derivatives venue, distinct from Binance's
 * centralized order book. Funding/OI here can diverge meaningfully from CEX
 * data during volatile periods, so pairing the two (see data/derivatives.ts)
 * gives a genuine cross-venue signal rather than two views of the same
 * market. No API key, no wallet — public market data only.
 */

const INFO_URL = "https://api.hyperliquid.xyz/info";

async function postInfo(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hyperliquid API error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }
  return res.json();
}

interface HlAssetCtx {
  dayNtlVlm: string;
  funding: string;
  markPx: string;
  midPx: string;
  openInterest: string;
  oraclePx: string;
  premium: string | null;
  prevDayPx: string;
}

/** "BTC-USD" / "ETH-USDT" -> "BTC" (Hyperliquid coin names are bare base assets). */
function toCoin(symbol: string): string {
  return (symbol.split("-")[0] || symbol).toUpperCase();
}

export interface HyperliquidPerpMetrics {
  coin: string;
  markPrice: string;
  fundingRate: string; // per-funding-interval rate, not annualized
  openInterest: string;
  dayNotionalVolume: string;
  change24h: number | null; // percent, derived from markPx vs prevDayPx
}

/**
 * One call (metaAndAssetCtxs) returns funding/OI/price for every Hyperliquid
 * perp at once — we fetch the full set and pick out the requested coin.
 * Returns null (not an error) if the coin isn't listed on Hyperliquid.
 */
export async function getPerpMetrics(symbol: string): Promise<HyperliquidPerpMetrics | null> {
  const coin = toCoin(symbol);
  const [meta, assetCtxs] = (await postInfo({ type: "metaAndAssetCtxs" })) as [
    { universe: { name: string }[] },
    HlAssetCtx[],
  ];

  const idx = meta.universe.findIndex((u) => u.name === coin);
  if (idx === -1) return null;
  const ctx = assetCtxs[idx];
  if (!ctx) return null;

  const mark = parseFloat(ctx.markPx);
  const prevDay = parseFloat(ctx.prevDayPx);
  const change24h = prevDay > 0 ? ((mark - prevDay) / prevDay) * 100 : null;

  return {
    coin,
    markPrice: ctx.markPx,
    fundingRate: ctx.funding,
    openInterest: ctx.openInterest,
    dayNotionalVolume: ctx.dayNtlVlm,
    change24h,
  };
}

/** Cross-venue predicted funding rate for one coin (Binance/Bybit/Hyperliquid/...),
 *  keyed by venue name as Hyperliquid reports it (e.g. "BinPerp", "HlPerp", "BybitPerp"). */
export async function getPredictedFundingComparison(
  symbol: string
): Promise<Record<string, { fundingRate: string; nextFundingTime: number }> | null> {
  const coin = toCoin(symbol);
  const data = (await postInfo({ type: "predictedFundings" })) as [
    string,
    [string, { fundingRate: string; nextFundingTime: number }][],
  ][];

  const entry = data.find(([c]) => c === coin);
  if (!entry) return null;

  const result: Record<string, { fundingRate: string; nextFundingTime: number }> = {};
  for (const [venue, info] of entry[1]) {
    result[venue] = info;
  }
  return result;
}
