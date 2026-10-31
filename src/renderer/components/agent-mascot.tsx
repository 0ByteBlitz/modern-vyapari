import { useEffect, useId, useRef, useState } from "react";
import { MessagesSquare, X } from "lucide-react";
import { ChatPanel } from "@/components/chat-panel";
import { SessionPicker } from "@/components/chat-drawer";
import { api, type ChatConversation, type Session } from "@/lib/api";

/**
 * The GLOBAL agent: a mascot in the lower-right corner that opens a floating
 * chat window — the general conversation, not bounded by any session.
 *
 * The session agent is the drawer (`chat-drawer.tsx`) on a session's own
 * surfaces. When that drawer is on screen the mascot moves left to sit beside
 * it rather than on top of it; that is the only time it moves. It is not
 * draggable (yet), so it is always where you last saw it.
 *
 * The window stays mounted once opened, so closing it mid-reply doesn't drop
 * the reply: the mascot shows it is still thinking, and a dot marks an answer
 * that finished while the window was closed.
 *
 * The face is original — a happy face on a blob, its smile a rising chart. It is
 * deliberately not any vendor's logo: the agent can run on any provider.
 */
export type MascotDock = "corner" | "drawer" | "rail";

export function AgentMascot({
  dock,
  selectedSession,
  onOpenSession,
}: {
  /** corner = no session drawer; drawer = beside the open drawer; rail = beside the collapsed one. */
  dock: MascotDock;
  selectedSession: Session | null;
  onOpenSession: (s: Session) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [unread, setUnread] = useState(false);
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
    if (open) setUnread(false);
  }, [open]);

  useEffect(() => {
    const mine = (c: ChatConversation | undefined) => c === "general";
    const offChunk = api.onChatChunk(({ conversation }) => {
      if (mine(conversation)) setThinking(true);
    });
    const offDone = api.onChatComplete(({ conversation }) => {
      if (!mine(conversation)) return;
      setThinking(false);
      if (!openRef.current) setUnread(true);
    });
    const offErr = api.onChatError(({ conversation }) => {
      if (mine(conversation)) setThinking(false);
    });
    return () => {
      offChunk();
      offDone();
      offErr();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const toggle = () => {
    setMounted(true);
    setOpen((v) => !v);
  };

  return (
    <>
      {mounted && (
        <section
          className={`mascot-window mascot-dock-${dock}${open ? " is-open" : ""}`}
          role="dialog"
          aria-label="Agent — general conversation"
          aria-hidden={!open}
        >
          <header className="mascot-window-head">
            <MascotFace size={22} />
            <span className="mascot-window-title">Agent</span>
            <span className="mono mascot-window-scope">general</span>
            <button className="chat-drawer-close ml-auto" onClick={() => setOpen(false)} title="Close (Esc)">
              <X size={14} />
            </button>
          </header>
          <SessionPicker
            selected={selectedSession}
            onOpenSession={(s) => {
              setOpen(false);
              onOpenSession(s);
            }}
          />
          <ChatPanel
            sessionId={null}
            emptyState={
              <div className="chat-general-empty">
                <MessagesSquare size={16} />
                <div>Ask about markets, concepts or the app.</div>
                <div className="chat-general-empty-sub">
                  Plans, levels and journal live in a session — open one above.
                </div>
              </div>
            }
          />
          <div className="chat-drawer-foot">
            The agent can propose and journal. It cannot place, size, or price an order.
          </div>
        </section>
      )}

      <button
        className={`mascot mascot-dock-${dock}${thinking ? " is-thinking" : ""}${open ? " is-open" : ""}`}
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? "Close the agent" : "Open the agent"}
        title={thinking ? "The agent is replying…" : "Agent — ask anything"}
      >
        <MascotFace size={52} />
        {unread && <span className="mascot-unread" aria-label="New reply" />}
      </button>
    </>
  );
}

/** A happy face on an organic violet blob; the smile is a rising chart line ending on an up-tick. */
export function MascotFace({ size }: { size: number }) {
  // Unique per instance: the header and the button both draw a face.
  const fill = `mascot-fill-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className="mascot-face"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden="true"
      /* An explicit width that isn't one of the authored icon sizes (11–18),
         so the global icon-scaling rules in index.css leave it alone. */
    >
      <defs>
        <linearGradient id={fill} x1="8" y1="4" x2="40" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
      {/* An organic blob, not a circle — a little lopsided, like a bubble
          mid-wobble. */}
      <path
        d="M25.6 3.4C34.8 2.7 43.6 9 44.7 19.4c.9 8.9-2.6 17.6-10.2 22.4-7.4 4.7-18.9 5.1-25.4-1.4C3.6 35 2.4 26.4 4.6 18.6 7 10 15.9 4.1 25.6 3.4Z"
        fill={`url(#${fill})`}
      />
      {/* eyes */}
      <ellipse cx="17.5" cy="19" rx="2.6" ry="3.2" fill="#fff" />
      <ellipse cx="30.5" cy="19" rx="2.6" ry="3.2" fill="#fff" />
      <circle cx="18.3" cy="18" r="0.9" fill="#6d28d9" />
      <circle cx="31.3" cy="18" r="0.9" fill="#6d28d9" />
      {/* the smile: a rising chart line, ending on an up-tick */}
      <polyline
        points="12,28.5 17.5,32.5 22.5,28.8 27,31.2 35,24.5"
        fill="none"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="35" cy="24.5" r="2.3" fill="#2FCC8B" stroke="#fff" strokeWidth="1.2" />
    </svg>
  );
}
