import { WebContents } from "electron";
import { getDb, isDbReady } from "../db/database";
import { isNetworkDisabled, setNetworkDisabled } from "../net-guard";
import { createLogger } from "../logger";
import { toFeedSymbol, fromFeedSymbol, hasFeed } from "../integrations/feed/symbols";
import { emitTo } from "../events/outbound";
import { ListenerRegistry } from "../events/listener-registry";

const log = createLogger("binance-ws");

// Interval mappings between minutes and Binance strings
const INTERVAL_STRINGS: Record<number, string> = {
  1: "1m",
  5: "5m",
  15: "15m",
  30: "30m",
  60: "1h",
  240: "4h",
  1440: "1d",
};

function getBaseAndQuote(symbol: string): { base: string; quote: string } {
  const parts = symbol.split("-");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { base: parts[0], quote: parts[1] };
  }
  return { base: symbol, quote: "USD" };
}

// Leveraged tokens (BTCUPUSDT, ETHDOWNUSDT, ...) move in multiples of the
// underlying and aren't real spot positions — exclude from trending/gainers.
const LEVERAGED_TOKEN_RE = /(UP|DOWN|BULL|BEAR)USDT$/;

// Stablecoin-vs-USDT pairs (USDCUSDT, FDUSDUSDT, ...) and wrapped-fiat pairs
// trade huge nominal volume near 0% change and drown out real movers.
const NON_TRENDING_BASES = new Set([
  "USDC", "BUSD", "TUSD", "DAI", "FDUSD", "USDP", "PAX", "UST", "USTC",
  "EUR", "GBP", "AUD", "TRY", "BRL", "RUB", "ZAR", "JPY",
]);

/** Keep only liquid, comparable USDT spot pairs — drops cross pairs (ETHBTC),
 *  fiat pairs, leveraged tokens, and stablecoin noise from the !ticker@arr firehose. */
function isTrendableSymbol(binanceSymbol: string): boolean {
  const appSymbol = fromFeedSymbol(binanceSymbol);
  if (!appSymbol) return false;
  if (LEVERAGED_TOKEN_RE.test(binanceSymbol)) return false;
  const base = appSymbol.split("-")[0]!;
  return !NON_TRENDING_BASES.has(base);
}

/** The DB is gone (shutdown, or a test tore it down) while the socket is still
 *  delivering. Expected, and deliberately not logged — see `handleKline`. */
class NoDatabaseError extends Error {}

/** Taker (aggressor) buy base volume off a WS kline payload, or null when it's
 *  absent or not believable. Must be within [0, volume]; outside that the field
 *  is wrong, and a wrong delta is worse than a missing one. */
function takerBuyFromWs(k: any): number | null {
  if (k?.V === undefined || k?.V === null || k.V === "") return null;
  const tb = parseFloat(k.V);
  const vol = parseFloat(k.v);
  if (!Number.isFinite(tb) || tb < 0) return null;
  if (Number.isFinite(vol) && tb > vol * 1.000001) return null;
  return tb;
}

interface CandleUpdate {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Taker BUY base volume for the bar; null = unknown (never treat as 0 —
   *  that reads as delta = −volume, a bar of pure selling that never was). */
  takerBuyVolume?: number | null;
  /** True once Binance marks the kline final (`k.x`). Consumers that must not
   *  act on repainting data (paper engine signal evaluation) gate on this. */
  closed: boolean;
}

interface SubscriptionInfo {
  symbol: string;
  intervalMin: number;
  webContentsSet: Set<WebContents>;
  /** Refcount for non-UI subscribers (e.g. the alert engine) that need this
   *  stream kept alive independent of any renderer page having it open. */
  internalRefCount: number;
}

class BinanceWSManager {
  private ws: WebSocket | null = null;
  // Keyed by `${symbol}:${intervalMin}`
  private subscriptions = new Map<string, SubscriptionInfo>();
  private tickerWebContentsSet = new Set<WebContents>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;

  /* FX rate tracking was removed deliberately — see handleKline. Synthesizing
     a non-USD quote (BASEUSDT ÷ GBPUSDT) produced prices that disagreed with
     `backfillFromBinance`, which stores the raw USDT price for the same
     symbol key. Cached history for such a pair was half-converted and half
     not, with a step change wherever the two met. */

  // Track WebContents we've already attached a 'destroyed' listener to
  private attachedWebContents = new WeakSet<WebContents>();

  // Fired for every new candle on any active subscription (UI or internal),
  // regardless of whether a renderer page is currently displaying it. Used
  // by the alert engine so alerts evaluate even when nobody has that pair open.
  private candleListeners = new ListenerRegistry<[string, number, CandleUpdate]>("binance candle");

  /**
   * When true, `connect()` is a no-op — no socket is ever opened.
   *
   * Unit tests reach this layer indirectly: `alertEngine.addAlert()` takes an
   * internal subscription, which triggers `sendSubscriptionUpdate()`, which
   * connects. A test therefore opened a real WebSocket to Binance, and because
   * nothing released it, the socket outlived `cleanupTestDb()`, kept receiving
   * klines, and hit a closed database once per message — an endless
   * "Database not initialized" log, and an open handle that stopped
   * `node --test` from ever exiting.
   */
  private get offline(): boolean {
    return isNetworkDisabled();
  }

  /** Disable all outbound connections (tests, and any offline mode later). */
  public setOffline(offline: boolean): void {
    setNetworkDisabled(offline);
    if (offline) this.shutdown();
  }

  /** Close the socket, cancel pending timers, and drop every subscription.
   *  Leaves no open handles behind, so a host process can exit. */
  public shutdown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const socket = this.ws;
    this.ws = null;          // cleared first, so `onclose` won't schedule a reconnect
    if (socket) {
      try { (socket as any).close(); } catch { /* already closing */ }
    }
    this.subscriptions.clear();
    this.tickerWebContentsSet.clear();
    this.candleListeners.clear();
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws !== undefined && (this.ws as any).readyState === 1;
  }

  /** Handshake in flight. A watchdog must not mistake this for "down" and tear
   *  it up — on a slow link that restarts the connect forever. */
  public isConnecting(): boolean {
    return this.ws !== null && (this.ws as any).readyState === WebSocket.CONNECTING;
  }

  /** True when something actually wants data. With nothing subscribed, having
   *  no socket is the correct idle state, not a fault to repair. */
  public hasSubscribers(): boolean {
    return this.subscriptions.size > 0 || this.tickerWebContentsSet.size > 0;
  }

  /** True when a backoff reconnect is already pending. */
  public isReconnectPending(): boolean {
    return this.reconnectTimer !== null;
  }

  public reconnect(): void {
    if (this.ws) {
      try { (this.ws as any).close(); } catch {}
      this.ws = null;
    }
    this.connect();
  }

  /** Register a callback for every candle tick on any active subscription. Returns an unsubscribe function. */
  public onCandle(cb: (symbol: string, intervalMin: number, candle: CandleUpdate) => void): () => void {
    return this.candleListeners.add(cb);
  }

  private ensureWebContentsCleanup(webContents: WebContents) {
    if (this.attachedWebContents.has(webContents)) return;
    this.attachedWebContents.add(webContents);
    webContents.once("destroyed", () => {
      // Clean up all candle subscriptions for this webContents
      for (const sub of this.subscriptions.values()) {
        if (sub.webContentsSet.has(webContents)) {
          this.unsubscribe(sub.symbol, sub.intervalMin, webContents);
        }
      }
      // Clean up ticker subscription
      this.unsubscribeTickers(webContents);
    });
  }

  public subscribe(symbol: string, intervalMin: number, webContents: WebContents) {
    const key = `${symbol}:${intervalMin}`;
    let sub = this.subscriptions.get(key);
    if (!sub) {
      sub = { symbol, intervalMin, webContentsSet: new Set(), internalRefCount: 0 };
      this.subscriptions.set(key, sub);
      this.sendSubscriptionUpdate();
    }
    sub.webContentsSet.add(webContents);
    this.ensureWebContentsCleanup(webContents);
  }

  public unsubscribe(symbol: string, intervalMin: number, webContents: WebContents) {
    const key = `${symbol}:${intervalMin}`;
    const sub = this.subscriptions.get(key);
    if (sub) {
      sub.webContentsSet.delete(webContents);
      if (sub.webContentsSet.size === 0 && sub.internalRefCount === 0) {
        this.subscriptions.delete(key);
        this.sendSubscriptionUpdate();
      }
    }
  }

  /**
   * Non-UI subscription (e.g. the alert engine) — keeps a stream alive
   * independent of any renderer page having it open. Refcounted so multiple
   * alerts on the same symbol/interval share one subscription.
   */
  public subscribeInternal(symbol: string, intervalMin: number) {
    const key = `${symbol}:${intervalMin}`;
    let sub = this.subscriptions.get(key);
    if (!sub) {
      sub = { symbol, intervalMin, webContentsSet: new Set(), internalRefCount: 0 };
      this.subscriptions.set(key, sub);
    }
    sub.internalRefCount++;
    this.sendSubscriptionUpdate();
  }

  public unsubscribeInternal(symbol: string, intervalMin: number) {
    const key = `${symbol}:${intervalMin}`;
    const sub = this.subscriptions.get(key);
    if (!sub) return;
    sub.internalRefCount = Math.max(0, sub.internalRefCount - 1);
    if (sub.webContentsSet.size === 0 && sub.internalRefCount === 0) {
      this.subscriptions.delete(key);
      this.sendSubscriptionUpdate();
    }
  }

  public subscribeTickers(webContents: WebContents) {
    if (this.tickerWebContentsSet.size === 0) {
      this.tickerWebContentsSet.add(webContents);
      this.sendSubscriptionUpdate();
    } else {
      this.tickerWebContentsSet.add(webContents);
    }
    
    this.ensureWebContentsCleanup(webContents);
  }

  public unsubscribeTickers(webContents: WebContents) {
    if (this.tickerWebContentsSet.has(webContents)) {
      this.tickerWebContentsSet.delete(webContents);
      if (this.tickerWebContentsSet.size === 0) {
        this.sendSubscriptionUpdate();
      }
    }
  }

  private connect() {
    if (this.offline) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    // Connect to the base stream endpoint. We will manage subscriptions via messages.
    const currentWs = new WebSocket("wss://stream.binance.com:9443/ws");
    this.ws = currentWs;

    currentWs.onopen = () => {
      log.info("Connected");
      if (this.ws === currentWs) this.sendSubscriptionUpdate();
    };

    currentWs.onmessage = (event) => {
      if (this.ws !== currentWs) return;
      try {
        const data = JSON.parse(event.data.toString());
        if (data.e === "kline") {
          this.handleKline(data);
        } else if (Array.isArray(data)) {
          // This is the !ticker@arr payload — Binance sends 2000+ symbols per
          // tick across every quote asset. Filter to comparable USDT spot
          // pairs before broadcasting so gainers/losers/trending reflect real
          // tradable tokens and the IPC payload isn't the full firehose.
          const relevant = data.filter((t: any) => typeof t.s === "string" && isTrendableSymbol(t.s));
          for (const wc of this.tickerWebContentsSet) emitTo(wc, "binance:ticker-update", relevant);
        }
      } catch (err) {
        log.error("Parse error", err);
      }
    };

    currentWs.onclose = () => {
      log.info("Disconnected");
      if (this.ws === currentWs) {
        this.ws = null;
        this.scheduleReconnect();
      }
    };

    currentWs.onerror = (err) => {
      log.error("Error", err);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscriptions.size > 0 || this.tickerWebContentsSet.size > 0) {
        this.connect();
      }
    }, 5000); // 5s backoff
  }

  private sendSubscriptionUpdate() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.subscriptions.size > 0 || this.tickerWebContentsSet.size > 0) {
        this.connect();
      }
      return;
    }

    if (this.subscriptions.size === 0 && this.tickerWebContentsSet.size === 0) {
      if (!this.closeTimer) {
        this.closeTimer = setTimeout(() => {
          if (this.subscriptions.size === 0 && this.tickerWebContentsSet.size === 0 && this.ws) {
            this.ws.close();
            this.ws = null;
          }
          this.closeTimer = null;
        }, 3000); // 3s debounce to survive React Strict Mode mount/unmount cycle
      }
      return;
    }

    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }

    const paramsSet = new Set<string>();
    
    for (const sub of this.subscriptions.values()) {
      const { base, quote } = getBaseAndQuote(sub.symbol);
      const intervalStr = INTERVAL_STRINGS[sub.intervalMin] || "1h";
      
      // Base asset to USDT
      paramsSet.add(`${base.toLowerCase()}usdt@kline_${intervalStr}`);
      
      // Non-USD quote pairs are NOT synthesized. See handleKline.
      if (quote !== "USD" && quote !== "USDT") continue;
    }

    if (this.tickerWebContentsSet.size > 0) {
      paramsSet.add("!ticker@arr");
    }

    const msg = {
      method: "SUBSCRIBE",
      params: Array.from(paramsSet),
      id: 1,
    };
    this.ws.send(JSON.stringify(msg));
  }

  private handleKline(payload: any) {
    const k = payload.k;
    const binanceSymbol = k.s; // e.g. BTCUSDT
    const intervalStr = k.i;

    // Resolve which internal subscriptions this kline can satisfy
    for (const sub of this.subscriptions.values()) {
      const expectedBaseBinance = toFeedSymbol(sub.symbol);

      if (INTERVAL_STRINGS[sub.intervalMin] !== intervalStr) continue;

      /* Non-USD quote pairs have no analysis feed — `toFeedSymbol` returns
         null for them. The reason it refuses rather than converting is in
         `integrations/feed/symbols.ts`, and it is the schema-v8 purge. */
      if (expectedBaseBinance === null) continue;

      // We only broadcast when the BASE asset ticks.
      if (binanceSymbol === expectedBaseBinance) {
        const candle = {
          start: k.t,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
          /* `k.V` = taker (aggressor) BUY base volume for the bar — the
             ingredient CVD needs, arriving on every tick and previously
             dropped. null when absent or outside [0, volume]: a wrong
             aggressor split is worse than a missing one, and null is read
             downstream as "unknown" rather than coerced to zero. */
          takerBuyVolume: takerBuyFromWs(k),
          closed: k.x === true,
        };

        /* Upsert into SQLite — but only if there is still a database. A live
           socket can outlive the DB (shutdown, or a test tearing down), and
           throwing per message produced an unbounded error log that buried
           whatever actually went wrong. Skip quietly; the candle is
           recoverable from REST backfill, the log is not worth losing. */
        try {
          if (!isDbReady()) throw new NoDatabaseError();
          getDb()
            .prepare(
              `INSERT INTO candles (symbol, interval_min, start_ms, open, high, low, close, volume, taker_buy_volume, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'binance')
               ON CONFLICT(source, symbol, interval_min, start_ms)
               DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume,
                             taker_buy_volume=COALESCE(excluded.taker_buy_volume, candles.taker_buy_volume)`
            )
            .run(
              sub.symbol,
              sub.intervalMin,
              candle.start,
              candle.open,
              candle.high,
              candle.low,
              candle.close,
              candle.volume,
              candle.takerBuyVolume !== null ? String(candle.takerBuyVolume) : null
            );
        } catch (err) {
          // A missing DB during teardown is expected and silent; anything else
          // is a real failure and still gets logged.
          if (!(err instanceof NoDatabaseError)) log.error("Error inserting candle", err);
        }

        // Broadcast to relevant WebContents
        for (const wc of sub.webContentsSet) {
          emitTo(wc, "binance:candle-update", { symbol: sub.symbol, intervalMin: sub.intervalMin, candle });
        }

        // Notify non-UI listeners (alert engine) regardless of whether any
        // renderer page currently has this pair open.
        this.candleListeners.emit(sub.symbol, sub.intervalMin, candle);
      }
    }
  }
}

export const binanceWS = new BinanceWSManager();
