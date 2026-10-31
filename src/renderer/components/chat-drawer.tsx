import { Sparkles, PanelRightClose } from "lucide-react";
import { ChatPanel } from "@/components/chat-panel";
import type { Session } from "@/lib/api";

/**
 * Agent chat, as a drawer available on every surface.
 *
 * Previously chat only existed on the dashboard, which meant the one thing you
 * most want while looking at a backtest or a journal entry — asking the bot
 * about it — required navigating away from it. Collapsed it's a 36px rail;
 * open it's a 380px column.
 *
 * The footer line is load-bearing, not decoration: the agent's inability to
 * place, size, or price an order is the app's core safety property, and the
 * place a user forms their mental model of it is here.
 */
export function ChatDrawer({
  session,
  open,
  onToggle,
}: {
  session: Session | null;
  open: boolean;
  onToggle: () => void;
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
          {session ? session.pair : "no session"}
        </span>
        <button className="chat-drawer-close ml-auto" onClick={onToggle} title="Collapse">
          <PanelRightClose size={14} />
        </button>
      </div>

      {session ? (
        <ChatPanel sessionId={session.id} />
      ) : (
        <div className="empty-state" style={{ flex: 1 }}>
          <span>Select a session to talk to the agent.</span>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--text-ghost)" }}>
            Conversations are scoped per session, along with their memory.
          </span>
        </div>
      )}

      <div className="chat-drawer-foot">
        The agent can propose and journal. It cannot place, size, or price an order.
      </div>
    </aside>
  );
}
