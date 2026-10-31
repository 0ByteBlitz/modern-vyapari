/**
 * The execution venue, and the basis between it and the analysis feed
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as basisMonitor from "../data/basis-monitor";
import { venue, venueCapabilities, listVenues } from "../integrations/venue/registry";
import { appMode } from "../modes/app-mode";
import { getTickerSnapshot } from "../data/analysis-candles";
import { safe } from "./safe";

/**
 * The one definition of "pairs a session can be created for".
 *
 * Exported because `sessions:create` must validate against exactly this set —
 * validating against the venue while the picker listed feed symbols is how
 * simulated mode came to offer pairs it then refused to create.
 */
export async function tradablePairs(): Promise<Record<string, { base: string; quote: string; status: string }>> {
  if (appMode() === "simulated") {
    const snapshot = await getTickerSnapshot();
    /* Shaped like the venue's map so one caller serves both modes. */
    const out: Record<string, { base: string; quote: string; status: string }> = {};
    for (const t of snapshot) {
      const [base, quote] = t.symbol.split("-");
      if (base && quote) out[t.symbol] = { base, quote, status: "active" };
    }
    return out;
  }
  return venue().getPairs() as Promise<Record<string, { base: string; quote: string; status: string }>>;
}

export function registerVenue(): void {
ipcMain.handle("venue:balances", () => safe(() => venue().getBalances(), "venue:balances"));

ipcMain.handle(
    "venue:candles",
    (_e, symbol: string, intervalMinutes: number, sinceMs?: number, untilMs?: number) =>
      safe(() => {
        if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(symbol)) throw new Error("Invalid symbol format (expected e.g. BTC-USD)");
        if (![1, 5, 15, 30, 60, 240, 1440].includes(intervalMinutes)) throw new Error("Unsupported interval");
        return venue().getCandlesForReconciliation(symbol, intervalMinutes, sinceMs, untilMs);
      }, "venue:candles")
  );

ipcMain.handle("venue:tickers", (_e, symbols?: string[]) => safe(() => venue().getTickers(symbols), "venue:tickers"));

ipcMain.handle("venue:pairs", () => safe(() => venue().getPairs(), "venue:pairs"));

  /**
   * Pairs a session can be created for — a different question from "what does
   * the venue trade", and the two diverge the moment simulated mode exists.
   *
   * In **live** mode the venue is the authority: a pair it will not trade is
   * one no order can reach.
   *
   * In **simulated** mode there is no venue, and the paper adapter correctly
   * says so by returning nothing. That emptied the session picker and then made
   * `sessions:create` refuse every pair — a regression introduced with app
   * modes. The honest universe in simulated mode is **what the analysis feed
   * can chart**, because that is precisely what the engine can resolve levels
   * against and fill against. Asking the venue was always asking the wrong
   * question here; it only looked right while there was exactly one mode.
   */
  ipcMain.handle("pairs:tradable", () => safe(() => tradablePairs(), "pairs:tradable"));

  /* What the active venue is and what it can do. Ids, a display name and
     booleans only — no credential material, and nothing that could be mistaken
     for one. The renderer uses `displayName` instead of hardcoding "RevX", so
     an execution-truth label stays true when the venue changes. */
ipcMain.handle("venue:info", () =>
    safe(() => ({ active: venueCapabilities(), available: listVenues() }), "venue:info")
  );

  /* ── Basis monitor (RevX vs. Binance, read-only) ──────────── */
ipcMain.handle("basis:stats", (_e, symbol: string, sinceMs?: number) =>
    safe(() => basisMonitor.getBasisStats(symbol, sinceMs), "basis:stats")
  );
}
