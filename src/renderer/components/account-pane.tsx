import { useCallback, useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { api, isError, errorText } from "@/lib/api";
import { formatUsd } from "@/lib/format";

/**
 * The simulated account — one balance for every session.
 *
 * Lived inside the Mode pane until 2026-11-01. The balance is an account
 * setting, not a mode one, so it moved under Trading beside the exchange that
 * fills against it.
 */
export function SimulatedAccountPane() {
  const [account, setAccount] = useState<{ balance: number; initialBalance: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
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

  return (
    <div className="integ-pane">
      <section className="panel">
        <div className="panel-header">
          <Wallet size={13} style={{ color: "var(--accent)" }} />
          <span className="label-micro">Simulated account</span>
          <span className="ml-auto mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
            {account ? `$${formatUsd(account.balance)}` : "—"}
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

          {problem && <p className="integ-problem">{problem}</p>}
        </div>
      </section>
    </div>
  );
}
