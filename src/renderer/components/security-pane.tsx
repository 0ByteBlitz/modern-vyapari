import { useCallback, useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import { api, isError, errorText, type LockSettings, type LockStatus } from "@/lib/api";

const IDLE_OPTIONS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "Never" },
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
];

/**
 * Security — the app lock's settings and whether Windows Hello can provide it.
 *
 * The availability is asked fresh on opening (`recheck`): the owner who has
 * just added a PIN in Windows Settings should see it here without a restart.
 * Main holds the settings; this pane only describes and asks.
 */
export function SecurityPane() {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.getLockStatus(true);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    setStatus(res);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Partial<LockSettings>) {
    if (!status) return;
    setBusy(true);
    setProblem(null);
    const res = await api.setLockSettings({ ...status.settings, ...patch });
    setBusy(false);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    setStatus({ ...status, settings: res });
  }

  const s = status?.settings;
  const available = status?.hello === "available";

  return (
    <div className="integ-pane">
      <section className="panel">
        <div className="panel-header">
          <Fingerprint size={13} style={{ color: "var(--accent)" }} />
          <span className="label-micro">App lock</span>
          <span className="ml-auto">
            {status && (
              <span className={`badge badge-${available ? "supervised" : "draft"}`}>
                {available
                  ? "Windows Hello ready"
                  : status.hello === "unavailable"
                    ? "Windows Hello not set up"
                    : "no Windows Hello on this system"}
              </span>
            )}
          </span>
        </div>

        <div className="integ-body">
          <p className="integ-sub" style={{ marginBottom: 10 }}>
            While locked, nothing in this window can be read or changed until Windows Hello unlocks it. Armed
            plans, alerts and notifications keep running.
          </p>
          {status && !available && (
            <p className="integ-note" style={{ color: "var(--caution)" }}>
              {status.hello === "unavailable"
                ? "The app can't lock until Windows Hello is set up. Add a PIN or fingerprint in Windows Settings › Accounts › Sign-in options, then reopen this page."
                : "The app can't lock on this system: it has no Windows Hello."}
            </p>
          )}

          {s && (
            <>
              <label className="plans-field">
                <span>Lock at launch</span>
                <select
                  value={s.lockAtLaunch ? "on" : "off"}
                  disabled={busy}
                  onChange={(e) => void save({ lockAtLaunch: e.target.value === "on" })}
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <label className="plans-field">
                <span>Lock when Windows locks</span>
                <select
                  value={s.lockWithWindows ? "on" : "off"}
                  disabled={busy}
                  onChange={(e) => void save({ lockWithWindows: e.target.value === "on" })}
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <label className="plans-field">
                <span>Lock after no input for</span>
                <select
                  value={s.idleMinutes === null ? "never" : String(s.idleMinutes)}
                  disabled={busy}
                  onChange={(e) => void save({ idleMinutes: e.target.value === "never" ? null : Number(e.target.value) })}
                >
                  {IDLE_OPTIONS.map((o) => (
                    <option key={o.label} value={o.value === null ? "never" : String(o.value)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {problem && <p className="integ-problem">{problem}</p>}
        </div>
      </section>
    </div>
  );
}
