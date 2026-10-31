import { useEffect, useState } from "react";
import { Sparkles, PanelRightClose, ArrowRight, MessagesSquare } from "lucide-react";
import { ChatPanel } from "@/components/chat-panel";
import { api, isError, type Session } from "@/lib/api";

/**
 * Agent chat, as a drawer available on every surface.
 *
 * Previously chat only existed on the dashboard, which meant the one thing you
 * most want while looking at a backtest or a journal entry — asking the bot
 * about it — required navigating away from it. Collapsed it's a 36px rail;
 * open it's a 380px column.
 *
 * **Two conversations, never ambiguous which (31 Oct 2026).** With a session
 * open, the chat is that session's — its pair, plans, journal and memory. With
 * none (how the app starts: on Home), it is the *general* conversation: the
 * agent answers anything that doesn't need session data, and the strip above
 * it offers the sessions as one-click ways in. The agent can suggest a session
 * but never switches one itself — what the owner is looking at is their click.
 * The header says which conversation this is, always.
 *
 * The footer line is load-bearing, not decoration: the agent's inability to
 * place, size, or price an order is the app's core safety property, and the
 * place a user forms their mental model of it is here.
 */
export function ChatDrawer({
  session,
  selectedSession,
  open,
  onToggle,
  onOpenSession,
}: {
  /** The session whose chat to show — null on any surface that isn't one of its own. */
  session: Session | null;
  /** Still selected while you visit a global surface; offered first, as the way back. */
  selectedSession: Session | null;
  open: boolean;
  onToggle: () => void;
  onOpenSession: (session: Session) => void;
}) {
  if (!open) {
    return (
      <button className="chat-rail" onClick={onToggle} title="Open agent chat">
        <Sparkles size={16} style={{ color: "var(--ai)" }} />
        <span className="chat-rail-label">AGENT</span>
      </button>
    );
  }

  return (
    <aside className="chat-drawer">
      <div className="chat-drawer-head">
        <Sparkles size={14} style={{ color: "var(--ai)" }} />
        <span style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>Agent</span>
        <span className="mono" style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)" }}>
          {session ? session.pair : "general"}
        </span>
        <button className="chat-drawer-close ml-auto" onClick={onToggle} title="Collapse">
          <PanelRightClose size={14} />
        </button>
      </div>

      {session ? (
        <ChatPanel key={session.id} sessionId={session.id} />
      ) : (
        <>
          <SessionPicker selected={selectedSession} onOpenSession={onOpenSession} />
          <ChatPanel
            key="general"
            sessionId={null}
            emptyState={
              <div className="chat-general-empty">
                <MessagesSquare size={16} />
                <div>Ask about markets, concepts or the app.</div>
                <div className="chat-general-empty-sub">
                  Plans, levels and journal need a session — open one above.
                </div>
              </div>
            }
          />
        </>
      )}

      <div className="chat-drawer-foot">
        The agent can propose and journal. It cannot place, size, or price an order.
      </div>
    </aside>
  );
}

/** The sessions as one-click ways into a session's chat. The last one used leads. */
function SessionPicker({
  selected,
  onOpenSession,
}: {
  selected: Session | null;
  onOpenSession: (s: Session) => void;
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [last, setLast] = useState<Session | null>(null);

  useEffect(() => {
    const load = () => {
      void Promise.all([api.listSessions(false), api.getLastSession()]).then(([list, lastRes]) => {
        setSessions(isError(list) ? [] : list);
        setLast(isError(lastRes) ? null : lastRes);
      });
    };
    load();
    return api.onDataUpdated(({ kind }) => {
      if (kind === "sessions") load();
    });
  }, []);

  if (!sessions || sessions.length === 0) return null;
  /* The selected session (you stepped out to Home or Portfolio) leads; else the
     last one used (fresh launch). */
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
