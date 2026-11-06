import { useCallback, useEffect, useState } from "react";
import { BellOff, Trash2, Volume2 } from "lucide-react";
import { api, isError, type Session, type AlertRecord, type FeedHealth } from "@/lib/api";
import { testAlertSound } from "@/lib/alert-sound";
import { describeThreshold } from "@shared/levels";
import { RefreshButton } from "@/components/refresh-button";

export function AlertsPage({ activeSession }: { activeSession: Session | null }) {
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [filter, setFilter] = useState<"all" | "active" | "triggered">("all");

  const loadAlerts = useCallback(async () => {
    const res = await api.listAlerts(activeSession?.id);
    if (isError(res)) return false;
    setAlerts(res);
    return true;
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

  const pair = activeSession ? activeSession.pair : "all sessions";
  const tabs = [
    { id: "all" as const, label: "All", n: alerts.length },
    { id: "active" as const, label: "Active", n: activeAlerts.length },
    { id: "triggered" as const, label: "Triggered", n: triggeredAlerts.length },
  ];

  return (
    <div className="vy-scroll surface-page">
      <div className="surface-head">
        <div>
          <h1 className="surface-title">Alert rules · {pair}</h1>
          <p className="surface-sub">Checked against the Binance stream and the indicator engine.</p>
          {/* An alert near a plan's trigger looks like part of the plan, so
              removing it reads as weakening the plan. It isn't: plans run on
              their own signed terms and alerts are not linked to them. */}
          <p className="surface-sub">
            Alerts only notify. An armed plan runs on its own signed terms, so removing an alert never changes a plan.
          </p>
        </div>
        <div className="surface-actions">
          <button onClick={() => testAlertSound()} className="btn" title="Play the alert chime">
            <Volume2 size={13} /> Test sound
          </button>
          <RefreshButton onRefresh={loadAlerts} title="Refresh alerts" className="btn" size={13} />
          {alerts.length > 0 && (
            <button onClick={clearAll} className="btn btn-destructive-outline">
              <Trash2 size={13} /> Clear all
            </button>
          )}
        </div>
      </div>

      <div className="stat-cards">
        <div className="panel stat-card">
          <span className="mono stat-card-value">{activeAlerts.length}</span>
          <span className="stat-card-label">Active rules</span>
        </div>
        <div className="panel stat-card">
          <span className="mono stat-card-value">{triggeredAlerts.length}</span>
          <span className="stat-card-label">Triggered</span>
        </div>
        <StreamCard />
      </div>

      <div className="pill-tabs" role="tablist" aria-label="Alert filter">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={filter === t.id}
            className={`pill-tab ${filter === t.id ? "pill-tab-on" : ""}`}
            onClick={() => setFilter(t.id)}
          >
            {t.label} <span className="mono pill-tab-n">{t.n}</span>
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
              Ask the agent to set one — for example, "alert me if RSI crosses below 30".
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
                    borderBottom: "1px solid var(--border-subtle)",
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
                    <span className={`badge badge-${a.status === "active" ? "watching" : "draft"}`}>
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

/** The Binance stream's real state — alerts are evaluated on it, so a card that
 *  says "connected" must have asked. It used to be a fixed string. */
const STREAM_TEXT: Record<FeedHealth["socket"]["state"], { tone: string; title: string; note: string }> = {
  live: { tone: "var(--up)", title: "Binance stream", note: "Connected and streaming" },
  connecting: { tone: "var(--caution)", title: "Binance stream", note: "Connecting" },
  silent: { tone: "var(--caution)", title: "Binance stream", note: "Open but sending nothing — reconnecting" },
  down: { tone: "var(--down)", title: "Binance stream", note: "Disconnected — retrying" },
  idle: { tone: "var(--text-faint)", title: "Binance stream", note: "Nothing streaming" },
};

function StreamCard() {
  const [state, setState] = useState<FeedHealth["socket"]["state"] | "unknown">("unknown");
  useEffect(() => {
    let live = true;
    const read = () =>
      void api.getFeedStream().then((r) => {
        if (live) setState(isError(r) ? "unknown" : r.socket.state);
      });
    read();
    const id = setInterval(read, 5_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  const t = state === "unknown" ? { tone: "var(--text-faint)", title: "Binance stream", note: "State unavailable" } : STREAM_TEXT[state];
  return (
    <div className="panel stat-card">
      <span className="stat-card-stream">
        <span className="feed-dot" style={{ background: t.tone }} />
        {t.title}
      </span>
      <span className="stat-card-label">{t.note}</span>
    </div>
  );
}
