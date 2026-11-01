import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { api, isError, type Candle, type Ticker, errorText } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CandlestickChart } from "@/components/candlestick-chart";
import { formatPrice } from "@/lib/format";

const INTERVALS = [
  { value: "5", label: "5m" },
  { value: "15", label: "15m" },
  { value: "60", label: "1h" },
  { value: "240", label: "4h" },
  { value: "1440", label: "1D" },
];

const CANDLE_WINDOW = 120; // candles fetched per load
const EMPTY: Candle[] = [];
const CANDLE_REFRESH_MS = 30_000;
const TICKER_REFRESH_MS = 10_000;

/** "BTC/USD" (API responses) → "BTC-USD" (API paths + display) */
const normalizeSymbol = (s: string): string => s.replace("/", "-");


interface CandlesCardProps {
  /** Controlled pair symbol (owned by the dashboard / active session). */
  symbol: string;
  onSymbolChange: (symbol: string) => void;
  /** When a session is active the pair is fixed — selector is locked. */
  symbolLocked?: boolean;
  /** Stretch to the parent's height instead of sitting at its natural size. */
  fill?: boolean;
}

export function CandlesCard({ symbol, onSymbolChange, symbolLocked = false, fill = false }: CandlesCardProps) {
  const [pairs, setPairs] = useState<string[]>([]);
  const [interval, setIntervalMin] = useState("60");
  /* Candles carry the series they were loaded for. The selection changes
     the moment the owner picks a pair, but the bars arrive later: until they
     do, the previous pair's bars must not be drawn, priced or patched under
     the new pair's name. */
  const [series, setSeries] = useState<{ key: string; candles: Candle[] }>({ key: "", candles: [] });
  const seriesKey = `${symbol}:${interval}`;
  const candles = series.key === seriesKey ? series.candles : EMPTY;
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const loadSeq = useRef(0); // guards against out-of-order responses on fast pair switching

  /* ── Pair list (once) ─────────────────────────────────────────── */
  useEffect(() => {
    void (async () => {
      const res = await api.getPairs();
      if (isError(res)) return; // pair input still usable via default list
      const active = Object.entries(res)
        .filter(([, cfg]) => cfg.status === "active")
        .map(([key]) => normalizeSymbol(key))
        .sort();
      if (active.length) setPairs(active);
    })();
  }, []);

  /* ── Candles: load on mount + on symbol/interval change + every 30s ── */
  const loadCandles = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const intervalMin = parseInt(interval, 10);
    // Binance is the single analysis feed — history here must match the WS
    // stream that updates this same chart, and the engine's candle cache.
    const res = await api.getAnalysisCandles(symbol, intervalMin, CANDLE_WINDOW);
    if (seq !== loadSeq.current) return; // stale response
    setLoading(false);
    if (isError(res)) {
      setError(errorText(res));
      return;
    }
    setError("");
    setSeries({ key: `${symbol}:${interval}`, candles: res.slice(-CANDLE_WINDOW) });
  }, [symbol, interval]);

  useEffect(() => {
    void loadCandles();
  }, [loadCandles]);

  /* ── Binance WS Subscription ── */
  useEffect(() => {
    const intervalMin = parseInt(interval, 10);
    const key = `${symbol}:${interval}`;
    api.subscribeBinanceCandles(symbol, intervalMin);

    const cleanup = api.onCandleUpdate((data) => {
      if (data.symbol !== symbol || data.intervalMin !== intervalMin) return;
      setSeries((cur) => {
        // A tick before this pair's history has loaded has nothing to patch.
        if (cur.key !== key) return cur;
        const prev = cur.candles;
        const last = prev[prev.length - 1];
        if (!last) return { key, candles: [data.candle] };

        if (data.candle.start === last.start) {
          // Update current active candle
          const copy = [...prev];
          copy[copy.length - 1] = data.candle;
          return { key, candles: copy };
        } else if (data.candle.start > last.start) {
          // New candle
          return { key, candles: [...prev, data.candle].slice(-CANDLE_WINDOW) };
        }
        return cur;
      });
    });

    return () => {
      cleanup();
      api.unsubscribeBinanceCandles(symbol, intervalMin);
    };
  }, [symbol, interval]);

  /* ── Ticker: poll every 10s ───────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const res = await api.getTickers([symbol]);
      if (cancelled || isError(res)) return;
      const t = res.find((x) => normalizeSymbol(x.symbol) === symbol);
      if (t) setTicker(t);
    };
    setTicker(null);
    void poll();
    const t = window.setInterval(() => void poll(), TICKER_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [symbol]);

  /* ── Window change % (first close → last close of loaded window) ── */
  const change = useMemo(() => {
    if (candles.length < 2) return null;
    const first = parseFloat(candles[0]!.close);
    const last = parseFloat(candles[candles.length - 1]!.close);
    if (!first) return null;
    return ((last - first) / first) * 100;
  }, [candles]);

  /* Headline price comes from the CANDLE feed (Binance), not the Revolut X
     ticker — the number above the chart must be the number the chart is
     drawing. The Revolut X ticker is still shown, explicitly labelled, as the
     execution-side bid/ask reference. */
  const lastPrice = candles.length ? candles[candles.length - 1]!.close : (ticker?.last_price ?? null);

  /* How far behind the last bar is. A chart of week-old candles that looks
     identical to a live one is worse than no chart — say so on the face of it. */
  const staleBars = useMemo(() => {
    if (candles.length === 0) return 0;
    const last = candles[candles.length - 1]!.start;
    const barMs = parseInt(interval, 10) * 60_000;
    return Math.floor((Date.now() - last) / barMs);
  }, [candles, interval]);

  return (
    <Card className={`market-card ${fill ? "market-card-fill" : ""}`}>
      {/* ── Market header ─────────────────────────────────────────── */}
      <div className="market-header">
        <div className="market-controls">
          <Select value={symbol} onValueChange={onSymbolChange} disabled={symbolLocked}>
            <SelectTrigger
              className="w-32 h-8 text-sm font-semibold"
              title={symbolLocked ? "Pair is fixed by the active session" : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* The dropdown lists Revolut X pairs (what's executable), but the
                  market page can select any Binance symbol for analysis — so the
                  current symbol is always included, otherwise the trigger would
                  render blank for a chart-only pair. */}
              {(pairs.includes(symbol) ? pairs : [symbol, ...pairs]).map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="interval-group" role="tablist" aria-label="Candle interval">
            {INTERVALS.map((i) => (
              <button
                key={i.value}
                role="tab"
                aria-selected={interval === i.value}
                onClick={() => setIntervalMin(i.value)}
                className={`interval-btn ${interval === i.value ? "interval-btn-active" : ""}`}
              >
                {i.label}
              </button>
            ))}
          </div>
        </div>

        <div className="market-price">
          {lastPrice && (
            <>
              <span className="market-price-value">{formatPrice(lastPrice)}</span>
              {change !== null && (
                <span className={`market-change ${change >= 0 ? "market-change-up" : "market-change-down"}`}>
                  {change >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                  {change >= 0 ? "+" : ""}
                  {change.toFixed(2)}%
                </span>
              )}
              {ticker && (
                <span className="market-bidask" title="Venue order book — where orders would execute">
                  Venue bid {formatPrice(ticker.bid)} · ask {formatPrice(ticker.ask)}
                </span>
              )}
              {staleBars > 2 && (
                <span
                  className="market-stale"
                  title="The newest candle is older than it should be — the feed may be disconnected."
                >
                  stale · last bar {new Date(candles[candles.length - 1]!.start).toLocaleString()}
                </span>
              )}
            </>
          )}
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          onClick={() => void loadCandles()}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error && <p className="px-4 pb-2 text-sm text-destructive">{error}</p>}

      {/* ── Chart (hero, fills remaining height) ──────────────────── */}
      <div className="market-chart">
        {candles.length > 0 && (
          /* The key is what tells the chart this is a different series —
             without it a new pair or interval looks identical to a tick,
             because the window size never changes. */
          <CandlestickChart candles={candles} intervalMin={parseInt(interval, 10)} height="fill" seriesKey={seriesKey} />
        )}
      </div>

      {/* ── Collapsible data table ────────────────────────────────── */}
      <div className="market-footer">
        <button
          onClick={() => setShowTable((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {showTable ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {showTable ? "Hide" : "Show"} data table
        </button>

        {showTable && (
          <div className="mt-2 max-h-56 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Start (local)</TableHead>
                  <TableHead>Open</TableHead>
                  <TableHead>High</TableHead>
                  <TableHead>Low</TableHead>
                  <TableHead>Close</TableHead>
                  <TableHead>Volume</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...candles].reverse().map((c) => (
                  <TableRow key={c.start}>
                    <TableCell className="font-medium">{new Date(c.start).toLocaleString()}</TableCell>
                    <TableCell>{c.open}</TableCell>
                    <TableCell>{c.high}</TableCell>
                    <TableCell>{c.low}</TableCell>
                    <TableCell>{c.close}</TableCell>
                    <TableCell>{c.volume}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Card>
  );
}
