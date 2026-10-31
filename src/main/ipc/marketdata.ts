/**
 * Analysis candles, live streams, coverage repair, derivatives
 *
 * Split out of the single `ipc.ts` switchboard on 2026-08-05. Each domain
 * registers its own channels and imports only its own services, so `index.ts`
 * is a list of registrations rather than the one module that transitively
 * pulls in every subsystem in the app.
 */
import { ipcMain } from "electron";
import * as candleRepair from "../data/candle-repair";
import * as derivatives from "../data/derivatives";
import { binanceWS } from "../data/binance-ws";
import { emitTo } from "../events/outbound";
import { getAnalysisCandles, getTickerSnapshot } from "../data/analysis-candles";
import { venue } from "../integrations/venue/registry";
import { safe } from "./safe";

export function registerMarketdata(): void {
  /* Analysis candles — Binance-only, the single charting/indicator feed.
     `venue:candles` above is kept for reconciliation against the venue, not
     for charts. New chart code must use this handler. */
ipcMain.handle("candles:analysis", (_e, symbol: string, intervalMinutes: number, limit?: number) =>
    safe(() => getAnalysisCandles(symbol, intervalMinutes, limit), "candles:analysis")
  );

  /* Binance 24h snapshot — first paint for the market list, and the fallback
     when the ticker websocket can't connect. */
ipcMain.handle("candles:tickerSnapshot", () => safe(() => getTickerSnapshot(), "candles:tickerSnapshot"));

  /* Cross-venue derivatives (Binance futures + Hyperliquid perps). Already
     available to the agent as a tool; this exposes the same data to the UI. */
ipcMain.handle("derivatives:get", (_e, symbol: string) =>
    safe(() => derivatives.getCombinedDerivativesMetrics(symbol), "derivatives:get")
  );

ipcMain.on("binance:subscribeCandles", (e, symbol: string, intervalMinutes: number) => {
    binanceWS.subscribe(symbol, intervalMinutes, e.sender);
  });

ipcMain.on("binance:unsubscribeCandles", (e, symbol: string, intervalMinutes: number) => {
    binanceWS.unsubscribe(symbol, intervalMinutes, e.sender);
  });

ipcMain.on("binance:subscribeTickers", (e) => {
    binanceWS.subscribeTickers(e.sender);
  });

ipcMain.on("binance:unsubscribeTickers", (e) => {
    binanceWS.unsubscribeTickers(e.sender);
  });

  /* ── Candle history coverage + repair (S1-3) ──────────────── */
ipcMain.handle("candles:coverage", () =>
    safe(() => candleRepair.listCandleCoverage(), "candles:coverage")
  );

ipcMain.handle("candles:repair", (e, symbol?: string, intervalMin?: number) =>
    safe(async () => {
      /* Progress is pushed rather than polled, and sanitised at this boundary
         like every other main → renderer channel: it carries only symbol,
         interval and counters, never an error or a path. */
      const emit = (p: candleRepair.CandleRepairProgress) => {
        emitTo(e.sender, "candles:repairProgress", p);
      };

      return symbol && intervalMin
        ? [await candleRepair.repairCandleHistory(symbol, intervalMin, emit)]
        : await candleRepair.repairAllCandleHistory(emit);
    }, "candles:repair")
  );
}
