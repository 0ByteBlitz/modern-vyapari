import { useCallback, useEffect, useRef, useState } from "react";
import { Coins } from "lucide-react";
import { api, isError, type UsageReport, type UsageTotals } from "@/lib/api";

/**
 * What the agent has cost.
 *
 * **Spend, never "credit remaining"** — and the distinction is not pedantry.
 * AI providers expose no balance to a normal API key (Anthropic's cost reports
 * need an Admin key individual accounts cannot create). A "remaining" figure would have to be inferred from a starting number the app
 * was told once and cannot verify, drifting the moment anything else on the
 * account spent a token. So the panel states what it measured and says what it
 * cannot know.
 *
 * Two placements, one report: the full panel in Settings › Usage & cost, and
 * `AiSpendChip` in the titlebar, so spend is visible from every screen — the
 * owner runs this on a budget that isn't there. The chip sits in the titlebar,
 * not the trading toolbar: beside the session's P&L, "$0.000 today" read as a
 * trading figure. And it opens on click, not hover.
 */
/** Dollars to the cent; a non-zero amount under a cent says so rather than
 *  rounding to $0.00, which would read as free. */
const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
/** A total that includes unpriced calls is a floor, not a figure. */
const total = (w: UsageTotals) => (w.unpricedCalls > 0 ? `≥ ${usd(w.costUsd)}` : usd(w.costUsd));
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
              <span className="mono usage-big">{total(w)}</span>
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

        {report.byProvider.length > 0 && (
          <div className="usage-rows">
            {report.byProvider.map((p) => (
              <div key={p.provider} className="usage-row">
                <span>{p.provider}</span>
                <span className="mono usage-dim">
                  {p.calls} {p.unpriced > 0 && <span className="usage-warn">· {p.unpriced} unpriced</span>}
                </span>
                <span className="mono ml-auto">{p.unpriced > 0 ? `≥ ${usd(p.costUsd)}` : usd(p.costUsd)}</span>
              </div>
            ))}
          </div>
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

/**
 * AI spend, on every screen.
 *
 * Refreshes when any agent reply finishes as well as on a slow poll, so a
 * turn's cost shows up when the turn does. Reviews and lessons run unattended
 * and are picked up by the poll.
 */
export function AiSpendChip({ onOpenUsage }: { onOpenUsage: () => void }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await api.usageReport();
    if (!isError(res)) setReport(res);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    const offDone = api.onChatComplete(() => void load());
    return () => {
      clearInterval(id);
      offDone();
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!report) return null;

  return (
    <div className="ai-spend" ref={ref}>
      <button
        className="ai-spend-chip"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void load();
        }}
        aria-expanded={open}
        title="AI spend — click for details"
      >
        <Coins size={12} />
        <span className="ai-spend-label">AI</span>
        <span className="mono">{total(report.today)}</span>
        <span className="ai-spend-label">today</span>
      </button>

      {open && (
        <div className="ai-spend-pop" role="dialog" aria-label="AI spend">
          <div className="ai-spend-grid">
            {(
              [
                ["Today", report.today],
                ["30 days", report.last30Days],
                ["All time", report.allTime],
              ] as const
            ).map(([label, w]) => (
              <div key={label}>
                <span className="label-micro">{label}</span>
                <span className="mono ai-spend-big">{total(w)}</span>
              </div>
            ))}
          </div>

          {report.byProvider.map((p) => (
            <div key={p.provider} className="usage-row">
              <span>{p.provider}</span>
              <span className="mono usage-dim">{p.calls} calls</span>
              <span className="mono ml-auto">{p.unpriced > 0 ? `≥ ${usd(p.costUsd)}` : usd(p.costUsd)}</span>
            </div>
          ))}

          {report.allTime.unpricedCalls > 0 && (
            <p className="usage-note usage-warn">
              {report.allTime.unpricedCalls} {report.allTime.unpricedCalls === 1 ? "call has" : "calls have"} no
              price, so totals are a minimum.
            </p>
          )}
          <p className="usage-note usage-dim">{report.scope}</p>

          <button
            className="btn"
            onClick={() => {
              setOpen(false);
              onOpenUsage();
            }}
          >
            Usage & cost
          </button>
        </div>
      )}
    </div>
  );
}
