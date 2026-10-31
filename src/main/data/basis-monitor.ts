/**
 * Basis monitor — measures the gap between the analysis feed and the
 * execution venue.
 *
 * Why this exists: strategies are designed, backtested, and paper-traded on
 * BINANCE prices, but they will execute on REVOLUT X. On thin alts those two
 * books disagree, and Revolut X's spread is a real cost that a Binance-priced
 * backtest silently omits. Until this is measured, "the strategy is
 * profitable" means "profitable on a venue we don't trade on".
 *
 * So every sample records three numbers per pair:
 *   revx_spread_bps — cost of crossing Revolut X's book (the thing that eats
 *                     a scalping strategy alive)
 *   bin_spread_bps  — the same on Binance, for comparison
 *   basis_bps       — how far Revolut X's mid sits from Binance's mid
 *
 * `getBasisStats()` turns the samples into a median/p90, which is what belongs
 * in a backtest's slippage config. Nothing here places orders or influences
 * the engine; it only observes.
 */
import { getDb, auditLog } from "../db/database";
import { venue } from "../integrations/venue/registry";
import { listSessions } from "../sessions/service";
import * as credentials from "../security/credentials";
import type { BasisStats } from "../../shared/ipc-types";
import { createLogger } from "../logger";
import { toFeedSymbol } from "../integrations/feed/symbols";

const log = createLogger("basis");

// Shape lives in the shared IPC contract.
export type { BasisStats };

/** How often to sample. Slow on purpose — spread is a distribution to build up
 *  over days, not a live readout, and Revolut X has rate limits. */
const SAMPLE_INTERVAL_MS = 60_000;

/** Binance public book ticker — no API key required. */
const BINANCE_BOOK_URL = "https://api.binance.com/api/v3/ticker/bookTicker";

export interface BasisSample {
  symbol: string;
  revxBid: number;
  revxAsk: number;
  revxMid: number;
  binBid: number;
  binAsk: number;
  binMid: number;
  revxSpreadBps: number;
  binSpreadBps: number;
  basisBps: number;
  sampledAt: number;
}


function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return ((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Binance's best bid/ask for the pair's base asset against USDT. */
async function fetchBinanceBook(symbol: string): Promise<{ bid: number; ask: number } | null> {
  const base = symbol.split("-")[0];
  if (!base) return null;

  const feedSymbol = toFeedSymbol(`${base}-USD`);
  if (!feedSymbol) return null;
  const res = await fetch(`${BINANCE_BOOK_URL}?symbol=${feedSymbol}`);
  if (!res.ok) return null;

  const data = (await res.json()) as { bidPrice?: string; askPrice?: string };
  const bid = parseFloat(data.bidPrice ?? "");
  const ask = parseFloat(data.askPrice ?? "");
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;

  return { bid, ask };
}

/**
 * Take one sample for a symbol and persist it. Returns null (and writes
 * nothing) when either venue can't be read, or when the pair's quote currency
 * isn't USD — a GBP pair would need an FX conversion, which would make the
 * measured basis a mix of real basis and FX error.
 */
export async function sampleBasis(symbol: string): Promise<BasisSample | null> {
  const quote = symbol.split("-")[1];
  if (quote !== "USD" && quote !== "USDT") {
    // Deliberately skipped rather than silently FX-converted.
    return null;
  }

  const [revxRes, binBook] = await Promise.allSettled([
    venue().getTickers([symbol]),
    fetchBinanceBook(symbol),
  ]);

  if (revxRes.status !== "fulfilled" || binBook.status !== "fulfilled" || !binBook.value) return null;

  const ticker = revxRes.value.find((t) => t.symbol.replace("/", "-") === symbol);
  if (!ticker) return null;

  const revxBid = parseFloat(ticker.bid);
  const revxAsk = parseFloat(ticker.ask);
  if (!Number.isFinite(revxBid) || !Number.isFinite(revxAsk) || revxBid <= 0 || revxAsk <= 0) return null;

  const revxMid = (revxBid + revxAsk) / 2;
  const { bid: binBid, ask: binAsk } = binBook.value;
  const binMid = (binBid + binAsk) / 2;

  const sample: BasisSample = {
    symbol,
    revxBid,
    revxAsk,
    revxMid,
    binBid,
    binAsk,
    binMid,
    revxSpreadBps: ((revxAsk - revxBid) / revxMid) * 10_000,
    binSpreadBps: ((binAsk - binBid) / binMid) * 10_000,
    basisBps: ((revxMid - binMid) / binMid) * 10_000,
    sampledAt: Date.now(),
  };

  getDb()
    .prepare(
      `INSERT INTO basis_samples (symbol, revx_bid, revx_ask, revx_mid, bin_bid, bin_ask, bin_mid,
                                  revx_spread_bps, bin_spread_bps, basis_bps, sampled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sample.symbol,
      String(sample.revxBid),
      String(sample.revxAsk),
      String(sample.revxMid),
      String(sample.binBid),
      String(sample.binAsk),
      String(sample.binMid),
      sample.revxSpreadBps,
      sample.binSpreadBps,
      sample.basisBps,
      sample.sampledAt
    );

  return sample;
}

/** Aggregate the samples for a symbol over a window (default: last 30 days). */
export function getBasisStats(symbol: string, sinceMs?: number): BasisStats {
  const since = sinceMs ?? Date.now() - 30 * 24 * 60 * 60 * 1000;

  const rows = getDb()
    .prepare(
      `SELECT revx_spread_bps, bin_spread_bps, basis_bps, sampled_at FROM basis_samples
       WHERE symbol = ? AND sampled_at >= ? ORDER BY sampled_at ASC`
    )
    .all(symbol, since) as any[];

  if (rows.length === 0) {
    return {
      symbol,
      sampleCount: 0,
      from: null,
      to: null,
      medianRevxSpreadBps: null,
      p90RevxSpreadBps: null,
      medianBinSpreadBps: null,
      medianBasisBps: null,
      maxAbsBasisBps: null,
    };
  }

  const revxSpreads = rows.map((r) => r.revx_spread_bps as number).sort((a, b) => a - b);
  const binSpreads = rows.map((r) => r.bin_spread_bps as number).sort((a, b) => a - b);
  const basis = rows.map((r) => r.basis_bps as number).sort((a, b) => a - b);

  return {
    symbol,
    sampleCount: rows.length,
    from: rows[0].sampled_at,
    to: rows[rows.length - 1].sampled_at,
    medianRevxSpreadBps: median(revxSpreads),
    p90RevxSpreadBps: percentile(revxSpreads, 90),
    medianBinSpreadBps: median(binSpreads),
    medianBasisBps: median(basis),
    maxAbsBasisBps: Math.max(...basis.map((b) => Math.abs(b))),
  };
}

/**
 * Slippage estimate for a backtest, in bps, derived from measured data.
 *
 * Crossing the spread costs roughly half of it per side, so half the median
 * RevX spread is the honest floor. Returns null when there aren't enough
 * samples to say anything — callers must fall back to their default rather
 * than treat a thin sample as fact.
 */
export function measuredSlippageBps(symbol: string, minSamples = 30): number | null {
  const stats = getBasisStats(symbol);
  if (stats.sampleCount < minSamples || stats.medianRevxSpreadBps === null) return null;
  return stats.medianRevxSpreadBps / 2;
}

/* ── Scheduler ────────────────────────────────────────────────────────── */

let timer: NodeJS.Timeout | null = null;

/** Pairs worth sampling: those with a non-archived session. */
function watchedSymbols(): string[] {
  try {
    return Array.from(new Set(listSessions(false).map((s) => s.pair)));
  } catch {
    return [];
  }
}

async function tick(): Promise<void> {
  /* hasApiKey, not getApiKey: the getter THROWS when no key is saved, so this
     guard was itself the crash — an unhandled rejection at every startup on a
     fresh install. It also decrypted the key once a minute just to test for it;
     the existence check needs no secret. */
  if (!credentials.hasApiKey()) return; // Revolut X not configured yet

  for (const symbol of watchedSymbols()) {
    try {
      await sampleBasis(symbol);
    } catch (err) {
      // Never let a sampling failure surface — this is passive observation.
      log.error(`Sample failed for ${symbol}:`, err);
    }
  }
}

export function startBasisMonitor(): void {
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), SAMPLE_INTERVAL_MS);
  auditLog("basis_monitor_started", { intervalMs: SAMPLE_INTERVAL_MS });
  log.info("Monitor started.");
}

export function stopBasisMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
