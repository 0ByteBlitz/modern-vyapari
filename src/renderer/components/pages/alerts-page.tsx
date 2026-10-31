import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, CheckCircle2, AlertTriangle, Trash2, Plus, RefreshCw, Zap, Volume2 } from "lucide-react";
import { api, isError, type Session, type AlertRecord } from "@/lib/api";
import { testAlertSound } from "@/lib/alert-sound";
import { describeThreshold } from "@shared/levels";

export function AlertsPage({ activeSession }: { activeSession: Session | null }) {
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "triggered">("all");

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listAlerts(activeSession?.id);
      if (!isError(res)) setAlerts(res);
    } finally {
      setLoading(false);
    }
  }, [activeSession?.id]);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  /* Real-time update listener when agent manages alerts */
  useEffect(() => {
    return api.onDataUpdated((data) => {
      if (data.kind === "alert") void loadAlerts();
    });
  }, [loadAlerts]);

  const removeAlert = async (id: number) => {
    await api.removeAlert(id);
    void loadAlerts();
  };

  const clearAll = async () => {
    if (confirm("Are you sure you want to remove all alerts for this session?")) {
      await Promise.all(alerts.map((a) => api.removeAlert(a.id)));
      void loadAlerts();
    }
  };

  const activeAlerts = alerts.filter((a) => a.status === "active");
  const triggeredAlerts = alerts.filter((a) => a.status === "triggered");

  const displayedAlerts =
    filter === "active" ? activeAlerts : filter === "triggered" ? triggeredAlerts : alerts;

  return (
    <div className="vy-scroll" style={{ padding: 24, flex: 1, height: "100%", overflowY: "auto", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header & Stats */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontSize: "var(--text-xl)", fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
            <Bell size={20} style={{ color: "var(--accent)" }} />
            <span>Alert Rules & Triggers · {activeSession ? activeSession.pair : "All Sessions"}</span>
          </h2>
          <p style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)", marginTop: 4 }}>
            Real-time streaming alert rules monitored by Binance WebSocket & indicator engine.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => testAlertSound()} className="btn btn-secondary" title="Test alert audio chime">
            <Volume2 size={14} style={{ color: "var(--accent)" }} />
            <span>Test Sound</span>
          </button>
          <button onClick={() => void loadAlerts()} className="btn btn-secondary" title="Refresh alerts">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            <span>Refresh</span>
          </button>
          {alerts.length > 0 && (
            <button onClick={clearAll} className="btn" style={{ color: "var(--down)", borderColor: "rgba(242,86,106,0.3)" }}>
              <Trash2 size={14} />
              <span>Clear All</span>
            </button>
          )}
        </div>
      </div>

      {/* Summary Stat Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        <div className="panel" style={{ padding: 16, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: "var(--radius-md)", background: "rgba(34,211,238,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Zap size={20} style={{ color: "var(--accent)" }} />
          </div>
          <div>
            <div className="mono" style={{ fontSize: "var(--text-xl)", fontWeight: 700 }}>{activeAlerts.length}</div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>Active Condition Rules</div>
          </div>
        </div>

        <div className="panel" style={{ padding: 16, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: "var(--radius-md)", background: "rgba(47,204,139,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CheckCircle2 size={20} style={{ color: "var(--up)" }} />
          </div>
          <div>
            <div className="mono" style={{ fontSize: "var(--text-xl)", fontWeight: 700 }}>{triggeredAlerts.length}</div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>Triggered Alerts</div>
          </div>
        </div>

        <div className="panel" style={{ padding: 16, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: "var(--radius-md)", background: "rgba(139,92,246,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Bell size={20} style={{ color: "var(--ai)" }} />
          </div>
          <div>
            <div className="mono" style={{ fontSize: "var(--text-xl)", fontWeight: 700 }}>Binance WS</div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>Connected & Streaming</div>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: "flex", gap: 8 }}>
        {[
          { id: "all", label: `All Alerts (${alerts.length})` },
          { id: "active", label: `Active (${activeAlerts.length})` },
          { id: "triggered", label: `Triggered (${triggeredAlerts.length})` },
        ].map((t) => (
          <button
            key={t.id}
            className={`chip ${filter === t.id ? "chip-active" : ""}`}
            onClick={() => setFilter(t.id as any)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Alerts Table / List */}
      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        {displayedAlerts.length === 0 ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <BellOff size={24} style={{ color: "var(--text-faint)", opacity: 0.5 }} />
            <span>No alerts found for this filter.</span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-ghost)" }}>
              Ask the agent to set an alert (e.g. "Alert me if RSI crosses below 30"), or set one on the Research chart.
            </span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {displayedAlerts.map((a) => {
              const cond = typeof a.condition === "string" ? (() => { try { return JSON.parse(a.condition); } catch { return null; } })() : a.condition;
              const indicatorName = (cond?.indicator || "price").toUpperCase();
              const opText = (cond?.operator || "").replace(/_/g, " ");
              const valText = describeThreshold(cond?.value);

              return (
                <div
                  key={a.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "14px 18px",
                    borderBottom: "1px solid var(--border)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: a.status === "active" ? "var(--up)" : "var(--caution)",
                        flexShrink: 0,
                      }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, color: "var(--foreground)", fontSize: "var(--text-md)" }}>
                        {a.label}
                      </div>
                      <div className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)", marginTop: 2 }}>
                        {a.symbol || activeSession?.pair || "BTC-USD"} · {indicatorName} {opText} {valText}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    {/* An alert is watching or it is not. It was previously
                        styled with the strategy lifecycle's "backtested" badge,
                        which named a state alerts never had. */}
                    <span className={`badge badge-${a.status === "active" ? "paper" : "draft"}`}>
                      {a.status}
                    </span>
                    <button
                      onClick={() => removeAlert(a.id)}
                      style={{ background: "none", border: "none", color: "var(--text-faint)", cursor: "pointer", padding: 4 }}
                      className="hover:text-red-400"
                      title="Delete alert"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
