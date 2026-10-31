/**
 * CVD coverage, and the repair that fixes it (roadmap S1-3).
 *
 * `taker_buy_volume` arrived with schema v11, so every bar cached before then
 * has an unknown aggressor split and CVD is unavailable over it. That is easy
 * to miss: nothing looks broken, the chart draws, indicators compute — CVD is
 * simply absent, or silently anchored much later than the trader intended.
 * This pane exists so the gap is *visible* rather than something you discover
 * when a strategy that depends on it never triggers.
 *
 * Deliberate choices:
 *  - the number shown is **measured before and after**, never assumed. A
 *    repair reports what changed, including when nothing did;
 *  - "still unknown" after a repair is displayed rather than rounded away —
 *    Binance stops serving very old history for some symbols, and a coverage
 *    figure that quietly excluded what it couldn't fix would be a lie of
 *    exactly the kind this app exists to avoid;
 *  - unrepairable rows (non-USD quote, unsupported interval) say why.
 */
import { useCallback, useEffect, useState } from "react";
import { api, isError, errorText } from "@/lib/api";
import type { CandleCoverage, CandleRepairResult, CandleRepairProgress } from "@/lib/api";
import { RefreshCw, Wrench, Check, AlertTriangle } from "lucide-react";

const MINUTE_LABEL: Record<number, string> = {
  1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "1d",
};

function intervalLabel(m: number): string {
  return MINUTE_LABEL[m] ?? `${m}m`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(v > 0 && v < 0.01 ? 2 : 1)}%`;
}

function coverageColour(c: CandleCoverage): string {
  if (!c.repairable) return "var(--text-faint)";
  if (c.coverage >= 0.999) return "var(--up)";
  if (c.coverage >= 0.5) return "var(--caution)";
  return "var(--down)";
}

export function CandleCoveragePane() {
  const [rows, setRows] = useState<CandleCoverage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<CandleRepairProgress | null>(null);
  const [lastRun, setLastRun] = useState<CandleRepairResult[] | null>(null);

  const load = useCallback(async () => {
    const res = await api.getCandleCoverage();
    if (isError(res)) {
      setError(errorText(res));
      return;
    }
    setError(null);
    setRows(res);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => api.onCandleRepairProgress(setProgress), []);

  const repair = useCallback(
    async (symbol?: string, intervalMin?: number) => {
      setBusy(true);
      setProgress(null);
      setLastRun(null);
      const res = await api.repairCandleHistory(symbol, intervalMin);
      setBusy(false);
      setProgress(null);
      if (isError(res)) {
        setError(errorText(res));
        return;
      }
      setError(null);
      setLastRun(res);
      await load();
    },
    [load]
  );

  const incomplete = (rows ?? []).filter((r) => r.repairable && r.coverage < 0.999);

  return (
    <section className="panel">
      <div className="panel-header">
        <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Order-flow coverage</span>
        <button className="btn ml-auto" onClick={() => void load()} disabled={busy}>
          <RefreshCw size={13} /> Refresh
        </button>
        <button
          className="btn"
          onClick={() => void repair()}
          disabled={busy || incomplete.length === 0}
          title={
            incomplete.length === 0
              ? "All cached history has buy/sell data."
              : `Refetch history for ${incomplete.length} incomplete series.`
          }
        >
          <Wrench size={13} /> {busy ? "Repairing…" : "Repair all"}
        </button>
      </div>

      <div
        className="panel-body"
        style={{ fontSize: "var(--text-md)", color: "var(--muted-foreground)", lineHeight: 1.7 }}
      >
        <p>
          CVD and the volume profile's buy/sell split need each bar's{" "}
          <span className="mono">taker_buy_volume</span> — which side was the aggressor. Bars cached
          before that field was stored have it as <strong>unknown</strong>, not zero, so those tools
          stay unavailable over that history rather than reporting a fabricated flat delta.
        </p>
        <p style={{ marginTop: 8, color: "var(--text-faint)" }}>
          Repair refetches only the span that needs it. It can add knowledge but never erase it, so it
          is safe to re-run. Requests are sequential to stay inside Binance's rate limits.
        </p>
      </div>

      {error && (
        <div className="panel-body" style={{ color: "var(--down)", fontSize: "var(--text-sm)" }}>
          {error}
        </div>
      )}

      {busy && progress && (
        <div
          className="panel-body mono"
          style={{ fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}
        >
          {progress.symbol} {intervalLabel(progress.intervalMin)} — {progress.barsWritten} bars in{" "}
          {progress.batches} {progress.batches === 1 ? "request" : "requests"}, at{" "}
          {new Date(progress.cursorMs).toLocaleString()}
        </div>
      )}

      {lastRun && (
        <div className="panel-body" style={{ fontSize: "var(--text-sm)" }}>
          {lastRun.length === 0 ? (
            <span style={{ color: "var(--muted-foreground)" }}>Nothing needed repairing.</span>
          ) : (
            lastRun.map((r) => (
              <div key={`${r.symbol}:${r.intervalMin}`} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {r.stillUnknown === 0 ? (
                  <Check size={13} style={{ color: "var(--up)" }} />
                ) : (
                  <AlertTriangle size={13} style={{ color: "var(--caution)" }} />
                )}
                <span className="mono">
                  {r.symbol} {intervalLabel(r.intervalMin)}
                </span>
                <span style={{ color: "var(--muted-foreground)" }}>
                  healed {r.healed} of {r.before.totalBars - r.before.knownBars}
                  {r.stillUnknown > 0 && (
                    <> · {r.stillUnknown} still unknown (Binance may no longer serve that far back)</>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      <table className="vy-table">
        <thead>
          <tr>
            <th>Pair</th>
            <th>TF</th>
            <th style={{ textAlign: "right" }}>Bars</th>
            <th style={{ textAlign: "right" }}>Known</th>
            <th style={{ textAlign: "right" }}>Coverage</th>
            <th>Oldest</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows === null && (
            <tr>
              <td colSpan={7} style={{ color: "var(--text-faint)" }}>
                Loading…
              </td>
            </tr>
          )}
          {rows?.length === 0 && (
            <tr>
              <td colSpan={7} style={{ color: "var(--text-faint)" }}>
                No cached analysis history yet. Open a pair on Research or Markets.
              </td>
            </tr>
          )}
          {rows?.map((r) => (
            <tr key={`${r.symbol}:${r.intervalMin}`}>
              <td className="mono">{r.symbol}</td>
              <td className="mono">{intervalLabel(r.intervalMin)}</td>
              <td className="mono" style={{ textAlign: "right" }}>
                {r.totalBars.toLocaleString()}
              </td>
              <td className="mono" style={{ textAlign: "right" }}>
                {r.knownBars.toLocaleString()}
              </td>
              <td className="mono" style={{ textAlign: "right", color: coverageColour(r) }}>
                {pct(r.coverage)}
              </td>
              <td className="mono" style={{ color: "var(--text-faint)" }}>
                {r.oldestMs ? new Date(r.oldestMs).toLocaleDateString() : "—"}
              </td>
              <td style={{ textAlign: "right" }}>
                {!r.repairable ? (
                  <span
                    style={{ color: "var(--text-faint)", fontSize: "var(--text-sm)" }}
                    title={r.blockedReason}
                  >
                    not repairable
                  </span>
                ) : r.coverage >= 0.999 ? (
                  <Check size={13} style={{ color: "var(--up)" }} />
                ) : (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void repair(r.symbol, r.intervalMin)}
                  >
                    Repair
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
