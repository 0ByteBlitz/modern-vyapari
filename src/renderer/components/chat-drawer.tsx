import { useEffect, useState } from "react";
import { Sparkles, PanelRightClose, ArrowRight } from "lucide-react";
import { ChatPanel } from "@/components/chat-panel";
import { api, isError, type Session } from "@/lib/api";

/**
 * The SESSION agent, as a drawer on a session's own surfaces.
 *
 * Two agents, never ambiguous which (31 Oct 2026):
 *  - this drawer is bounded by its session — its pair, plans, journal and
 *    memory — and only exists on that session's surfaces (Dashboard, Orders,
 *    Plans, Journal, Research, Alerts);
 *  - the GLOBAL agent is the mascot (`agent-mascot.tsx`), on every surface,
 *    with its own floating window and its own conversation.
 * The header always names the session, so the two can't be confused.
 *
 * Collapsed it's a 36px rail; open it's a 380px column. The footer line is
 * load-bearing, not decoration: the agent's inability to place, size, or price
 * an order is the app's core safety property, and the place a user forms their
 * mental model of it is here.
 */
export function ChatDrawer({
  session,
  open,
  onToggle,
}: {
  session: Session;
  open: boolean;
  onToggle: () => void;
}) {
  if (!open) {
    return (
      <button className="chat-rail" onClick={onToggle} title={`Open the ${session.pair} agent`}>
        <Sparkles size={16} style={{ color: "var(--ai)" }} />
        <span className="chat-rail-label">{session.pair}</span>
      </button>
    );
  }

  return (
    <aside className="chat-drawer">
      <div className="chat-drawer-head">
        <Sparkles size={14} style={{ color: "var(--ai)" }} />
        <span style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>Agent</span>
        <span className="mono" style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)" }}>
          {session.pair}
        </span>
        <button className="chat-drawer-close ml-auto" onClick={onToggle} title="Collapse">
          <PanelRightClose size={14} />
        </button>
      </div>

      <ChatPanel key={session.id} sessionId={session.id} />

      <div className="chat-drawer-foot">
        The agent can propose and journal. It cannot place, size, or price an order.
      </div>
    </aside>
  );
}

/** The sessions as one-click ways in. The selected one (you stepped out to a
 *  global surface) leads as "back"; after a fresh launch, the last one used. */
export function SessionPicker({
  selected,
  onOpenSession,
}: {
  selected: Session | null;
  onOpenSession: (s: Session) => void;
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [last, setLast] = useState<Session | null>(null);

  useEffect(() => {
    void Promise.all([api.listSessions(false), api.getLastSession()]).then(([list, lastRes]) => {
      setSessions(isError(list) ? [] : list);
      setLast(isError(lastRes) ? null : lastRes);
    });
  }, [selected?.id]);

  if (!sessions || sessions.length === 0) return null;
  const lead = selected ?? last;
  const ordered = lead
    ? [...sessions.filter((s) => s.id === lead.id), ...sessions.filter((s) => s.id !== lead.id)]
    : sessions;
  const note = selected ? "back" : "last";

  return (
    <div className="chat-session-picker">
      <span className="chat-session-picker-label">Open a session</span>
      <div className="chat-session-picker-list">
        {ordered.map((s) => (
          <button
            key={s.id}
            className={`chat-session-chip${lead?.id === s.id ? " is-last" : ""}`}
            onClick={() => onOpenSession(s)}
            title={lead?.id === s.id ? "Where you left off" : `Open ${s.pair}`}
          >
            <span className="mono">{s.pair}</span>
            {lead?.id === s.id && <span className="chat-session-chip-note">{note}</span>}
            <ArrowRight size={11} />
          </button>
        ))}
      </div>
    </div>
  );
}
