import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Archive, Check, Loader2, X } from "lucide-react";
import {
  api,
  isError,
  errorText,
  type ArchivePlan,
  type ArchiveStepId,
  type ArchiveSummary,
  type Session,
} from "@/lib/api";
import { formatPrice, formatQty, formatUsd } from "@/lib/format";

/**
 * Archive confirmation + progress.
 *
 * Archiving is the one destructive-ish action in the app: it closes open paper
 * positions, which converts unrealised PnL into realised PnL permanently. So
 * this does two things a `confirm()` can't:
 *
 *   1. States exactly what will happen, with counts and the actual positions
 *      that will be closed and at what price — computed in main, not guessed.
 *   2. Shows each step completing for real. The step list is driven by events
 *      the main process emits as it works, not by a timer; the only cosmetic
 *      part is a minimum display time per step, because SQLite finishes some
 *      of these in under a millisecond and a tick you can't see is useless.
 */

const STEPS: { id: ArchiveStepId; label: string }[] = [
  { id: "close_positions", label: "Close open positions" },
  { id: "retire_strategies", label: "Retire strategies" },
  { id: "clear_alerts", label: "Clear active alerts" },
  { id: "release_streams", label: "Release live data streams" },
  { id: "archive_session", label: "Archive the session" },
];

type StepState = "pending" | "running" | "done" | "failed";

/** Minimum time a step stays visibly "running" so the sequence is readable. */
const MIN_STEP_MS = 260;

export function ArchiveSessionDialog({
  session,
  onClose,
  onArchived,
}: {
  session: Session;
  onClose: () => void;
  onArchived: () => void;
}) {
  const [plan, setPlan] = useState<ArchivePlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [phase, setPhase] = useState<"confirm" | "running" | "done" | "failed">("confirm");
  const [steps, setSteps] = useState<Record<string, { state: StepState; detail?: string }>>({});
  const [summary, setSummary] = useState<ArchiveSummary | null>(null);
  const [runError, setRunError] = useState("");

  /* Events can arrive faster than MIN_STEP_MS, so they're queued and drained
     at a readable pace rather than dropped or rendered instantly. */
  const queue = useRef<{ step: ArchiveStepId; state: StepState; detail?: string }[]>([]);
  const draining = useRef(false);

  const drain = useCallback(() => {
    if (draining.current) return;
    const next = queue.current.shift();
    if (!next) return;
    draining.current = true;
    setSteps((prev) => ({ ...prev, [next.step]: { state: next.state, ...(next.detail ? { detail: next.detail } : {}) } }));
    setTimeout(() => {
      draining.current = false;
      drain();
    }, next.state === "running" ? MIN_STEP_MS : 90);
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await api.archivePlan(session.id);
      if (isError(res)) setPlanError(errorText(res));
      else setPlan(res);
    })();
  }, [session.id]);

  useEffect(() => {
    return api.onArchiveStep((ev) => {
      if (ev.sessionId !== session.id) return;
      queue.current.push({ step: ev.step, state: ev.status, ...(ev.detail ? { detail: ev.detail } : {}) });
      drain();
    });
  }, [session.id, drain]);

  // Escape closes — but never mid-run, when there's nothing safe to cancel to.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "running") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  const run = async () => {
    setPhase("running");
    setRunError("");
    setSteps(Object.fromEntries(STEPS.map((s) => [s.id, { state: "pending" as StepState }])));

    const res = await api.archiveSession(session.id);

    // Let the queued step events finish rendering before switching phase.
    const settle = () =>
      new Promise<void>((resolve) => {
        const tick = () => (queue.current.length === 0 && !draining.current ? resolve() : setTimeout(tick, 80));
        tick();
      });
    await settle();

    if (isError(res)) {
      setRunError(errorText(res));
      setPhase("failed");
      return;
    }
    setSummary(res);
    setPhase("done");
  };

  const positions = plan?.openPositions ?? [];
  const unpriced = positions.filter((p) => p.lastPrice === null);
  const totalUnrealized = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);

  return (
    <div className="modal-backdrop" onClick={() => phase !== "running" && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Archive size={14} style={{ color: "var(--caution)" }} />
          <span className="modal-title">Archive {session.pair}</span>
          {phase !== "running" && (
            <button className="modal-close" onClick={onClose} title="Close">
              <X size={13} />
            </button>
          )}
        </div>

        {/* ── Confirm ── */}
        {phase === "confirm" && (
          <div className="modal-body vy-scroll">
            {planError && (
              <div className="modal-alert">
                <AlertTriangle size={13} />
                <span>{planError}</span>
              </div>
            )}

            {!plan && !planError && <p className="modal-muted">Working out what this would do…</p>}

            {plan && (
              <>
                <p className="modal-lead">
                  Archiving winds the session down and makes it read-only. Here's exactly what happens:
                </p>

                <ul className="modal-list">
                  <li>
                    <strong>{positions.length}</strong> open {positions.length === 1 ? "position" : "positions"} will be
                    closed at the current price
                    {positions.length > 0 && (
                      <span className={totalUnrealized >= 0 ? "v-up" : "v-down"}>
                        {" "}
                        — realising {formatUsd(totalUnrealized, { sign: true })}
                      </span>
                    )}
                  </li>
                  <li>
                    <strong>{plan.retirableStrategies}</strong>{" "}
                    {plan.retirableStrategies === 1 ? "strategy is" : "strategies are"} retired
                    {plan.armedStrategies > 0 && ` (${plan.armedStrategies} currently armed)`}
                  </li>
                  <li>
                    <strong>{plan.activeAlerts}</strong> active {plan.activeAlerts === 1 ? "alert is" : "alerts are"}{" "}
                    cleared, releasing their data streams
                  </li>
                  <li className="modal-list-keep">
                    <strong>{plan.journalEntries}</strong> journal{" "}
                    {plan.journalEntries === 1 ? "entry" : "entries"} and <strong>{plan.closedTrades}</strong> past{" "}
                    {plan.closedTrades === 1 ? "trade" : "trades"} are <strong>kept</strong> and stay readable
                  </li>
                </ul>

                {positions.length > 0 && (
                  <div className="modal-table">
                    <div className="modal-table-head">
                      <span>Position</span>
                      <span>Qty</span>
                      <span>Entry</span>
                      <span>Now</span>
                      <span>PnL</span>
                    </div>
                    {positions.map((p) => (
                      <div key={p.id} className="modal-table-row mono">
                        <span className="modal-table-name">{p.strategyName}</span>
                        <span>{formatQty(p.quantity)}</span>
                        <span>{formatPrice(p.entryPrice)}</span>
                        <span>{p.lastPrice ? formatPrice(p.lastPrice) : "—"}</span>
                        <span
                          style={{
                            color:
                              p.unrealizedPnl === null
                                ? "var(--text-faint)"
                                : p.unrealizedPnl >= 0
                                  ? "var(--up)"
                                  : "var(--down)",
                          }}
                        >
                          {p.unrealizedPnl === null ? "—" : formatUsd(p.unrealizedPnl, { sign: true })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {unpriced.length > 0 && (
                  <div className="modal-alert">
                    <AlertTriangle size={13} />
                    <span>
                      No recent price for {unpriced.map((p) => p.symbol).join(", ")}, so {unpriced.length === 1 ? "that position" : "those positions"}{" "}
                      can't be closed. Open Research for that pair to refresh its candles first.
                    </span>
                  </div>
                )}

                <p className="modal-note">
                  You can restore an archived session later, as long as no other live session holds the same pair.
                </p>
              </>
            )}
          </div>
        )}

        {/* ── Running / done / failed ── */}
        {phase !== "confirm" && (
          <div className="modal-body vy-scroll">
            <div className="archive-steps">
              {STEPS.map((s) => {
                const st = steps[s.id]?.state ?? "pending";
                const detail = steps[s.id]?.detail;
                return (
                  <div key={s.id} className={`archive-step archive-step-${st}`}>
                    <span className="archive-step-icon">
                      {st === "done" && <Check size={13} />}
                      {st === "running" && <Loader2 size={13} className="animate-spin" />}
                      {st === "failed" && <X size={13} />}
                      {st === "pending" && <span className="archive-step-dot" />}
                    </span>
                    <span className="archive-step-label">{s.label}</span>
                    {detail && <span className="archive-step-detail">{detail}</span>}
                  </div>
                );
              })}
            </div>

            {phase === "done" && summary && (
              <div className="archive-done">
                <Check size={14} />
                <div>
                  <strong>{summary.pair} archived.</strong>
                  <div className="modal-muted">
                    {summary.closed} closed{" "}
                    {summary.closed !== 0 && (
                      <span className={summary.realizedOnClose >= 0 ? "v-up" : "v-down"}>
                        ({formatUsd(summary.realizedOnClose, { sign: true })})
                      </span>
                    )}
                    {" · "}
                    {summary.retired} retired · {summary.alertsCleared} alerts cleared
                  </div>
                </div>
              </div>
            )}

            {phase === "failed" && (
              <div className="modal-alert">
                <AlertTriangle size={13} />
                <span>
                  {runError} Nothing further was changed — the session is still {session.status}.
                </span>
              </div>
            )}
          </div>
        )}

        <div className="modal-foot">
          {phase === "confirm" && (
            <>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                disabled={!plan || unpriced.length > 0}
                onClick={() => void run()}
                title={unpriced.length > 0 ? "Can't close a position without a current price" : undefined}
              >
                <Archive size={13} />
                Archive session
              </button>
            </>
          )}
          {phase === "running" && <span className="modal-muted">Working… don't close the app.</span>}
          {(phase === "done" || phase === "failed") && (
            <button
              className="btn btn-primary"
              onClick={() => {
                if (phase === "done") onArchived();
                onClose();
              }}
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
