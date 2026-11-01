import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import { api, isError, errorText, type AppMode, type AppModeStatus } from "@/lib/api";

/**
 * Choosing between simulated and live.
 *
 * **The choice takes effect on the next launch, and the screen says so plainly
 * rather than pretending otherwise.** The database, the engine and every cached
 * row belong to one mode; swapping them underneath a running monitor would mean
 * those three disagree about which world they are in, which is precisely the
 * ambiguous state the split exists to prevent. A "switching…" spinner that
 * quietly restarted the engine would be a nicer demo and a worse guarantee.
 *
 * The two modes are described by what they *are*, not by which is recommended.
 * The owner already knows they want to trade; what they need from this screen
 * is what each mode can and cannot do.
 */
export function ModePane() {
  const [status, setStatus] = useState<AppModeStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Every click answers. Choosing the mode already selected used to rewrite
     the saved choice with no change on screen — a stored "live" was silently
     replaced by "simulated" and nothing said so. */
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.appModeStatus();
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    setStatus(res);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function choose(mode: AppMode) {
    setBusy(true);
    setProblem(null);
    setSaved(null);
    const res = await api.setAppMode(mode);
    setBusy(false);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    setSaved(
      mode === status?.mode
        ? `Saved. The app keeps running ${mode}.`
        : `Saved. The app switches to ${mode} on the next launch.`
    );
    await load();
  }

  if (!status) return null;
  const pendingChange = status.pending !== status.mode;

  return (
    <div className="integ-pane">
      <section className="panel">
        <div className="panel-header">
          <ShieldCheck size={13} style={{ color: "var(--accent)" }} />
          <span className="label-micro">Mode</span>
          <span className="ml-auto">
            {/* Live is loud; there is no badge-live class, so this rendered
                unstyled. */}
            <span className={`badge badge-${status.mode === "live" ? "down" : "paper"}`}>
              running: {status.mode}
            </span>
          </span>
        </div>

        <div className="integ-body">
          <div className="mode-choice">
            <button
              className={`mode-option ${status.pending === "simulated" ? "mode-option-on" : ""}`}
              disabled={busy}
              onClick={() => void choose("simulated")}
            >
              <strong>Simulated</strong>
              {/* Stated as an absence, because that is what it is: there is no
                  adapter present that could reach a venue. */}
              <span>No venue, no credentials, no way to place an order.</span>
            </button>

            <button
              className={`mode-option ${status.pending === "live" ? "mode-option-on" : ""}`}
              disabled={busy || !status.liveAvailable}
              onClick={() => void choose("live")}
            >
              <strong>Live</strong>
              <span>
                {status.liveAvailable
                  ? "Real venue and credentials. Orders still need your signature."
                  : "Live trading isn't available yet."}
              </span>
            </button>
          </div>

          {pendingChange && (
            <p className="integ-note">
              <AlertTriangle size={12} style={{ color: "var(--caution)" }} />
              Running in <strong>{status.mode}</strong>. Restart to switch to{" "}
              <strong>{status.pending}</strong>.
            </p>
          )}

          <p className="integ-sub" style={{ marginTop: 10 }}>
            Each mode keeps its own sessions, plans, positions and track record — they can never mix.
            Lessons are shared, because what you learn about a market is true in both.
          </p>

          {saved && (
            <p className="integ-note">
              <ShieldCheck size={12} style={{ color: "var(--up)" }} />
              {saved}
            </p>
          )}
          {problem && <p className="integ-problem">{problem}</p>}
        </div>
      </section>
    </div>
  );
}
