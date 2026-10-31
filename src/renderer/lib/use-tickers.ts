import { useEffect, useMemo, useState } from "react";
import { api, isError, errorText } from "@/lib/api";

/**
 * Market data comes from Binance ONLY (owner decision, 2026-07-26).
 *
 * Revolut X is an execution venue, not a data source. It contributes exactly
 * one thing here: which pairs can actually be traded. So instead of polling
 * Revolut tickers every 5s for prices we already have (and which carried no
 * volume or 24h-change field anyway), we read its pair list once and use it
 * as a tradability flag on the Binance rows.
 */
export interface MarketTicker {
  /** Always "BASE-USD" — Binance USDT pairs normalized to the app's dash
   *  convention (treating USDT ≈ USD) so it's directly usable as a
   *  CandlesCard/IPC symbol. */
  symbol: string;
  price: number;
  /** 24h change, percent (e.g. 5.5 for 5.5%). Native Binance field. */
  change24h: number;
  /** 24h quote volume in USDT. Native Binance field. */
  volume24h: number;
  /** True when this base asset is listed on Revolut X, i.e. the bot could
   *  actually execute here. Purely an execution-venue annotation — it never
   *  affects the price, volume, or change figures above. */
  tradableOnVenue: boolean;
}

export function useTickers() {
  const [rawTickers, setRawTickers] = useState<Omit<MarketTicker, "tradableOnVenue">[]>([]);
  const [tradableBases, setTradableBases] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** True once a websocket frame has arrived — the list is live, not a snapshot. */
  const [streaming, setStreaming] = useState(false);

  /* First paint from REST. The page used to depend entirely on the websocket
     firehose, so it sat on "Loading markets…" forever if the socket never
     connected — which is exactly what happened. */
  useEffect(() => {
    let active = true;
    void (async () => {
      const res = await api.getTickerSnapshot();
      if (!active) return;
      if (isError(res)) {
        setError(errorText(res));
        setLoading(false);
        return;
      }
      setRawTickers(res);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  /* Revolut X pair list — fetched once. It's venue configuration, not market
     data, so it does not need polling. */
  useEffect(() => {
    let active = true;
    void (async () => {
      const res = await api.getPairs();
      if (!active || isError(res)) return;
      const bases = new Set<string>();
      for (const [key, cfg] of Object.entries(res)) {
        if (cfg.status !== "active") continue;
        const base = key.replace("/", "-").split("-")[0];
        if (base) bases.add(base.toUpperCase());
      }
      setTradableBases(bases);
    })();
    return () => {
      active = false;
    };
  }, []);

  /* Binance ticker stream — the single source of prices, volume, and change. */
  useEffect(() => {
    let active = true;
    api.subscribeBinanceTickers();

    const unsubscribe = api.onBinanceTickerUpdate((data) => {
      if (!active) return;
      try {
        setLoading(false);
        setStreaming(true);
        setError("");
        // Main process already filters to comparable USDT spot pairs
        // (binance-ws.ts); the endsWith check is defence-in-depth.
        setRawTickers(
          data
            .filter((t: any) => typeof t.s === "string" && t.s.endsWith("USDT"))
            .map((t: any) => ({
              symbol: `${t.s.slice(0, -4)}-USD`, // "BTCUSDT" -> "BTC-USD"
              price: parseFloat(t.c),
              change24h: parseFloat(t.P),
              volume24h: parseFloat(t.q),
            }))
        );
      } catch {
        /* malformed frame — drop it, the next tick replaces the snapshot */
      }
    });

    return () => {
      active = false;
      unsubscribe();
      api.unsubscribeBinanceTickers();
    };
  }, []);

  const tickers = useMemo<MarketTicker[]>(
    () =>
      rawTickers.map((t) => ({
        ...t,
        tradableOnVenue: tradableBases.has(t.symbol.split("-")[0]?.toUpperCase() || ""),
      })),
    [rawTickers, tradableBases]
  );

  return { tickers, loading, error, streaming, tradableCount: tradableBases.size };
}
