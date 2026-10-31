import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Wallet } from "lucide-react";
import { api, isError, errorText, type Balance, type Ticker } from "@/lib/api";
import { Button } from "@/components/ui/button";

const REFRESH_MS = 60_000;

interface ValuedAsset {
  currency: string;
  total: string;
  available: string;
  reserved: string;
  /** USD value of total, or null when no USD price is available. */
  valueUsd: number | null;
}

const normalizeSymbol = (s: string): string => s.replace("/", "-");

function formatAmount(v: string): string {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return v;
  return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 2 : 8 });
}

function formatUsd(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

/** Resolve a USD price for a currency from the full ticker list. */
function priceUsd(currency: string, tickers: Ticker[]): number | null {
  if (currency === "USD") return 1;
  const direct = tickers.find((t) => normalizeSymbol(t.symbol) === `${currency}-USD`);
  if (direct) return parseFloat(direct.last_price);
  // Route via USDT when no direct USD pair exists (e.g. CUR-USDT × USDT-USD)
  const viaUsdt = tickers.find((t) => normalizeSymbol(t.symbol) === `${currency}-USDT`);
  const usdtUsd = tickers.find((t) => normalizeSymbol(t.symbol) === "USDT-USD");
  if (viaUsdt && usdtUsd) return parseFloat(viaUsdt.last_price) * parseFloat(usdtUsd.last_price);
  return null;
}

/**
 * Portfolio strip (Binance-assets style): net USD value + per-asset chips with
 * amount and ≈USD value. Auto-loads, refreshes every 60s.
 */
export function BalancesCard() {
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [balRes, tickRes] = await Promise.all([api.getBalances(), api.getTickers()]);
    setLoading(false);
    if (isError(balRes)) {
      setError(errorText(balRes));
      return;
    }
    setError("");
    setBalances(balRes.filter((b) => parseFloat(b.total) > 0));
    if (!isError(tickRes)) setTickers(tickRes);
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const assets: ValuedAsset[] = useMemo(() => {
    if (!balances) return [];
    return balances
      .map((b) => {
        const price = priceUsd(b.currency, tickers);
        return {
          currency: b.currency,
          total: b.total,
          available: b.available,
          reserved: b.reserved,
          valueUsd: price === null ? null : price * parseFloat(b.total),
        };
      })
      .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)); // largest holdings first
  }, [balances, tickers]);

  const netUsd = useMemo(() => assets.reduce((sum, a) => sum + (a.valueUsd ?? 0), 0), [assets]);
  const unpricedCount = assets.filter((a) => a.valueUsd === null).length;

  return (
    <div className="balances-strip">
      <div className="balances-label">
        <Wallet className="h-3.5 w-3.5" />
        <span className="balances-label-text">Portfolio</span>
      </div>

      {/* Net value — headline number */}
      {balances && (
        <div className="portfolio-net" title={unpricedCount ? `${unpricedCount} asset(s) without USD price excluded` : undefined}>
          <span className="portfolio-net-value">{formatUsd(netUsd)}</span>
          {unpricedCount > 0 && <span className="portfolio-net-note">+{unpricedCount} unpriced</span>}
        </div>
      )}

      {error && <span className="text-xs text-destructive">{error}</span>}

      {balances && balances.length === 0 && !error && (
        <span className="text-xs text-muted-foreground">No assets</span>
      )}

      <div className="balances-chips">
        {assets.map((a) => (
          <div
            key={a.currency}
            className="balance-chip"
            title={`Available ${a.available} · Reserved ${a.reserved}${
              a.valueUsd !== null && netUsd > 0 ? ` · ${((a.valueUsd / netUsd) * 100).toFixed(1)}% of portfolio` : ""
            }`}
          >
            <span className="balance-chip-currency">{a.currency}</span>
            <span className="balance-chip-total">{formatAmount(a.total)}</span>
            <span className="balance-chip-value">{a.valueUsd !== null ? `≈ ${formatUsd(a.valueUsd)}` : "no USD price"}</span>
          </div>
        ))}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground ml-auto"
        onClick={() => void load()}
        disabled={loading}
        title="Refresh portfolio"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
      </Button>
    </div>
  );
}
