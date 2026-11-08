import { useCallback, useEffect, useRef, useState } from "react";
import { OctagonX, ShieldCheck, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { api, isError, type OrderRecord, type Session } from "@/lib/api";

const ENFORCED_CHECKS = [
  ["Explicit Stop-Loss Gate", "GATE_1_STOP_LOSS · Hard stop required on every entry intent"],
  ["Max Position Size Cap", "GATE_2_MAX_POSITION_SIZE · Quote size capped by session risk config"],
  ["Max Daily Realized Loss Limit", "GATE_3_MAX_DAILY_LOSS · Circuit breaker halts session entries"],
  ["Max Open Positions Limit", "GATE_4_MAX_OPEN_POSITIONS · Enforces strategy & session position caps"],
  ["24-Hour Trade Frequency Cap", "GATE_5_DAILY_TRADE_COUNT · Prevents over-trading & fee decay"],
  ["Spread & Liquidity Threshold", "GATE_6_SPREAD_LIQUIDITY · Rejects entries if spread > 50 bps"],
  ["Emergency Kill Switch Check", "GATE_7_KILL_SWITCH · Immediate process-level order freeze"],
  ["Human Supervision Signature", "GATE_8_MODE_SUPERVISION · Requires manual operator sign-off"],
];

export function ApprovalsPage({ activeSession }: { activeSession?: Session | null }) {
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [killActive, setKillActive] = useState(false);
  const [killReason, setKillReason] = useState("");
  const [loading, setLoading] = useState(false);
  /* Both directions ask once. Tripping used to happen on a single click — easy
     to do by accident, and it stops every session's entries; re-arming is the
     direction that lets trading resume, so it never happens on a stray click. */
  const [confirming, setConfirming] = useState(false);

  const loadData = useCallback(async () => {
    if (activeSession) {
      const res = await api.listOrders(activeSession.id, 50);
      if (!isError(res)) setOrders(res.filter((o) => o.status === "proposed" || o.status === "approved"));
    }
    const ks = await api.getKillSwitchStatus();
    if (!isError(ks)) {
      setKillActive(ks.active);
      setKillReason(ks.reason);
    }
  }, [activeSession?.id]);

  useEffect(() => {
    void loadData();
    const timer = setInterval(() => void loadData(), 5000);
    return () => clearInterval(timer);
  }, [loadData]);

  /* The state-driven `disabled` lands after the click; ten fast clicks all got
     through before it. The ref closes that window. */
  const toggling = useRef(false);
  const handleToggleKillSwitch = async () => {
    if (toggling.current) return;
    toggling.current = true;
    setConfirming(false);
    setLoading(true);
    if (killActive) {
      const res = await api.resetKillSwitch();
      if (!isError(res)) {
        setKillActive(false);
        setKillReason("");
      }
    } else {
      const res = await api.tripKillSwitch("Manual emergency trip from Approvals page");
      if (!isError(res)) {
        setKillActive(true);
        setKillReason(res.reason);
      }
    }
    setLoading(false);
    toggling.current = false;
  };

  const handleApprove = async (orderId: number) => {
    await api.approveOrder(orderId);
    void loadData();
  };

  const handleReject = async (orderId: number) => {
    await api.rejectOrder(orderId);
    void loadData();
  };

  const proposedOrders = orders.filter((o) => o.status === "proposed");

  return (
    <div className="approvals-layout" style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 16, height: "100%", padding: "16px 16px 0" }}>
      <div className="vy-scroll" style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", overflowY: "auto" }}>
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Order intents · awaiting approval</span>
            <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: proposedOrders.length > 0 ? "var(--caution)" : "var(--text-faint)" }}>
              {proposedOrders.length}
            </span>
          </div>

          {proposedOrders.length === 0 ? (
            <div className="empty-state" style={{ padding: "32px 16px" }}>
              <ShieldCheck size={28} style={{ color: "var(--up)" }} />
              <span style={{ fontWeight: 500, color: "var(--foreground)" }}>Nothing is waiting on you.</span>
            </div>
          ) : (
            <div className="space-y-3" style={{ padding: 12 }}>
              {proposedOrders.map((o) => (
                <div key={o.id} className="approval-row">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`mono text-xs font-medium uppercase ${o.side === "buy" ? "v-up" : "v-down"}`}>
                        {o.side}
                      </span>
                      <span className="font-mono text-sm font-semibold">{o.symbol}</span>
                      <span className="text-xs text-muted-foreground">qty: {o.quantity || o.quote_amount}</span>
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">Client ID: {o.client_order_id.slice(0, 8)}...</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="btn btn-destructive-outline" onClick={() => handleReject(o.id)}>
                      <XCircle size={13} /> Reject
                    </button>
                    {/* Signing is the owner's mark: indigo. */}
                    <button className="btn btn-primary" onClick={() => handleApprove(o.id)}>
                      <CheckCircle2 size={13} /> Approve and sign
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Risk engine · safety gates</span>
            {/* Same truth as Settings › Risk limits: the gates exist and are
                tested, but order-pipeline.ts is unreferenced, so no order —
                simulated or live — passes through them. Green ticks and "these
                guard simulated trades" claimed otherwise. */}
            <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--caution)" }}>not on any order path yet</span>
          </div>
          <p style={{ margin: 0, padding: "12px 16px 4px", fontSize: "var(--text-md)", color: "var(--muted-foreground)", lineHeight: 1.5 }}>
            Eight gates, written and tested. No order passes through them yet:
            simulated fills don't, and live trading isn't built. Today a plan is
            limited by the budget you sign when you arm it, and by the kill switch.
          </p>
          <div className="gate-list">
            {ENFORCED_CHECKS.map(([label, note]) => (
              <div key={label} className="gate-row">
                <span className="gate-label">
                  <CheckCircle2 size={13} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
                  {label}
                </span>
                <span className="mono gate-note">{note}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="vy-scroll" style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", overflowY: "auto" }}>
        <section className={`panel kill-panel ${killActive ? "kill-panel-on" : ""}`}>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <OctagonX size={18} style={{ color: killActive ? "var(--down)" : "var(--muted-foreground)" }} />
              <span className="panel-title" style={{ color: killActive ? "var(--down)" : undefined }}>Emergency kill switch</span>
            </div>
            {/* The state in words — on is never only a colour. */}
            <p className="flex items-center gap-2" style={{ margin: 0 }}>
              <span className="feed-dot" style={{ background: killActive ? "var(--down)" : "var(--up)" }} />
              {killActive ? "On — no session can open a new position" : "Off — sessions can open new positions"}
            </p>
            <p style={{ margin: 0, fontSize: "var(--text-md)", lineHeight: 1.5, color: "var(--muted-foreground)" }}>
              Blocks every new entry while it is on. Open positions keep their stops and targets.
            </p>
            {killActive && killReason && (
              <div className="kill-reason">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{killReason}</span>
              </div>
            )}
            {confirming ? (
              <div className="kill-confirm" role="alertdialog" aria-label="Confirm kill switch">
                <p className="text-xs leading-relaxed">
                  {killActive
                    ? "Re-arm? Every session can open new positions again."
                    : "Trip the kill switch? No session can open a new position until you re-arm it. Open positions keep their stops and targets."}
                </p>
                <div className="flex gap-2">
                  <button
                    autoFocus
                    disabled={loading}
                    onClick={handleToggleKillSwitch}
                    className={`btn flex-1 justify-center ${killActive ? "" : "btn-danger"}`}
                    style={{ height: 36 }}
                  >
                    {killActive ? "Re-arm" : "Trip kill switch"}
                  </button>
                  <button className="btn btn-ghost flex-1 justify-center" style={{ height: 36 }} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                disabled={loading}
                onClick={() => setConfirming(true)}
                className={`btn w-full justify-center ${killActive ? "" : "kill-trip"}`}
                style={{ height: 44 }}
              >
                {killActive ? "Re-arm new entries" : "Trip the kill switch"}
              </button>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="label-micro">Away policy</span>
          </div>
          <div className="panel-body" style={{ fontSize: "var(--text-md)", color: "var(--muted-foreground)", lineHeight: 1.6 }}>
            {/* No away-policy control exists anywhere in the app, so this panel
                must not say one is chosen here (it used to, "per strategy").
                It says what actually happens. */}
            Armed plans run as signed while the app is open. While it is
            closed nothing is watched; on the next launch plans resume and the
            gap is recorded in engine activity.
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="label-micro">Escalation</span>
          </div>
          <div className="panel-body" style={{ fontSize: "var(--text-md)", color: "var(--muted-foreground)", lineHeight: 1.6 }}>
            {/* True to src/main/notify/: alert and paper-fill messages go through
                the outbox to Telegram when it is configured. The app quits on
                window close (main.ts), so nothing is watched or sent while it
                is closed — the copy must not promise otherwise. */}
            Alerts and fills always show in the app. Connect Telegram in
            Settings to get them on your phone as well. The app watches only
            while it is open, so keep it running to be told.
          </div>
        </section>
      </div>
    </div>
  );
}
