/**
 * The single source of candle data for ANALYSIS.
 *
 * Feed roles (owner decision, 2026-07-26):
 *   • Binance  → analysis. Charts, indicators, backtests, paper fills, strategy
 *                triggers. One feed means a chart can never disagree with the
 *                engine that traded on it.
 *   • Revolut X → execution and reconciliation truth. Balances, orders, fills,
 *                and startup reconciliation. NOT a charting source.
 *
 * Anything drawn on a chart or fed to an indicator must come from here, so
 * there is exactly one cached history per symbol/interval. Mixing feeds inside
 * one computation was the fidelity bug this module exists to prevent.
 *
 * Note the residual basis risk this does NOT solve: strategies are validated
 * on Binance prices but will execute on Revolut X, whose book on thin alts is
 * different. That gap belongs to the basis monitor (pre-Phase 4), not here.
 */
import { getDb } from "../db/database";
import { backfillFromBinance, syncRecentFromBinance } from "../insights/indicators";
import { createLogger } from "../logger";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

const log = createLogger("candles");

/** Wire shape — matches the renderer's `Candle`. Money stays stringly-typed. */
export interface CandleDto {
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  /**
   * Taker (aggressor) BUY base volume for the bar — the ingredient CVD and the
   * profile's buy/sell split need.
   *
   * `null` means **unknown**, which is the normal state for any bar cached
   * before schema v11. It must never be read as 0: delta is
   * `2 × takerBuy − volume`, so a missing value treated as zero becomes
   * `−volume` — a bar of pure aggressive selling that never happened.
   */
  takerBuyVolume?: string | null;
}

export const SUPPORTED_INTERVALS = [1, 5, 15, 30, 60, 240, 1440] as const;

/* ── 24h ticker snapshot (REST) ──────────────────────────────────────── */

export interface TickerSnapshot {
  symbol: string;   // app form, e.g. "BTC-USD"
  price: number;
  change24h: number;
  volume24h: number;
}

const LEVERAGED_RE = /(UP|DOWN|BULL|BEAR)USDT$/;
const NON_TRENDING = new Set([
  "USDC", "BUSD", "TUSD", "DAI", "FDUSD", "USDP", "PAX", "UST", "USTC",
  "EUR", "GBP", "AUD", "TRY", "BRL", "RUB", "ZAR", "JPY",
]);

/**
 * One-shot 24h ticker snapshot from Binance REST.
 *
 * The market list used to depend entirely on the `!ticker@arr` websocket
 * firehose, which meant an empty page until the first frame arrived — and a
 * permanently empty page if the socket never connected. This gives the list
 * something to paint immediately; the stream then keeps it live.
 */
export async function getTickerSnapshot(): Promise<TickerSnapshot[]> {
  const res = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  if (!res.ok) throw new Error(`Binance 24h ticker failed: ${res.status} ${res.statusText}`);

  const rows = (await res.json()) as Array<{ symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }>;

  return rows
    .filter((r) => {
      if (!r.symbol?.endsWith("USDT")) return false;
      if (LEVERAGED_RE.test(r.symbol)) return false;
      return !NON_TRENDING.has(r.symbol.slice(0, -4));
    })
    .map((r) => ({
      symbol: `${r.symbol.slice(0, -4)}-USD`,
      price: parseFloat(r.lastPrice),
      change24h: parseFloat(r.priceChangePercent),
      volume24h: parseFloat(r.quoteVolume),
    }))
    .filter((t) => Number.isFinite(t.price) && Number.isFinite(t.volume24h));
}

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 1500;

/**
 * Cached Binance candles for a symbol/interval, newest last, auto-backfilled
 * from Binance REST when the local cache is short.
 *
 * @param symbol       App-form pair, e.g. "ARB-USD".
 * @param intervalMin  One of SUPPORTED_INTERVALS.
 * @param limit        Bars to return (default 300, capped at 1500).
 */
export async function getAnalysisCandles(
  symbol: string,
  intervalMin: number,
  limit = DEFAULT_LIMIT
): Promise<CandleDto[]> {
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(symbol)) {
    throw new Error("Invalid symbol format (expected e.g. BTC-USD)");
  }
  if (!(SUPPORTED_INTERVALS as readonly number[]).includes(intervalMin)) {
    throw new Error(`Unsupported interval: ${intervalMin}`);
  }

  // Binance quotes in USDT. A non-USD quote pair would need FX conversion,
  // which this app deliberately does not do — see binance-ws.ts. Fail loudly
  // rather than serve a price that is silently in the wrong currency.
  const quote = symbol.split("-")[1];
  if (quote !== "USD" && quote !== "USDT") {
    throw new Error(
      `${symbol} has a non-USD quote currency. Analysis is Binance/USDT-only — ` +
        `use the USD pair for this asset instead.`
    );
  }

  const bars = Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
  const db = getDb();
  const barMs = intervalMin * 60_000;

  /* ── Coverage check ──────────────────────────────────────────────────
     A total row count says nothing about whether the WINDOW we're about to
     return is contiguous, and that's what actually matters.

     The cache is written by two sources with different shapes: the WS stream
     appends bars only while the app is open and that pair is subscribed, and
     REST backfill writes contiguous blocks. Run the app for an hour, close
     it for two days, open it again, and a 15m series ends up as islands of
     bars separated by holes. "Newest 120 rows" then spans a fortnight, and
     the chart draws them as if they were consecutive — which is why short
     intervals looked wrong while 1D (one dense backfill covers years) looked
     fine.

     So: check how much of the requested time window is actually present, and
     re-sync the whole window if it's patchy. Upserts make that idempotent. */
  const windowStart = Date.now() - bars * barMs;
  const expected = bars;

  const coverage = db
    .prepare(
      `SELECT COUNT(*) AS c, MAX(start_ms) AS newest FROM candles
       WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL} AND start_ms >= ?`
    )
    .get(symbol, intervalMin, windowStart) as { c: number; newest: number | null };

  const present = coverage?.c ?? 0;
  const newest = coverage?.newest ?? null;
  const isPatchy = present < expected * 0.9;
  const isStale = newest === null || Date.now() - newest > barMs * 2;

  if (isPatchy || isStale) {
    try {
      const written = await syncRecentFromBinance(symbol, intervalMin, windowStart);
      log.info(`${symbol} ${intervalMin}m ${isPatchy ? "had gaps" : "was stale"} ` +
          `(${present}/${expected} bars) — synced ${written}.`
      );
    } catch (err) {
      log.error(`Window sync failed for ${symbol} ${intervalMin}m:`, err);
    }
  }

  // Deep history for indicators/backtests that ask for more than the window
  // holds. Only reaches out when the cache genuinely can't satisfy the count.
  const total = db
    .prepare(
      `SELECT COUNT(*) AS c, MIN(start_ms) AS oldest FROM candles
       WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL}`
    )
    .get(symbol, intervalMin) as { c: number; oldest: number | null };

  if ((total?.c ?? 0) < bars) {
    try {
      await backfillFromBinance(symbol, intervalMin, bars - (total?.c ?? 0) + 50, total?.oldest ?? null);
    } catch (err) {
      // Serve whatever is cached rather than failing the chart outright.
      log.error(`Backfill failed for ${symbol} ${intervalMin}m:`, err);
    }
  }

  // Newest N, then flip to ascending for charting/indicator use.
  const rows = db
    .prepare(
      `SELECT start_ms, open, high, low, close, volume, taker_buy_volume FROM candles
       WHERE symbol = ? AND interval_min = ? AND ${FEED_SCOPE_SQL}
       ORDER BY start_ms DESC LIMIT ?`
    )
    .all(symbol, intervalMin, bars) as any[];

  const result: CandleDto[] = rows
    .reverse()
    .map((r) => ({
      start: r.start_ms,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      takerBuyVolume: r.taker_buy_volume ?? null,
    }));

  try {
    const { alertEngine } = require("../insights/alert-engine");
    const numericCandles = result.map((c) => ({
      timestamp: c.start,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
      takerBuyVolume:
        c.takerBuyVolume === null || c.takerBuyVolume === undefined ? null : parseFloat(c.takerBuyVolume),
    }));
    alertEngine.evaluateHistoricalCandles(symbol, intervalMin, numericCandles);
  } catch (err) {
    log.error("Historical alert evaluation failed", err);
  }

  return result;
}
