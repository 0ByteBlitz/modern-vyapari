import { useCallback, useEffect, useState } from "react";
import { api, isError, type Session, type OrderRecord, type PaperStats } from "@/lib/api";
import { formatPrice, formatQty, formatUsd, formatPct } from "@/lib/format";

/**
 * Orders & fills — every order this session's strategies have placed.
 *
 * Split out of the old Bot page: an order log is a reference surface you scan
 * chronologically, which is a different job from designing a strategy. Mixing
 * them meant neither had room.
 */
function clock(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function StatCell({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "neutral" }) {
  const color = tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : "var(--text-secondary)";
  return (
    <div className="stat-cell">
      <span className="label-micro">{label}</span>
      <span className="mono stat-cell-value" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

export function OrdersPage({ activeSession }: { activeSession: Session | null }) {
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [stats, setStats] = useState<PaperStats | null>(null);

  const load = useCallback(async () => {
    if (!activeSession) return;
    const [o, s] = await Promise.all([api.listOrders(activeSession.id), api.getPaperStats(activeSession.id)]);
    if (!isError(o)) setOrders(o);
    if (!isError(s)) setStats(s);
  }, [activeSession?.id]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  if (!activeSession) {
    return (
      <div className="empty-state">
        <span style={{ fontSize: "var(--text-lg)", color: "var(--muted-foreground)" }}>No session selected</span>
        <span>Orders are scoped to a session — pick one in the rail.</span>
      </div>
    );
  }

  return (
    <div className="surface-scroll vy-scroll">
      <div className="stat-strip">
        <StatCell
          label="Realised PnL"
          value={stats ? formatUsd(stats.realizedPnl, { sign: true }) : "—"}
          tone={!stats ? "neutral" : stats.realizedPnl > 0 ? "up" : stats.realizedPnl < 0 ? "down" : "neutral"}
        />
        <StatCell label="Trades" value={stats ? `${stats.closedCount} closed · ${stats.openCount} open` : "—"} />
        <StatCell
          label="Win rate"
          value={stats && stats.closedCount > 0 ? formatPct(stats.winRate, 0) : "—"}
        />
        <StatCell label="Fees paid" value={formatUsd(stats?.totalFees)} />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="label-micro">Order history · {activeSession.pair}</span>
          <span className="ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
            every order this session's strategies have placed
          </span>
        </div>
        {orders.length > 0 ? (
          <table className="vy-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Time</th>
                <th style={{ textAlign: "left" }}>Pair</th>
                <th style={{ textAlign: "left" }}>Side</th>
                <th>Size</th>
                <th>Price</th>
                <th>Fee</th>
                <th style={{ textAlign: "left" }}>Strategy</th>
                <th style={{ textAlign: "left" }}>Status</th>
                <th style={{ textAlign: "left" }}>Venue</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="t-text mono" style={{ color: "var(--muted-foreground)", fontSize: "var(--text-sm)" }}>
                    {clock(o.created_at)}
                  </td>
                  <td className="t-text" style={{ fontWeight: 600 }}>{o.symbol}</td>
                  <td className="t-text">
                    <span className={o.side === "buy" ? "v-up" : "v-down"} style={{ fontWeight: 700, textTransform: "uppercase", fontSize: "var(--text-micro)", letterSpacing: "0.07em" }}>
                      {o.side}
                    </span>
                  </td>
                  <td>{formatQty(o.quantity)}</td>
                  <td>{formatPrice(o.price)}</td>
                  <td style={{ color: "var(--text-faint)" }}>{formatUsd(o.fee)}</td>
                  <td className="t-text" style={{ color: "var(--muted-foreground)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {o.strategy_name ?? "—"}
                  </td>
                  <td className="t-text" style={{ color: o.status === "filled" ? "var(--up)" : "var(--muted-foreground)" }}>
                    {o.status}
                  </td>
                  <td className="t-text" style={{ color: "var(--text-faint)" }}>
                    {o.mode === "paper" ? "simulated" : "Revolut X"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <span>No orders placed for {activeSession.pair} yet.</span>
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-ghost)" }}>
              Arm a plan and its fills appear here when a branch triggers.
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
