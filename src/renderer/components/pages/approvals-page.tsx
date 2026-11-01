import { useCallback, useEffect, useState } from "react";
import { OctagonX, ShieldCheck, Gavel, Info, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { api, isError, type OrderRecord, type Session } from "@/lib/api";
import { Button } from "@/components/ui/button";

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

  const handleToggleKillSwitch = async () => {
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
    <div className="approvals-layout" style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 16, height: "100%", padding: 16 }}>
      <div className="vy-scroll" style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", overflowY: "auto" }}>
        <section className="panel panel-approval border rounded-lg p-4 bg-card">
          <div className="panel-header flex items-center justify-between border-b pb-3 mb-3">
            <div className="flex items-center gap-2">
              <Gavel size={16} className="text-amber-500" />
              <span className="font-semibold text-sm">Order Intents · Awaiting Approval</span>
            </div>
            <span className="mono text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 font-bold">
              {proposedOrders.length}
            </span>
          </div>

          {proposedOrders.length === 0 ? (
            <div className="empty-state flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <ShieldCheck size={32} className="text-emerald-500 mb-2" />
              <span className="text-base font-medium text-foreground">No Pending Intents</span>
              <span className="text-xs text-muted-foreground max-w-sm mt-1">
                Nothing is waiting on you.
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              {proposedOrders.map((o) => (
                <div key={o.id} className="p-3 border rounded bg-background flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-bold uppercase px-1.5 py-0.5 rounded ${o.side === "buy" ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"}`}>
                        {o.side}
                      </span>
                      <span className="font-mono text-sm font-semibold">{o.symbol}</span>
                      <span className="text-xs text-muted-foreground">qty: {o.quantity || o.quote_amount}</span>
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">Client ID: {o.client_order_id.slice(0, 8)}...</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" className="text-xs text-rose-500 border-rose-500/30 hover:bg-rose-500/10" onClick={() => handleReject(o.id)}>
                      <XCircle size={13} className="mr-1" /> Reject
                    </Button>
                    <Button size="sm" className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => handleApprove(o.id)}>
                      <CheckCircle2 size={13} className="mr-1" /> Approve & Sign
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel border rounded-lg p-4 bg-card">
          <div className="panel-header flex items-center justify-between border-b pb-3 mb-3">
            <span className="font-semibold text-sm">Risk Engine · Safety Gates</span>
            <span className="text-xs text-emerald-500 font-mono">8 / 8 implemented</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed mb-3">
            Every gate runs on each order the pipeline receives. Live orders
            don't exist yet, so today these guard simulated trades.
          </p>
          <div className="space-y-2">
            {ENFORCED_CHECKS.map(([label, note]) => (
              <div key={label} className="flex items-center justify-between p-2 rounded bg-background/50 border text-xs">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                  <span className="font-medium text-foreground">{label}</span>
                </div>
                <span className="text-muted-foreground font-mono text-[11px]">{note}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="vy-scroll" style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", overflowY: "auto" }}>
        <section className={`panel border rounded-lg p-4 ${killActive ? "bg-rose-950/20 border-rose-500/50" : "bg-card border-border"}`}>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <OctagonX size={18} className={killActive ? "text-rose-500 animate-pulse" : "text-muted-foreground"} />
              <span className={`font-bold text-sm uppercase tracking-wide ${killActive ? "text-rose-500" : "text-foreground"}`}>
                Emergency Kill Switch
              </span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Blocks every new entry while it is on.
            </p>
            <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
              Open positions are still managed — stops and targets keep firing.
            </p>
            {killActive && (
              <div className="p-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold">Kill Switch Active</span>
                  <p className="text-[11px] text-rose-300/80 mt-0.5">{killReason}</p>
                </div>
              </div>
            )}
            <Button
              disabled={loading}
              onClick={handleToggleKillSwitch}
              className={`w-full font-bold text-xs h-10 tracking-wider ${
                killActive ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-rose-600 hover:bg-rose-700 text-white"
              }`}
            >
              {killActive ? "RE-ARM SYSTEM OPERATION" : "TRIP EMERGENCY KILL SWITCH"}
            </Button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="label-micro">Away policy</span>
          </div>
          <div className="panel-body" style={{ fontSize: "var(--text-md)", color: "var(--muted-foreground)", lineHeight: 1.6 }}>
            What the bot may do while you're not watching — flatten on a stale
            feed, hold and alert, or halt the session — is chosen here, per
            strategy.
            <div style={{ marginTop: 8, color: "var(--text-faint)", fontSize: "var(--text-xs)" }}>
              Chosen now, while you are calm — never decided by an AI at 3am.
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="label-micro">Escalation</span>
          </div>
          <div className="panel-body" style={{ fontSize: "var(--text-md)", color: "var(--muted-foreground)", lineHeight: 1.6 }}>
            In-app toasts work today. Out-of-app channels — the ones that matter
            when the app isn't open — are not built yet.
          </div>
        </section>
      </div>
    </div>
  );
}
