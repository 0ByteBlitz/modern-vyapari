import { useEffect, useState } from "react";
import { api, isError, type DerivativesMetrics, type BasisStats } from "@/lib/api";
import { formatCompact } from "@/lib/format";

/**
 * The strip beneath the Markets chart: cross-venue derivatives plus the
 * measured execution basis.
 *
 * Binance and Hyperliquid figures are shown side by side and never averaged —
 * a divergence between two venues' funding is itself the signal. The basis
 * cell is the one number that says what trading this pair actually costs on
 * the venue you'd execute on, which a Binance-priced chart cannot tell you.
 */
/** Funding is quoted per interval; annualised is the number that bites. */
function fmtFunding(rate: string | undefined | null): { value: string; note: string; tone: string } {
  const r = parseFloat(rate ?? "");
  if (!Number.isFinite(r)) return { value: "—", note: "unavailable", tone: "var(--text-faint)" };
  const pct = r * 100;
  const annual = pct * 3 * 365; // 8h funding → 3 payments/day
  return {
    value: `${pct >= 0 ? "+" : ""}${pct.toFixed(4)}%`,
    note: `${annual >= 0 ? "+" : ""}${annual.toFixed(1)}% annualised`,
    tone: pct > 0.01 ? "var(--caution)" : pct < 0 ? "var(--up)" : "var(--text-secondary)",
  };
}

function Cell({ label, value, note, tone }: { label: string; value: string; note: string; tone?: string }) {
  return (
    <div className="deriv-cell">
      <span className="label-micro">{label}</span>
      <span className="mono deriv-value" style={{ color: tone ?? "var(--text-secondary)" }}>
        {value}
      </span>
      <span className="deriv-note">{note}</span>
    </div>
  );
}

export function DerivativesStrip({ symbol }: { symbol: string }) {
  const [data, setData] = useState<DerivativesMetrics | null>(null);
  const [basis, setBasis] = useState<BasisStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    const load = async () => {
      const [d, b] = await Promise.all([api.getDerivatives(symbol), api.getBasisStats(symbol)]);
      if (!active) return;
      setData(isError(d) ? null : d);
      setBasis(isError(b) ? null : b);
      setLoading(false);
    };

    void load();
    // Funding and OI move slowly; polling hard would just burn rate limit.
    const id = setInterval(() => void load(), 60_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [symbol]);

  const binOi = parseFloat(data?.binance?.openInterest?.openInterest ?? "");
  const binFunding = fmtFunding(data?.binance?.fundingRate?.lastFundingRate);
  const hlOi = parseFloat(String(data?.hyperliquid?.openInterest ?? ""));
  const hlFunding = fmtFunding(data?.hyperliquid?.funding as string | undefined);

  const spread = basis?.medianRevxSpreadBps ?? null;
  const enoughSamples = (basis?.sampleCount ?? 0) >= 30;

  return (
    <div className="deriv-strip">
      <Cell
        label="Binance OI"
        value={Number.isFinite(binOi) ? formatCompact(binOi) : "—"}
        note={Number.isFinite(binOi) ? "perp contracts" : loading ? "loading…" : "no perp listed"}
      />
      <Cell label="Binance funding" value={binFunding.value} note={binFunding.note} tone={binFunding.tone} />
      <Cell
        label="Hyperliquid OI"
        value={Number.isFinite(hlOi) ? formatCompact(hlOi) : "—"}
        note={Number.isFinite(hlOi) ? "on-chain perps" : loading ? "loading…" : "not listed"}
      />
      <Cell label="HL funding" value={hlFunding.value} note={hlFunding.note} tone={hlFunding.tone} />
      <Cell
        label="RevX spread"
        value={spread === null ? "—" : `${spread.toFixed(1)}bp`}
        note={
          spread === null
            ? "not measured yet"
            : enoughSamples
              ? `${basis!.sampleCount} samples · ~${(spread / 2).toFixed(1)}bp per side`
              : `only ${basis!.sampleCount} samples — thin`
        }
        tone={spread === null ? undefined : spread > 30 ? "var(--caution)" : "var(--text-secondary)"}
      />
    </div>
  );
}
