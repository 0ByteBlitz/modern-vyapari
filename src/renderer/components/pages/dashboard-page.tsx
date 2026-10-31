import { useCallback, useEffect, useState } from "react";
import { Gavel, Sparkles, Clock, ShieldCheck, AlertTriangle } from "lucide-react";
import { PaperEquityChart } from "@/components/paper-equity-chart";
import { PlanWatchPanel } from "@/components/plan-watch-panel";
import { PlanDetail } from "@/components/plan-detail";
import { UsagePanel } from "@/components/usage-panel";
import {
  api,
  isError,
  type Session,
  type AlertRecord,
  type PaperPositionRecord,
  type ActivityEvent,
  type JournalEntry,
  type PaperEquityPoint,
  type StoredPlanView,
} from "@/lib/api";
import { formatPrice, formatQty } from "@/lib/format";
import { describeActivity, ACTIVITY_TONE_COLOR } from "@/lib/activity";

/**
 * Session dashboard — the answer to "what is the bot doing right now, and
 * what is it about to do?".
 *
 * Three columns, in order of how urgently they need you:
 *   1. What is watching   — paper equity, alerts
 *   2. What is happening  — armed plans as distances, open positions, activity
 *   3. What needs you     — pending approvals, then the AI's latest reviews
 *
 * The approvals panel is deliberately the loudest thing on the screen: it is
 * the only place the app asks for a decision.
 *
 * **The candle chart was removed on 2026-08-01** (owner decision) and replaced
 * by `PlanWatchPanel`. Rationale in that file; the short version is that Home
 * answers "what is this pair doing" before you ask, Research answers it
 * properly, and what a session dashboard actually needs to say is how far price
 * is from the levels an armed plan cares about.
 *
 * **The strategy panels were deleted on 2026-08-05** (owner decision: one
 * object, the trading plan). "Armed strategies" and the paper-vs-backtest card
 * are gone, along with the Workbench surface. The engine code stays frozen and
 * shared; what was removed is the *second object on screen*, which is what made
 * the product read as two competing answers to the same question.
 */
function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function DashboardPage({ activeSession }: { activeSession: Session | null }) {
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [positions, setPositions] = useState<PaperPositionRecord[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [reviews, setReviews] = useState<JournalEntry[]>([]);
  const [equityPoints, setEquityPoints] = useState<PaperEquityPoint[]>([]);
  const [plans, setPlans] = useState<StoredPlanView[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  /* One open detail at a time, whichever kind. Two modals stacked would make
     "which thing am I looking at" ambiguous, which is the one thing no surface
     here may be. */
  const [planDetail, setPlanDetail] = useState<StoredPlanView | null>(null);
  const [showChores, setShowChores] = useState(false);

  const load = useCallback(async () => {
    if (!activeSession) return;
    const [al, pos, act, rev, eq, pl, candles] = await Promise.all([
      api.listAlerts(activeSession.id),
      api.listPaperPositions(activeSession.id),
      api.listActivity(40),
      api.listJournal(activeSession.id, { kind: "trade_review", limit: 6 }),
      api.getPaperEquityCurve(activeSession.id),
      api.listPlans(activeSession.id),
      /* The **analysis** feed, deliberately — plan levels resolve from this
         history, and measuring the gap to one with a venue quote would mix two
         sources inside a single number. Two bars is enough for a last close;
         this is a price readout, not a chart. */
      api.getAnalysisCandles(activeSession.pair, 60, 2),
    ]);
    if (!isError(al)) setAlerts(al);
    if (!isError(pos)) setPositions(pos);
    if (!isError(act)) setActivity(act);
    if (!isError(rev)) setReviews(rev);
    if (!isError(eq)) setEquityPoints(eq);
    if (!isError(pl)) setPlans(pl);
    /* A pair with no analysis feed (non-USD quote) leaves this null, and the
       panel says distances cannot be measured rather than showing zeroes. */
    if (!isError(candles) && candles.length > 0) {
      const close = Number(candles[candles.length - 1]!.close);
      setPrice(Number.isFinite(close) ? close : null);
    } else {
      setPrice(null);
    }
  }, [activeSession?.id, activeSession?.pair]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  if (!activeSession) {
    return (
      <div className="empty-state">
        <span style={{ fontSize: "var(--text-lg)", color: "var(--muted-foreground)" }}>No session selected</span>
        <span>Pick a session in the rail, or create one, to see what the bot is doing.</span>
      </div>
    );
  }

  const describedActivity = activity.map((ev) => ({ ev, d: describeActivity(ev) }));
  const shownActivity = showChores ? describedActivity : describedActivity.filter((a) => !a.d.chore);
  const openPositions = positions.filter((p) => p.status === "open");
  const liveAlerts = alerts.filter((a) => a.status === "active");

  return (
    <div className="cockpit">
      {/* ── col 1 · what is armed ─────────────────────────────── */}
      <div className="cockpit-col">
        <PaperEquityChart points={equityPoints} />

        {/* What the agent has cost. Next to the equity curve because the two
            are read together: a strategy that earns less than its own research
            bill is worth knowing about. */}
        <UsagePanel />

        <section className="panel" style={{ flex: 1 }}>
          <div className="panel-header">
            <span className="label-micro">Alerts watching</span>
            <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
              {liveAlerts.length} live
            </span>
          </div>
          <div className="panel-body-flush vy-scroll" style={{ flex: 1 }}>
            {liveAlerts.map((a) => (
              <div key={a.id} className="cockpit-row-tight">
                <span style={{ fontSize: "var(--text-base)" }}>{a.label}</span>
                <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--muted-foreground)" }}>
                  {a.symbol} · {a.intervalMin}m
                </span>
              </div>
            ))}
            {liveAlerts.length === 0 && (
              <div style={{ padding: "14px 10px", fontSize: "var(--text-md)", color: "var(--text-faint)" }}>
                No alerts watching {activeSession.pair}.
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── col 2 · what is happening ─────────────────────────── */}
      <div className="cockpit-col cockpit-col-main">
        {/* First, because it is the product: what has been committed to and how
            close the market is to acting on it. */}
        <PlanWatchPanel
          plans={plans}
          price={price}
          pair={activeSession.pair}
          onOpen={setPlanDetail}
        />

        <section className="panel" style={{ flexShrink: 0 }}>
          <div className="panel-header">
            <span className="label-micro">Open positions</span>
            <span className="badge badge-paper">paper</span>
            <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--muted-foreground)" }}>
              {openPositions.length} open
            </span>
          </div>
          {openPositions.length > 0 ? (
            <table className="vy-table">
              <thead>
                <tr>
                  <th>Pair</th>
                  <th style={{ textAlign: "left" }}>Opened by</th>
                  <th>Size</th>
                  <th>Entry</th>
                  <th>Stop</th>
                  <th>Target</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {openPositions.map((p) => (
                  <tr key={p.id}>
                    <td className="t-text" style={{ fontWeight: 600 }}>{p.symbol}</td>
                    <td className="t-text" style={{ color: "var(--muted-foreground)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {/* Name the plan, not the branch id — the plan is what
                          the owner authored and will recognise. */}
                      {p.plan_name
                        ? `${p.plan_name}${p.branch_name ? ` · ${p.branch_name}` : ""}`
                        : (p.strategy_name ?? "—")}
                    </td>
                    <td>{formatQty(p.quantity)}</td>
                    <td>{formatPrice(p.entry_price)}</td>
                    <td className={p.stop_price ? "v-down" : "v-flat"}>
                      {p.stop_price ? formatPrice(p.stop_price) : "none"}
                    </td>
                    <td className={p.target_price ? "v-up" : "v-flat"}>
                      {p.target_price ? formatPrice(p.target_price) : "none"}
                    </td>
                    <td style={{ color: "var(--text-faint)" }}>{clockTime(p.opened_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: "14px 10px", fontSize: "var(--text-md)", color: "var(--text-faint)" }}>
              No open positions for {activeSession.pair}.
            </div>
          )}
          {/* Only assert the stop invariant when there's something to assert
              it about — "every position carries a stop" next to zero
              positions is noise. */}
          {openPositions.length > 0 && (
            <div className="panel-footer">
              {openPositions.every((p) => p.stop_price) ? (
                <>
                  <ShieldCheck size={12} style={{ color: "var(--up)" }} />
                  <span>Every open position carries a stop.</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={12} style={{ color: "var(--caution)" }} />
                  <span style={{ color: "var(--caution)" }}>
                    A position is open without a stop.
                  </span>
                </>
              )}
              <span className="ml-auto" style={{ color: "var(--text-ghost)" }}>simulated · no venue orders</span>
            </div>
          )}
        </section>

        <section className="panel" style={{ flex: 1, minHeight: 160 }}>
          <div className="panel-header">
            <span className="label-micro">Engine activity</span>
            {/* Lifecycle chatter ("app started", "session selected") is true
                and not what a feed is for — it happens every launch and there
                is nothing to act on. Hidden by default, one click away, and
                still complete in Settings › Audit log. */}
            <button
              className="activity-toggle ml-auto"
              onClick={() => setShowChores((v) => !v)}
              title="Startup and configuration entries"
            >
              {showChores ? "hide routine" : "show routine"}
            </button>
          </div>
          <div className="panel-body-flush vy-scroll" style={{ flex: 1 }}>
            {shownActivity.map(({ ev, d }) => (
              <div key={ev.id} className="activity-row">
                <span className="mono activity-time">{clockTime(ev.created_at)}</span>
                <span className="activity-tag" style={{ color: ACTIVITY_TONE_COLOR[d.tone] }}>
                  {d.tag}
                </span>
                {/* The sentence, built from the row's own payload. This used to
                    render the action NAME and throw the detail away, which is
                    why the panel read as a list of function calls. */}
                <span className="activity-text">{d.text}</span>
              </div>
            ))}
            {shownActivity.length === 0 && (
              <div style={{ padding: "14px 10px", fontSize: "var(--text-md)", color: "var(--text-faint)" }}>
                {activity.length === 0 ? "Nothing yet. The engines write here whenever they act." : "Nothing but routine startup entries so far."}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── col 3 · what needs you ────────────────────────────── */}
      <div className="cockpit-col">
        {/* Collapsed to a single line while empty — an approvals panel sized
            for content it doesn't have reads as broken, and the space is
            better given to the reviews feed. It grows when intents exist. */}
        <section className="panel panel-approval panel-quiet" style={{ flex: "0 0 auto" }}>
          <div className="panel-header">
            <Gavel size={13} style={{ color: "var(--caution)" }} />
            <span className="label-micro" style={{ color: "var(--caution)" }}>Awaiting your approval</span>
            <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--caution)" }}>0</span>
          </div>
          <div className="panel-footer" style={{ borderTop: "none" }}>
            <span>Nothing to approve — no order path exists until the risk engine does.</span>
          </div>
        </section>

        <section className="panel" style={{ flex: 1 }}>
          <div className="panel-header">
            <Sparkles size={13} style={{ color: "var(--ai)" }} />
            <span className="label-micro">Latest reviews</span>
            <span className="ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
              AI-authored
            </span>
          </div>
          <div className="panel-body-flush vy-scroll" style={{ flex: 1 }}>
            {reviews.map((r) => {
              const isWin = r.tags.includes("win");
              return (
                <div key={r.id} className="review-row">
                  <div className="review-row-head">
                    <span className="mono" style={{ color: "var(--text-faint)" }}>{relTime(r.created_at)}</span>
                    <span className={isWin ? "v-up" : "v-down"} style={{ fontWeight: 600 }}>
                      {isWin ? "win" : "loss"}
                    </span>
                    <span className="ml-auto" style={{ color: "var(--text-faint)" }}>
                      {r.tags.split(",")[1] ?? "review"}
                    </span>
                  </div>
                  <div className="review-row-text">{r.content}</div>
                </div>
              );
            })}
            {reviews.length === 0 && (
              <div style={{ padding: "14px 10px", fontSize: "var(--text-md)", color: "var(--text-faint)", lineHeight: 1.55 }}>
                <Clock size={12} style={{ display: "inline", marginRight: 6 }} />
                No reviews yet. One is written automatically each time a paper
                position closes.
              </div>
            )}
          </div>
        </section>
      </div>

      {planDetail && (
        <PlanDetail
          plan={planDetail}
          price={price}
          monitored={activeSession.status === "active"}
          onClose={() => setPlanDetail(null)}
        />
      )}
    </div>
  );
}
