import { useCallback, useEffect, useState } from "react";
import { api, isError, type PortfolioSummary } from "@/lib/api";
import { BalancesCard } from "@/components/balances-card";
import { formatUsd, formatPct } from "@/lib/format";

/**
 * Portfolio — the only surface that crosses sessions.
 *
 * Read-only aggregate by design: every action belongs to a session, so this
 * answers "how is the whole thing doing" and then hands you off to the session
 * that needs attention.
 */
function StatCell({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "neutral";
  sub?: string;
}) {
  const color = tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : "var(--text-secondary)";
  return (
    <div className="stat-cell">
      <span className="label-micro">{label}</span>
      <span className="mono stat-cell-value" style={{ color }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>{sub}</span>}
    </div>
  );
}

export function PortfolioPage({ onOpenSession }: { onOpenSession: (s: { id: number; pair: string }) => void }) {
  const [data, setData] = useState<PortfolioSummary | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);

  const load = useCallback(async () => {
    const res = await api.portfolioSummary(includeArchived);
    if (!isError(res)) setData(res);
  }, [includeArchived]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (!data) {
    return (
      <div className="empty-state">
        <span>Loading portfolio…</span>
      </div>
    );
  }

  const { totals, sessions } = data;
  const winRate = totals.closedCount > 0 ? (totals.wins / totals.closedCount) * 100 : null;

  return (
    <div className="surface-scroll vy-scroll">
      <div className="stat-strip">
        <StatCell
          label="Realised PnL"
          value={formatUsd(totals.realizedPnl, { sign: true })}
          tone={totals.realizedPnl > 0 ? "up" : totals.realizedPnl < 0 ? "down" : "neutral"}
          sub="paper, all sessions"
        />
        {/* Equity first: it is what the account is worth. Cash beside it,
            because they diverge the moment a position opens — the money is
            spent, so cash alone reads as a loss. */}
        <StatCell
          label="Account value"
          value={formatUsd(totals.equity)}
          sub={
            /* "nothing open" used to be inferred from zero unrealised P&L, so an
               open position with no recent price read as nothing open while the
               Cash cell beside it said the opposite. Decide from the count. */
            totals.openCount === 0
              ? `${formatUsd(totals.cashBalance)} cash, nothing open`
              : totals.unpricedPositions === totals.openCount
                ? `${totals.openCount} open, no current price`
                : `${formatUsd(totals.unrealisedPnl, { sign: true })} unrealised`
          }
          tone={totals.unrealisedPnl > 0 ? "up" : totals.unrealisedPnl < 0 ? "down" : "neutral"}
        />
        <StatCell
          label="Cash"
          value={formatUsd(totals.cashBalance)}
          sub={
            totals.unpricedPositions > 0
              ? `${totals.unpricedPositions} position(s) valued at cost`
              : "spendable now"
          }
        />
        <StatCell
          label="Win rate"
          value={formatPct(winRate, 0)}
          sub={`${totals.wins}/${totals.closedCount} closed`}
        />
        <StatCell label="Fees paid" value={formatUsd(totals.fees)} sub="entry + exit" />
      </div>

      {/* Real account holdings, valued from the venue's tickers — execution-side
          truth, deliberately kept separate from the paper figures above so the
          two can never be mistaken for each other. */}
      <section className="panel">
        <div className="panel-header">
          <span className="label-micro">Exchange account · real holdings</span>
          <span className="ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
            not paper — this is your actual balance
          </span>
        </div>
        <div className="panel-body">
          <BalancesCard />
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="label-micro">Sessions · paper results</span>
          <label className="ml-auto flex cursor-pointer select-none items-center gap-1.5" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
            <input type="checkbox" className="accent-primary" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            include archived
          </label>
        </div>
        <table className="vy-table">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Pair</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th>Plans</th>
              <th>Armed</th>
              <th>Open</th>
              <th>Closed</th>
              <th>Win rate</th>
              <th>Fees</th>
              <th>Realised</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const wr = s.closedCount > 0 ? (s.wins / s.closedCount) * 100 : null;
              return (
                <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => onOpenSession(s)}>
                  <td className="t-text" style={{ fontWeight: 600 }}>{s.pair}</td>
                  <td className="t-text" style={{ color: s.status === "active" ? "var(--up)" : "var(--text-faint)" }}>
                    {s.status}
                  </td>
                  <td>{s.planCount}</td>
                  <td className={s.armedCount > 0 ? "v-caution" : "v-flat"}>{s.armedCount}</td>
                  <td className={s.openCount > 0 ? "v-caution" : "v-flat"}>{s.openCount}</td>
                  <td>{s.closedCount}</td>
                  <td>{formatPct(wr, 0)}</td>
                  <td style={{ color: "var(--text-faint)" }}>{formatUsd(s.fees)}</td>
                  <td className={s.realizedPnl > 0 ? "v-up" : s.realizedPnl < 0 ? "v-down" : "v-flat"}>
                    {formatUsd(s.realizedPnl, { sign: true })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sessions.length === 0 && (
          <div className="empty-state">
            <span>No sessions yet.</span>
          </div>
        )}
        <div className="panel-footer">
          <span>
            All figures are paper results, fee- and slippage-adjusted — not live performance.
          </span>
        </div>
      </section>
    </div>
  );
}
