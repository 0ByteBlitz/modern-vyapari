import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, FlaskConical, LineChart, Sparkles } from "lucide-react";
import {
  api,
  isError,
  type PortfolioSummary,
  type ActivityEvent,
  type SetupStatus,
  type SessionSummary,
} from "@/lib/api";
import { formatUsd, formatPct } from "@/lib/format";
import { describeActivity, ACTIVITY_TONE_COLOR } from "@/lib/activity";

/**
 * Home — the landing surface.
 *
 * The app used to open straight into whichever session was last selected,
 * which answers "what is ARB-USD doing" before you've asked it. This answers
 * the question you actually have on launch: *what happened while I was away,
 * and does anything need me?*
 *
 * Four bands, in order of urgency:
 *   1. Needs attention — the only place that asks for action
 *   2. While you were away — what the engines did unattended
 *   3. Sessions — pick where to work
 *   4. Markets — a reason to look outward
 *
 * Everything here is read-only and cross-session; work happens inside a
 * session, which is why every card is a doorway rather than a control.
 */

interface Attention {
  tone: "caution" | "info";
  text: string;
  action?: { label: string; go: () => void };
}

function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** One word for a session card. An open position outranks an armed plan:
 *  it is the state with money in it. Never "idle" while either exists. */
function sessionState(s: SessionSummary): string {
  if (s.openCount > 0 && s.armedCount > 0) return "in position · armed";
  if (s.openCount > 0) return "in position";
  if (s.armedCount > 0) return "armed";
  return "idle";
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Late session";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function HomePage({
  setup,
  onOpenSession,
  onNavigate,
}: {
  setup: SetupStatus | null;
  onOpenSession: (sessionId: number) => void;
  onNavigate: (surface: "markets" | "portfolio" | "settings" | "approvals") => void;
}) {
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [movers, setMovers] = useState<{ symbol: string; change24h: number; volume24h: number }[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [p, a, t] = await Promise.all([
      api.portfolioSummary(false),
      api.listActivity(12),
      api.getTickerSnapshot(),
    ]);
    if (!isError(p)) setPortfolio(p);
    if (!isError(a)) setActivity(a);
    if (!isError(t)) {
      const liquid = t.filter((x) => x.volume24h > 5_000_000);
      setMovers([...liquid].sort((x, y) => Math.abs(y.change24h) - Math.abs(x.change24h)).slice(0, 6));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [load]);

  const sessions = portfolio?.sessions ?? [];
  const totals = portfolio?.totals;

  /* What needs you. Ordered by consequence, and deliberately empty-able —
     a permanent list of nags trains you to ignore it. */
  const attention: Attention[] = [];

  if (setup && !setup.ai.configured) {
    attention.push({
      tone: "caution",
      text: `The AI agent isn't set up (${setup.ai.displayName}), so chat and trade reviews won't run.`,
      action: { label: "Add key", go: () => onNavigate("settings") },
    });
  }
  /* Only when a venue is actually required. In simulated mode not connecting
     one is a valid choice, not something that needs attention. */
  if (setup && setup.venue.required && !setup.venue.configured) {
    attention.push({
      tone: "caution",
      text: `${setup.venue.displayName} isn't connected — balances and execution data are unavailable.`,
      action: { label: "Connect", go: () => onNavigate("settings") },
    });
  }

  const armedTotal = sessions.reduce((n, s) => n + s.armedCount, 0);
  const plansTotal = sessions.reduce((n, s) => n + s.planCount, 0);
  const openTotal = sessions.reduce((n, s) => n + s.openCount, 0);

  if (sessions.length > 0 && armedTotal === 0 && openTotal === 0 && plansTotal > 0) {
    attention.push({
      tone: "info",
      text: `${plansTotal} ${plansTotal === 1 ? "plan is" : "plans are"} drafted but none is armed — nothing will trigger.`,
    });
  }
  if (sessions.length === 0) {
    attention.push({ tone: "info", text: "No sessions yet. Create one to start tracking a pair." });
  }

  const unclosed = sessions.filter((s) => s.openCount > 0);
  if (unclosed.length > 0) {
    attention.push({
      tone: "info",
      text: `${unclosed.length} session${unclosed.length === 1 ? "" : "s"} with an open paper position.`,
    });
  }

  /* Routine startup and configuration entries are not "what happened while you
     were away" — they happen on every launch and there is nothing to act on.
     The full record stays in Settings › Audit log. */
  const awayActivity = activity
    .map((ev) => ({ ev, d: describeActivity(ev) }))
    .filter((a) => !a.d.chore);

  return (
    <div className="home vy-scroll">
      {/* ── header ── */}
      <header className="home-head">
        <div>
          <h1 className="home-title">{greeting()}</h1>
          <p className="home-sub">
            {loading
              ? "Checking on things…"
              : sessions.length === 0
                ? "Nothing is running. Everything below is read-only until you create a session."
                : `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${armedTotal} armed ${armedTotal === 1 ? "plan" : "plans"} · ${setup?.mode === "live" ? "live" : "simulated"} mode`}
          </p>
        </div>
        <div className="home-actions">
          <button className="btn" onClick={() => onNavigate("markets")}>
            <LineChart size={13} /> Markets
          </button>
          <button className="btn" onClick={() => onNavigate("portfolio")}>
            Portfolio
          </button>
        </div>
      </header>

      {/* ── 1. needs attention ── */}
      {attention.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <span className="label-micro">Needs your attention</span>
            <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
              {attention.length}
            </span>
          </div>
          <div className="panel-body-flush">
            {attention.map((a, i) => (
              <div key={i} className="home-attention-row">
                {a.tone === "caution" ? (
                  <AlertTriangle size={13} style={{ color: "var(--caution)", flexShrink: 0 }} />
                ) : (
                  <Sparkles size={13} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
                )}
                <span>{a.text}</span>
                {a.action && (
                  <button className="btn ml-auto" onClick={a.action.go}>
                    {a.action.label}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 2. paper state + what happened ── */}
      <div className="home-split">
        <section className="panel">
          <div className="panel-header">
            <span className="label-micro">Paper performance · all sessions</span>
          </div>
          <div className="stat-strip" style={{ border: "none", borderRadius: 0 }}>
            <div className="stat-cell">
              <span className="label-micro">Realised</span>
              <span
                className="mono stat-cell-value"
                style={{
                  color: !totals ? "var(--text-secondary)" : totals.realizedPnl > 0 ? "var(--up)" : totals.realizedPnl < 0 ? "var(--down)" : "var(--text-secondary)",
                }}
              >
                {totals ? formatUsd(totals.realizedPnl, { sign: true }) : "—"}
              </span>
            </div>
            <div className="stat-cell">
              <span className="label-micro">Closed</span>
              <span className="mono stat-cell-value">{totals?.closedCount ?? "—"}</span>
            </div>
            <div className="stat-cell">
              <span className="label-micro">Win rate</span>
              <span className="mono stat-cell-value">
                {totals && totals.closedCount > 0 ? formatPct((totals.wins / totals.closedCount) * 100, 0) : "—"}
              </span>
            </div>
            <div className="stat-cell">
              <span className="label-micro">Open</span>
              <span className="mono stat-cell-value" style={{ color: totals?.openCount ? "var(--caution)" : undefined }}>
                {totals?.openCount ?? "—"}
              </span>
            </div>
          </div>
          <div className="panel-footer">
            {totals?.closedCount === 0
              ? "No paper trades yet — these fill in once an armed plan takes a position."
              : "Simulated fills, fee- and slippage-adjusted. Not live performance."}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="label-micro">While you were away</span>
            <span className="ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
              engine activity
            </span>
          </div>
          <div className="panel-body-flush vy-scroll" style={{ maxHeight: 220 }}>
            {awayActivity.map(({ ev, d }) => (
              /* A window where nothing was watching is not the same fact as a
                 window where nothing happened, and the row must not read like
                 one. Plans are only evaluated while the app runs. */
              <div key={ev.id} className={`home-activity-row ${ev.action === "monitor_gap" ? "home-activity-gap" : ""}`}>
                <span className="mono" style={{ color: "var(--text-faint)", width: 62, flexShrink: 0 }}>
                  {relTime(ev.created_at)}
                </span>
                {/* The sentence, from the row's own payload. This used to print
                    the action NAME, which is why the panel read as a list of
                    function calls rather than an account of what happened. */}
                <span style={{ color: ACTIVITY_TONE_COLOR[d.tone] }}>{d.text}</span>
              </div>
            ))}
            {awayActivity.length === 0 && (
              <div className="empty-state" style={{ padding: "18px 12px" }}>
                <CheckCircle2 size={16} style={{ color: "var(--text-ghost)" }} />
                <span>Nothing happened while you were away.</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── 3. sessions ── */}
      <section className="panel">
        <div className="panel-header">
          <span className="label-micro">Sessions</span>
          <span className="ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
            pick one to start working
          </span>
        </div>
        <div className="home-sessions">
          {sessions.map((s: SessionSummary) => (
            <button key={s.id} className="home-session-card" onClick={() => onOpenSession(s.id)}>
              <div className="home-session-top">
                <span className="home-session-pair">{s.pair}</span>
                <span
                  className={`badge ${s.armedCount > 0 || s.openCount > 0 ? "badge-paper" : "badge-draft"}`}
                  style={{ marginLeft: "auto" }}
                >
                  {sessionState(s)}
                </span>
              </div>
              <div className="home-session-stats mono">
                <span
                  style={{
                    color: s.realizedPnl > 0 ? "var(--up)" : s.realizedPnl < 0 ? "var(--down)" : "var(--text-faint)",
                  }}
                >
                  {formatUsd(s.realizedPnl, { sign: true })}
                </span>
                <span style={{ color: "var(--text-faint)" }}>
                  {s.closedCount} closed · {s.openCount} open
                </span>
              </div>
              <div className="home-session-meta">
                {s.planCount} {s.planCount === 1 ? "plan" : "plans"}
                {s.lastActivityAt ? ` · last ${relTime(s.lastActivityAt)}` : " · no activity yet"}
                <ArrowRight size={12} className="ml-auto" />
              </div>
            </button>
          ))}

          {sessions.length === 0 && (
            <div className="empty-state" style={{ gridColumn: "1 / -1" }}>
              <FlaskConical size={18} style={{ color: "var(--text-ghost)" }} />
              <span>No sessions yet.</span>
              <span style={{ fontSize: "var(--text-sm)", color: "var(--text-ghost)" }}>
                Create one from the rail — a session is one pair and its own strategies, journal and memory.
              </span>
            </div>
          )}
        </div>
      </section>

      {/* ── 4. markets ── */}
      <section className="panel">
        <div className="panel-header">
          <span className="label-micro">Biggest movers · 24h</span>
          <button className="btn ml-auto" onClick={() => onNavigate("markets")}>
            <LineChart size={13} /> All markets
          </button>
        </div>
        <div className="home-movers">
          {movers.map((m) => (
            <div key={m.symbol} className="home-mover">
              <span style={{ fontWeight: 600 }}>{m.symbol}</span>
              <span className={`mono ${m.change24h >= 0 ? "v-up" : "v-down"}`}>
                {formatPct(m.change24h, 2, true)}
              </span>
            </div>
          ))}
          {movers.length === 0 && (
            <span style={{ fontSize: "var(--text-md)", color: "var(--text-faint)", padding: "10px 12px" }}>
              {loading ? "Loading markets…" : "Market data unavailable."}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
