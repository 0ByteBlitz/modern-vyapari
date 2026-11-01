import { useCallback, useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { api, isError, errorText, type AiModelInfo, type SetupStatus } from "@/lib/api";
import { AiKeyPanel, BrowserbaseKeyPanel } from "@/components/credentials-panels";

/**
 * Settings › AI — the provider's key, which models do what, and the agent's
 * web tools, in that order: the key is the one thing setup needs, and the rest
 * means nothing without it.
 *
 * The models panel used to say reviews could be changed through "the
 * `review_model` settings key", a database row nothing on screen could write.
 * It is a picker now, and it names the model reviews will actually run on.
 */
function ModelsPanel() {
  const [models, setModels] = useState<AiModelInfo[] | null>(null);
  const [status, setStatus] = useState<{ saved: string | null; effective: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, r] = await Promise.all([api.getAiModels(), api.reviewModel()]);
    if (isError(m)) setProblem(errorText(m));
    else setModels(m);
    if (!isError(r)) setStatus(r);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function choose(value: string) {
    setProblem(null);
    const res = await api.setReviewModel(value === "" ? null : value);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    await load();
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <Bot size={13} style={{ color: "var(--ai)" }} />
        <span className="label-micro">Models</span>
      </div>
      <div className="integ-body">
        <div className="integ-row">
          <div>
            <div className="integ-name">Chat</div>
            <div className="integ-sub">Chosen in each agent window — every session and the general chat keep their own.</div>
          </div>
        </div>

        <div className="integ-row" style={{ marginTop: 10 }}>
          <div>
            <div className="integ-name">Post-trade reviews</div>
            <div className="integ-sub">
              Run unattended each time a position closes
              {status?.effective ? (
                <>
                  {" "}— on <span className="mono">{status.effective}</span>.
                </>
              ) : (
                "."
              )}
            </div>
          </div>
          <select
            className="settings-input"
            style={{ maxWidth: 240 }}
            value={status?.saved ?? ""}
            disabled={!models || !status}
            onChange={(e) => void choose(e.target.value)}
          >
            <option value="">Fastest available</option>
            {/* A saved model the provider no longer lists still shows, so the
                picker never claims a different choice than the one in effect. */}
            {status?.saved && !models?.some((m) => m.id === status.saved) && (
              <option value={status.saved}>{status.saved}</option>
            )}
            {models?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}
              </option>
            ))}
          </select>
        </div>

        {problem && <p className="integ-problem">{problem}</p>}
      </div>
    </section>
  );
}

export function AiPane({ setup, onRefresh }: { setup: SetupStatus | null; onRefresh: () => Promise<void> }) {
  if (!setup) return <div className="empty-state">Loading…</div>;
  return (
    <div className="integ-pane">
      <AiKeyPanel setup={setup} onRefresh={onRefresh} />
      <ModelsPanel />
      {/* The agent's optional cloud browser — a web tool, not a data feed. */}
      <BrowserbaseKeyPanel setup={setup} onRefresh={onRefresh} />
    </div>
  );
}
