import { useState, useMemo, useEffect } from "react";
import { CandlesCard } from "@/components/candles-card";
import { DerivativesStrip } from "@/components/derivatives-strip";
import { Input } from "@/components/ui/input";
import { useTickers } from "@/lib/use-tickers";
import { ArrowDownRight, ArrowUpRight, Search, Flame, Zap } from "lucide-react";

// Below this 24h quote volume (USDT), a ticker is too illiquid to trust for
// gainer/loser/trending ranking — a few hundred dollars of volume can swing
// "change24h" wildly without meaning anything.
const MIN_TRENDING_VOLUME = 100_000;

function formatVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

/**
 * Markets (all pairs) and Research (one session's pair) are the same surface
 * at two scopes. Passing `lockedSymbol` pins the chart to the session's pair
 * so Research can't silently drift onto a pair the session doesn't trade —
 * the market list then acts as comparison, not navigation.
 */
export function MarketPage({ lockedSymbol }: { lockedSymbol?: string } = {}) {
  const [symbol, setSymbol] = useState(lockedSymbol ?? "BTC-USD");
  const [search, setSearch] = useState("");
  /** When on, hide markets the bot could not actually execute on the venue. */
  const [tradableOnly, setTradableOnly] = useState(false);

  useEffect(() => {
    if (lockedSymbol) setSymbol(lockedSymbol);
  }, [lockedSymbol]);

  // Single feed: Binance for all prices, volume, and 24h change. The venue's
  // pair list only annotates rows with `tradableOnVenue`.
  const { tickers, loading, error, streaming, tradableCount } = useTickers();

  const list = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = tickers.filter(
      (t) => t.symbol.toLowerCase().includes(q) && (!tradableOnly || t.tradableOnVenue)
    );
    return filtered
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, search ? undefined : 30); // top 30 by volume when not searching
  }, [tickers, search, tradableOnly]);

  // Liquid subset used for gainer/loser/trending — keeps illiquid dust out
  // of the highlights bar without affecting the full searchable list above.
  const liquidTickers = useMemo(
    () => tickers.filter((t) => t.volume24h >= MIN_TRENDING_VOLUME),
    [tickers]
  );

  const topGainer = useMemo(() => {
    if (!liquidTickers.length) return null;
    return [...liquidTickers].sort((a, b) => b.change24h - a.change24h)[0];
  }, [liquidTickers]);

  const topLoser = useMemo(() => {
    if (!liquidTickers.length) return null;
    return [...liquidTickers].sort((a, b) => a.change24h - b.change24h)[0];
  }, [liquidTickers]);

  const trending = useMemo(() => {
    if (!liquidTickers.length) return null;
    return [...liquidTickers].sort((a, b) => b.volume24h - a.volume24h)[0];
  }, [liquidTickers]);

  return (
    <div className="flex-1 min-h-0 bg-background overflow-hidden market-page-layout">
      {/* Sidebar */}
      <div className="market-page-sidebar border-r border-border bg-card/30 flex flex-col min-h-0">
        <div className="p-4 border-b border-border space-y-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search pairs..."
              className="pl-8 h-8 text-xs bg-background/50"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Execution-venue filter. Binance supplies the data either way —
              this only narrows the list to what the venue can actually fill. */}
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-primary"
              checked={tradableOnly}
              onChange={(e) => setTradableOnly(e.target.checked)}
            />
            Tradable pairs only
            {tradableCount > 0 && <span className="text-muted-foreground/60">({tradableCount})</span>}
          </label>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="animate-pulse p-4 text-center text-xs text-muted-foreground">Loading markets…</div>
          ) : error && tickers.length === 0 ? (
            <div className="p-4 text-xs leading-relaxed text-muted-foreground">
              <div style={{ color: "var(--down)" }}>Couldn't reach Binance.</div>
              <div className="mt-1">{error}</div>
              <div className="mt-2" style={{ color: "var(--text-faint)" }}>
                Check your connection — the market list and every chart in the app read from this feed.
              </div>
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="sticky top-0 bg-card/90 backdrop-blur z-10 px-4 py-2 border-b border-border/50 text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center justify-between">
                <span>Markets {search ? "" : "by volume"}</span>
                {/* Honest about whether these numbers are live or a snapshot. */}
                <span className="font-normal normal-case tracking-normal text-muted-foreground/60">
                  Binance {streaming ? "live" : "snapshot"}
                </span>
              </div>
              <div className="divide-y divide-border/50">
                {list.map((t) => (
                  <button
                    key={t.symbol}
                    onClick={() => setSymbol(t.symbol)}
                    className={`w-full text-left px-4 py-2 flex items-center justify-between hover:bg-muted/50 transition-colors ${symbol === t.symbol ? "bg-primary/5 border-l-2 border-primary" : "border-l-2 border-transparent"}`}
                  >
                    <div className="min-w-0">
                      <div className={`font-bold text-sm flex items-center gap-1.5 ${symbol === t.symbol ? "text-primary" : "text-foreground"}`}>
                        {t.symbol}
                        {t.tradableOnVenue && (
                          <span
                            title="Listed on the venue — the bot can execute this pair"
                            className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-500/90 bg-amber-500/10 rounded px-1 py-px"
                          >
                            <Zap className="h-2.5 w-2.5" />
                            Tradable
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        ${t.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
                      </div>
                      <div className="text-[10px] text-muted-foreground/60">Vol ${formatVolume(t.volume24h)}</div>
                    </div>
                    <div className={`text-xs font-medium flex items-center gap-1 shrink-0 ${t.change24h >= 0 ? "text-green-500" : "text-destructive"}`}>
                      {t.change24h >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                      {Math.abs(t.change24h).toFixed(2)}%
                    </div>
                  </button>
                ))}
                {list.length === 0 && (
                  <div className="px-4 py-3 text-xs text-muted-foreground">
                    {tradableOnly ? "No tradable pairs match." : "No pairs found"}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Highlights Bar — Binance data (the single market-data feed) */}
        <div className="h-24 border-b border-border bg-card/20 flex items-center px-6 gap-6 shrink-0 overflow-x-auto">
          {topGainer && (
            <div className="flex flex-col gap-1 min-w-[200px]">
              <div className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground uppercase tracking-widest">
                <ArrowUpRight className="h-3.5 w-3.5 text-green-500" />
                Top Gainer
              </div>
              <div className="flex items-baseline gap-2 cursor-pointer hover:opacity-80" onClick={() => setSymbol(topGainer.symbol)}>
                <span className="text-lg font-bold">{topGainer.symbol}</span>
                <span className="text-sm font-medium text-green-500">+{topGainer.change24h.toFixed(2)}%</span>
              </div>
            </div>
          )}
          {topGainer && topLoser && <div className="w-px h-10 bg-border/50" />}
          {topLoser && (
            <div className="flex flex-col gap-1 min-w-[200px]">
              <div className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground uppercase tracking-widest">
                <ArrowDownRight className="h-3.5 w-3.5 text-destructive" />
                Top Loser
              </div>
              <div className="flex items-baseline gap-2 cursor-pointer hover:opacity-80" onClick={() => setSymbol(topLoser.symbol)}>
                <span className="text-lg font-bold">{topLoser.symbol}</span>
                <span className="text-sm font-medium text-destructive">{topLoser.change24h.toFixed(2)}%</span>
              </div>
            </div>
          )}
          {topLoser && trending && <div className="w-px h-10 bg-border/50" />}
          {trending && (
            <div className="flex flex-col gap-1 min-w-[200px]">
              <div className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground uppercase tracking-widest">
                <Flame className="h-3.5 w-3.5 text-amber-500" />
                Trending
              </div>
              <div className="flex items-baseline gap-2 cursor-pointer hover:opacity-80" onClick={() => setSymbol(trending.symbol)}>
                <span className="text-lg font-bold">{trending.symbol}</span>
                <span className="text-sm font-medium text-muted-foreground">Vol: ${formatVolume(trending.volume24h)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Chart fills the column; the derivatives + basis strip pins to the
            bottom, per the design. Without it the chart floated with dead
            space beneath it. */}
        <div className="market-chart-wrap">
          <CandlesCard symbol={symbol} onSymbolChange={setSymbol} symbolLocked={Boolean(lockedSymbol)} fill />
        </div>
        <DerivativesStrip symbol={symbol} />
      </div>
    </div>
  );
}
