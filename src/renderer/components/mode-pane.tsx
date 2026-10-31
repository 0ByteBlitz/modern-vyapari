import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, AlertTriangle, Wallet } from "lucide-react";
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
  const [account, setAccount] = useState<{ balance: number; initialBalance: number } | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    const res = await api.appModeStatus();
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    setStatus(res);
    const acc = await api.paperAccount();
    if (!isError(acc)) setAccount(acc);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function applyBalance() {
    const v = Number(draft);
    if (!Number.isFinite(v) || v <= 0) {
      setProblem("Enter a starting balance above zero.");
      return;
    }
    setBusy(true);
    setProblem(null);
    const res = await api.setPaperBalance(v);
    setBusy(false);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    setDraft("");
    await load();
  }

  async function choose(mode: AppMode) {
    setBusy(true);
    setProblem(null);
    const res = await api.setAppMode(mode);
    setBusy(false);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
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
            <span className={`badge badge-${status.mode === "live" ? "live" : "paper"}`}>
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
              disabled={busy}
              onClick={() => void choose("live")}
            >
              <strong>Live</strong>
              <span>Real venue and credentials. Orders still need your signature.</span>
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

          {status.mode === "live" && !status.canPlaceOrders && (
            /* Honest about the current state of the build rather than letting
               "live" imply a capability Sprint 4 has not built yet. */
            <p className="integ-note">
              Live mode is selected, but this build still cannot place orders — the venue adapter
              reports no order support.
            </p>
          )}

          {problem && <p className="integ-problem">{problem}</p>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <Wallet size={13} style={{ color: "var(--accent)" }} />
          <span className="label-micro">Simulated account</span>
          <span className="ml-auto mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
            {account ? `$${account.balance.toFixed(2)}` : "—"}
          </span>
        </div>
        <div className="integ-body">
          {/* One balance, shared across every session. Each session used to be
              minted its own $10,000, so the portfolio total was really a count
              of sessions — five of them read $50,000. */}
          <p className="integ-sub" style={{ marginBottom: 10 }}>
            One balance for all sessions. A session is a workspace for one pair's plans and history —
            it does not hold its own money.
          </p>

          <label className="plans-field">
            <span>Starting balance (USD)</span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              inputMode="decimal"
              placeholder={account ? String(account.initialBalance) : "10000"}
            />
          </label>

          <div className="plans-actions" style={{ marginTop: 8 }}>
            <button className="plans-ghost" disabled={busy} onClick={() => void applyBalance()}>
              Reset account
            </button>
          </div>

          {/* Says the cost plainly rather than after the fact. */}
          <p className="integ-note usage-dim">
            Resetting sets the balance and the figure every return is measured against. Your plans,
            positions and journal are untouched.
          </p>
        </div>
      </section>
    </div>
  );
}
