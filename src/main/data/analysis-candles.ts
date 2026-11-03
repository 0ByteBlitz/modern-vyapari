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
import { FEED_SCOPE_SQL, fromFeedSymbol } from "../integrations/feed/symbols";

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

  const rows = (await res.json()) as Array<{
    symbol: string;
    lastPrice: string;
    priceChangePercent: string;
    quoteVolume: string;
    closeTime: number;
  }>;

  /* Delisted pairs stay in this endpoint with their last 24h figures frozen —
     CREAM "+65.35%" and NFP "−65.85%" had led Markets' gainers and losers for
     27 days. Measured 2026-11-02: 257 of 776 USDT rows had not updated in over
     24h and every one was non-trading; every row updated within a day was
     trading. So a row older than a day is dropped — from Markets, Home's
     movers, and the pairs a session can be created for. */
  const fresh = Date.now() - 24 * 60 * 60 * 1000;

  /* Through `fromFeedSymbol`, the one conversion every symbol takes: it also
     drops bases the app's pair format can't hold, which this list used to
     offer and the chart then refused. */
  const out: TickerSnapshot[] = [];
  for (const r of rows) {
    const symbol = fromFeedSymbol(r.symbol);
    if (!symbol || LEVERAGED_RE.test(r.symbol) || NON_TRENDING.has(r.symbol.slice(0, -4))) continue;
    if (!(r.closeTime >= fresh)) continue;
    const t = {
      symbol,
      price: parseFloat(r.lastPrice),
      change24h: parseFloat(r.priceChangePercent),
      volume24h: parseFloat(r.quoteVolume),
    };
    if (Number.isFinite(t.price) && Number.isFinite(t.volume24h)) out.push(t);
  }
  return out;
}

/**
 * One round trip to the analysis feed, in milliseconds. Throws when it doesn't
 * answer.
 *
 * For health readouts. They used to time a candle read, which the local cache
 * answers in ~0 ms whether or not the feed is reachable — "Binance 0.0s"
 * while offline. The ping endpoint is the lightest call the feed has.
 */
export async function pingFeed(): Promise<number> {
  const t0 = Date.now();
  const res = await fetch("https://api.binance.com/api/v3/ping");
  if (!res.ok) throw new Error(`Binance ping failed: ${res.status} ${res.statusText}`);
  return Date.now() - t0;
}

const DEFAULT_LIMIT = 300;
/** The most bars one call serves — and so the longest gap the alert catch-up can check. */
export const MAX_LIMIT = 1500;

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

  return result;
}
