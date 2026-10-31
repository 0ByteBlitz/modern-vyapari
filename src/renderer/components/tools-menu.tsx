import { useCallback, useEffect, useState } from "react";
import { Wrench, DollarSign, Globe } from "lucide-react";
import { api, isError, type AgentToolInfo } from "@/lib/api";

/**
 * What the agent is allowed to do, as a menu.
 *
 * The owner asked for this after the app disabled web search behind their back
 * and made them resend: *"why not have a menu which shows tools and check them
 * off and on?"* The capabilities were a hardcoded array in `chat.ts` —
 * invisible, and editable only in source.
 *
 * **No switch here can cause harm.** The catalogue contains no order tool, no
 * arming tool and no venue tool, by construction — so the worst outcome of any
 * combination is a less capable agent. That is why everything is switchable
 * rather than only some things.
 *
 * Two markers earn their place, because they are the switches that actually
 * matter: **$** for billed-per-use, and the globe for tools that pull untrusted
 * outside text into a conversation with a model that holds write tools.
 *
 * A tool the *model* refuses is shown as unavailable with the reason, never as
 * an unchecked box — "you turned this off" and "this model can't" are different
 * facts and must not look alike.
 */
const GROUP_LABEL: Record<AgentToolInfo["group"], string> = {
  session: "This session",
  analysis: "Analysis",
  web: "Web",
  browser: "Browser & charts",
};

const GROUP_ORDER: AgentToolInfo["group"][] = ["session", "analysis", "web", "browser"];

export function ToolsMenu({ model, onClose }: { model: string; onClose: () => void }) {
  const [tools, setTools] = useState<AgentToolInfo[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.listAgentTools(model);
    if (isError(res)) {
      setProblem("Couldn't read the tool list.");
      return;
    }
    setTools(res);
  }, [model]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function toggle(t: AgentToolInfo) {
    if (t.unavailableReason) return;
    /* Optimistic, then reconciled by `load`. A checkbox that lags a round trip
       reads as broken. */
    setTools((prev) => prev.map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x)));
    const res = await api.setAgentTool(t.id, !t.enabled);
    if (isError(res)) setProblem("That didn't save.");
    await load();
  }

  async function reset() {
    await api.resetAgentTools();
    await load();
  }

  const offCount = tools.filter((t) => !t.enabled && !t.unavailableReason).length;

  return (
    <>
      <div className="tools-menu-backdrop" onClick={onClose} />
      <div className="tools-menu">
        <div className="tools-menu-head">
          <Wrench size={12} />
          <span>Agent tools</span>
          <button className="tools-menu-reset ml-auto" onClick={() => void reset()}>
            Turn all on
          </button>
        </div>

        {problem && <p className="tools-menu-problem">{problem}</p>}

        <div className="tools-menu-body vy-scroll">
          {GROUP_ORDER.map((g) => {
            const items = tools.filter((t) => t.group === g);
            if (items.length === 0) return null;
            return (
              <div key={g}>
                <div className="tools-menu-group label-micro">{GROUP_LABEL[g]}</div>
                {items.map((t) => (
                  <label
                    key={t.id}
                    className={`tools-menu-row ${t.unavailableReason ? "tools-menu-row-off" : ""}`}
                    title={t.unavailableReason ?? t.description}
                  >
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      disabled={Boolean(t.unavailableReason)}
                      onChange={() => void toggle(t)}
                    />
                    <span className="tools-menu-label">{t.label}</span>
                    {t.costly && (
                      <DollarSign size={10} className="tools-menu-flag" aria-label="Billed per use" />
                    )}
                    {t.untrusted && (
                      <Globe size={10} className="tools-menu-flag" aria-label="Reads outside content" />
                    )}
                    {t.unavailableReason && <span className="tools-menu-na">unavailable</span>}
                  </label>
                ))}
              </div>
            );
          })}
        </div>

        <div className="tools-menu-foot">
          {offCount > 0 ? `${offCount} turned off.` : "All tools on."} No tool here can place an order.
        </div>
      </div>
    </>
  );
}
