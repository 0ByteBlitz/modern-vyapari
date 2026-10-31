import { signRequest } from "./signing";
import { getApiKey, getPrivateKeyPem } from "../security/credentials";

/**
 * Read-only Revolut X REST client (Phase 0).
 * Base URL: https://revx.revolut.com/api/1.0
 * Order placement is deliberately absent until Phase 4 (risk engine first).
 */

const BASE = "https://revx.revolut.com";
const API_PREFIX = "/api/1.0";

export interface Balance {
  currency: string;
  available: string;
  reserved: string;
  staked?: string;
  total: string;
}

export interface Candle {
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

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

class RevXError extends Error {
  constructor(
    public status: number,
    public body: string
  ) {
    super(`Revolut X API error ${status}: ${body.slice(0, 300)}`);
  }
}

async function request<T>(method: "GET", pathAfterPrefix: string, query = ""): Promise<T> {
  const timestamp = Date.now().toString();
  const apiPath = `${API_PREFIX}${pathAfterPrefix}`;
  const signature = signRequest(getPrivateKeyPem(), timestamp, method, apiPath, query, "");
  const url = `${BASE}${apiPath}${query ? `?${query}` : ""}`;

  const res = await fetch(url, {
    method,
    headers: {
      "X-Revx-API-Key": getApiKey(),
      "X-Revx-Timestamp": timestamp,
      "X-Revx-Signature": signature,
    },
  });

  const text = await res.text();
  if (!res.ok) throw new RevXError(res.status, text);
  return JSON.parse(text) as T;
}

export async function getBalances(): Promise<Balance[]> {
  return request<Balance[]>("GET", "/balances");
}

export async function getCandles(
  symbol: string,
  intervalMinutes: number,
  sinceMs?: number,
  untilMs?: number
): Promise<Candle[]> {
  const params = new URLSearchParams();
  params.set("interval", String(intervalMinutes));
  if (sinceMs !== undefined) params.set("since", String(sinceMs));
  if (untilMs !== undefined) params.set("until", String(untilMs));
  const res = await request<{ data: Candle[] }>(
    "GET",
    `/candles/${encodeURIComponent(symbol)}`,
    params.toString()
  );
  return res.data;
}

export async function getTickers(symbols?: string[]): Promise<Ticker[]> {
  const query = symbols?.length ? `symbols=${encodeURIComponent(symbols.join(","))}` : "";
  const res = await request<{ data: Ticker[] }>("GET", "/tickers", query);
  return res.data;
}

export async function getPairsConfig(): Promise<Record<string, PairConfig>> {
  return request<Record<string, PairConfig>>("GET", "/configuration/pairs");
}
