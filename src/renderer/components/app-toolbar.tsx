import { useState } from "react";
import { Bell, FlaskConical, ShieldAlert } from "lucide-react";
import type { AlertEvent, AppMode } from "@/lib/api";
import { formatPrice } from "@/lib/format";

/**
 * App toolbar (36px) — mode, risk budget, alerts.
 *
 * Design intent: the interface must not look identical when real money is at
 * stake. The mode banner is the loudest element on screen and changes colour
 * with the mode; switching to live requires typing a confirmation phrase, in
 * the toolbar itself rather than buried in settings.
 *
 * The session's own figures sit here while one of its surfaces is open, and
 * nowhere else. They are numbers only: a bar under a figure implies a budget,
 * and there is no budget behind them until the risk engine exists. Agent spend
 * is not a trading figure, so it lives with the agent and in Settings › AI.
 */
/** The mode main is running in — read from main, never assumed here. */
export type TradingMode = AppMode;

export interface RiskChip {
  label: string;
  value: string;
  tone: "up" | "down" | "caution" | "neutral";
}

const TONE_COLOR: Record<RiskChip["tone"], string> = {
  up: "var(--up)",
  down: "var(--down)",
  caution: "var(--caution)",
  neutral: "var(--muted-foreground)",
};

interface AppToolbarProps {
  mode: TradingMode;
  /** Null disables the switch entirely (no risk engine yet → cannot go live). */
  onModeChange?: ((mode: TradingMode) => void) | null;
  riskChips: RiskChip[];
  unreadAlerts: number;
  alertsOpen: boolean;
  onToggleAlerts: () => void;
  alertHistory: AlertEvent[];
  onClearAlerts: () => void;
}

function alertTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function AppToolbar({
  mode,
  onModeChange,
  riskChips,
  unreadAlerts,
  alertsOpen,
  onToggleAlerts,
  alertHistory,
  onClearAlerts,
}: AppToolbarProps) {
  const [arming, setArming] = useState(false);
  const [typed, setTyped] = useState("");

  const confirmed = typed.trim().toUpperCase() === "GO LIVE";

  const goLive = () => {
    if (!confirmed || !onModeChange) return;
    onModeChange("live");
    setArming(false);
    setTyped("");
  };

  return (
    <header className="app-toolbar">
      <div className={`mode-banner ${mode === "live" ? "mode-banner-live" : "mode-banner-paper"}`}>
        {mode === "live" ? <ShieldAlert size={13} /> : <FlaskConical size={13} />}
        <span className="mode-banner-label">{mode === "live" ? "Live" : "Simulated"}</span>
        <span className="mode-banner-note">
          {mode === "live" ? "real funds at risk" : "no real orders"}
        </span>
      </div>

      {/* Live promotion is a two-step, typed confirmation — never one click. */}
      {mode === "simulated" && !arming && (
        <button
          className="toolbar-btn"
          onClick={() => setArming(true)}
          disabled={!onModeChange}
          title={
            onModeChange
              ? "Arm live trading"
              : "Live trading isn't available yet"
          }
          style={!onModeChange ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
        >
          <ShieldAlert size={13} /> Switch to live
        </button>
      )}

      {mode === "simulated" && arming && (
        <div className="arm-live">
          <span style={{ fontSize: "var(--text-xs)", color: "var(--muted-foreground)" }}>
            type <span className="mono" style={{ color: "var(--foreground)" }}>GO LIVE</span> to confirm
          </span>
          <input
            className="arm-live-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && goLive()}
            placeholder="GO LIVE"
            autoFocus
            spellCheck={false}
          />
          <button className="btn btn-danger" style={{ height: 24 }} disabled={!confirmed} onClick={goLive}>
            Confirm
          </button>
          <button
            className="btn btn-ghost"
            style={{ height: 24, color: "var(--text-faint)" }}
            onClick={() => {
              setArming(false);
              setTyped("");
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {mode === "live" && (
        <button className="toolbar-btn" onClick={() => onModeChange?.("simulated")}>
          <FlaskConical size={13} /> Back to simulated
        </button>
      )}

      <div className="flex-1" />

      {riskChips.length > 0 && (
        <div className="risk-chips">
          {riskChips.map((chip) => (
            <div key={chip.label} className="risk-chip">
              <span className="label-micro">{chip.label}</span>
              <span className="mono" style={{ fontSize: "var(--text-sm)", color: TONE_COLOR[chip.tone] }}>
                {chip.value}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ position: "relative", display: "flex" }}>
        <button
          className="toolbar-btn"
          style={{
            borderRight: "none",
            borderLeft: "1px solid var(--border)",
            background: alertsOpen ? "var(--surface-3)" : "transparent",
          }}
          onClick={onToggleAlerts}
          title="Alerts"
        >
          <Bell size={14} />
          {unreadAlerts > 0 && (
            <span
              className="mono"
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                color: "#080B10",
                background: "var(--accent)",
                borderRadius: "var(--radius-pill)",
                padding: "1px 6px",
              }}
            >
              {unreadAlerts}
            </span>
          )}
        </button>

        {alertsOpen && (
          <>
            {/* Click-away catcher */}
            <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={onToggleAlerts} />
            <div className="alert-popover vy-scroll">
              <div className="alert-popover-head">
                <span className="label-micro">Alerts history</span>
                <span className="mono ml-auto" style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)" }}>
                  session only
                </span>
                {alertHistory.length > 0 && (
                  <button className="btn-ghost alert-popover-clear" onClick={onClearAlerts}>
                    Clear
                  </button>
                )}
              </div>
              {alertHistory.map((a, i) => (
                <div key={`${a.alertId}-${a.triggeredAt}-${i}`} className="alert-popover-row">
                  <div className="flex items-baseline gap-1.5">
                    <span className="label-micro" style={{ color: "var(--caution)" }}>alert</span>
                    <span className="mono ml-auto" style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)" }}>
                      {alertTime(a.triggeredAt)}
                    </span>
                  </div>
                  <span style={{ fontSize: "var(--text-md)", color: "var(--text-secondary)", lineHeight: 1.45 }}>
                    {a.label}
                  </span>
                  <span className="mono" style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)" }}>
                    {a.symbol}
                    {a.currentValue !== null && a.currentValue !== undefined ? ` · now ${formatPrice(a.currentValue)}` : ""}
                  </span>
                </div>
              ))}
              {alertHistory.length === 0 && (
                <div style={{ padding: "14px 10px", fontSize: "var(--text-md)", color: "var(--text-faint)", lineHeight: 1.5 }}>
                  No alerts have fired since the app started. Active alerts are
                  listed on each session's dashboard.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </header>
  );
}
