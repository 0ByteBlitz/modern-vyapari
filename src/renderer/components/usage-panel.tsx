import { useCallback, useEffect, useState } from "react";
import { Coins } from "lucide-react";
import { api, isError, type UsageReport } from "@/lib/api";

/**
 * What the agent has cost.
 *
 * **Spend, never "credit remaining"** — and the distinction is not pedantry.
 * Anthropic exposes no balance endpoint to a normal API key, and its cost
 * reports need an Admin key that individual accounts cannot create. A
 * "remaining" figure would have to be inferred from a starting number the app
 * was told once and cannot verify, drifting the moment anything else on the
 * account spent a token. So the panel states what it measured and says what it
 * cannot know.
 *
 * One placement: Settings. It used to sit in the toolbar beside the session's
 * P&L, where "$0.000 today" read as a trading figure, and on the session
 * dashboard, where it summed every session in both modes under one pair's
 * name. Spend is app-wide, so it lives where app-wide settings do.
 */
const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

export function UsagePanel() {
  const [report, setReport] = useState<UsageReport | null>(null);

  const load = useCallback(async () => {
    const res = await api.usageReport();
    if (!isError(res)) setReport(res);
  }, []);

  useEffect(() => {
    void load();
    /* Slow poll. Spend only moves when the agent runs, and a ticking cost
       readout would draw the eye away from the prices that matter. */
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (!report) return null;

  const t = report.allTime;
  return (
    <section className="panel">
      <div className="panel-header">
        <Coins size={13} style={{ color: "var(--accent)" }} />
        <span className="label-micro">Agent spend</span>
        <span className="ml-auto mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
          {t.calls} calls
        </span>
      </div>

      <div className="usage-body">
        <div className="usage-figures">
          {(
            [
              ["Today", report.today],
              ["30 days", report.last30Days],
              ["All time", t],
            ] as const
          ).map(([label, w]) => (
            <div key={label}>
              <span className="label-micro">{label}</span>
              {/* A total with unpriced calls in it is a floor, not a figure:
                  "$0.000" for 29 calls on an unpriced model read as free. */}
              <span className="mono usage-big">
                {w.unpricedCalls > 0 ? `≥ ${usd(w.costUsd)}` : usd(w.costUsd)}
              </span>
              {w.unpricedCalls > 0 && (
                <span className="usage-warn">
                  {w.unpricedCalls} {w.unpricedCalls === 1 ? "call" : "calls"} not priced
                </span>
              )}
            </div>
          ))}
        </div>

        {report.cacheSavedUsd > 0.0005 && (
          /* Worth its own line: caching is the single biggest lever on this
             number, and seeing the saving is what makes it worth protecting. */
          <p className="usage-note">
            Prompt caching has saved <strong>{usd(report.cacheSavedUsd)}</strong>.
          </p>
        )}

        {report.byPurpose.length > 0 && (
          <div className="usage-rows">
            {report.byPurpose.map((p) => (
              <div key={p.purpose} className="usage-row">
                <span>{p.purpose.replace(/_/g, " ")}</span>
                <span className="mono usage-dim">{p.calls}</span>
                <span className="mono ml-auto">{usd(p.costUsd)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Only once both worlds have spent something. With one mode it would
            just restate the total under a heading. */}
        {report.byMode.length > 1 && (
          <div className="usage-rows">
            {report.byMode.map((m) => (
              <div key={m.mode} className="usage-row">
                <span>{m.mode}</span>
                <span className="mono usage-dim">{m.calls}</span>
                <span className="mono ml-auto">{usd(m.costUsd)}</span>
              </div>
            ))}
          </div>
        )}

        {report.byModel.length > 0 && (
          <div className="usage-rows">
            {report.byModel.map((m) => (
              <div key={m.model} className="usage-row">
                <span className="usage-model">{m.model}</span>
                <span className="mono usage-dim">
                  {m.calls} {m.unpriced > 0 && <span className="usage-warn">· {m.unpriced} unpriced</span>}
                </span>
                <span className="mono ml-auto">{usd(m.costUsd)}</span>
              </div>
            ))}
          </div>
        )}

        <p className="usage-note usage-dim">
          {tokens(t.inputTokens)} in · {tokens(t.outputTokens)} out · {tokens(t.cacheReadTokens)} cached
        </p>

        {/* Says plainly what this is not, so nobody reads it as a balance. */}
        <p className="usage-note usage-dim">{report.scope}</p>
      </div>
    </section>
  );
}
