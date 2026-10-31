import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  Bell,
  Target,
  CandlestickChart,
  ChevronDown,
  ChevronUp,
  Gauge,
  Gavel,
  Home,
  Layers,
  LineChart,
  MoreHorizontal,
  NotebookPen,
  Pause,
  Play,
  Plus,
  Receipt,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { api, isError, type Session, type PaperStats, errorText } from "@/lib/api";
import { ArchiveSessionDialog } from "@/components/archive-session-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatUsd } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { isSessionSurfaceId, type SessionSurface } from "@shared/surfaces";

/**
 * Session-first navigation rail.
 *
 * The redesign's central IA decision: a session (one pair, one trading epoch)
 * is the primary object, and every per-session surface hangs off it. That
 * replaces the old model where nav tabs were global and the "active session"
 * was an invisible mode you had to remember you were in.
 *
 * Cross-session surfaces (portfolio, markets, approvals, settings) sit in the
 * footer, visually separated, because they are the exception.
 */
export type { SessionSurface };
export type GlobalSurface = "home" | "portfolio" | "markets" | "approvals" | "settings" | "browser";
export type Surface = SessionSurface | GlobalSurface;

export function isSessionSurface(s: Surface): s is SessionSurface {
  return isSessionSurfaceId(s);
}

const SESSION_SURFACES: { id: SessionSurface; label: string; icon: typeof Gauge }[] = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "orders", label: "Orders", icon: Receipt },
  { id: "plans", label: "Plans", icon: Target },
  { id: "journal", label: "Journal", icon: NotebookPen },
  { id: "research", label: "Research", icon: CandlestickChart },
  { id: "alerts", label: "Alerts", icon: Bell },
];

const GLOBAL_SURFACES: { id: GlobalSurface; label: string; icon: typeof Layers }[] = [
  { id: "portfolio", label: "Portfolio", icon: Layers },
  { id: "markets", label: "Markets", icon: LineChart },
  { id: "browser", label: "Research browser", icon: CandlestickChart },
  { id: "approvals", label: "Approvals & safety", icon: Gavel },
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
];

interface SessionRailProps {
  activeSessionId: number | null;
  surface: Surface;
  onSelectSession: (session: Session) => void;
  onNavigate: (surface: Surface, session?: Session) => void;
  /** Fired after a session's status changes, so the shell can re-read the
   *  main process's selection — archiving the open session clears it there. */
  onSessionsChanged?: () => void;
}

export function SessionRail({ activeSessionId, surface, onSelectSession, onNavigate, onSessionsChanged }: SessionRailProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [archived, setArchived] = useState<Session[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [stats, setStats] = useState<PaperStats | null>(null);
  const [planCount, setPlanCount] = useState<number | null>(null);
  const [pairs, setPairs] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newPair, setNewPair] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  /** Which session's overflow menu is open (null = none). */
  const [menuFor, setMenuFor] = useState<number | null>(null);
  /** Session currently being archived through the confirm/progress dialog. */
  const [archiving, setArchiving] = useState<Session | null>(null);

  /* A menu that only closes by re-clicking its own trigger is a trap — you end
     up with an open menu you can't dismiss without changing something. */
  useEffect(() => {
    if (menuFor === null) return;
    const close = () => setMenuFor(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuFor(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  const load = useCallback(async () => {
    const [all, active] = await Promise.all([api.listSessions(true), api.listSessions(false)]);
    if (isError(all) || isError(active)) {
      setError(isError(all) ? errorText(all) : isError(active) ? errorText(active) : "");
      return;
    }
    setError("");
    setSessions(active);
    setArchived(all.filter((s) => s.status === "archived"));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* Per-session detail is fetched only for the OPEN session — the rail should
     not fire N queries per render just to decorate collapsed rows. */
  useEffect(() => {
    if (activeSessionId === null) {
      setStats(null);
      setPlanCount(null);
      return;
    }
    void (async () => {
      const [s, plans] = await Promise.all([
        api.getPaperStats(activeSessionId),
        /* The badge counts what is being watched, not everything ever drafted —
           a count that includes finished plans stops meaning anything. */
        api.listPlans(activeSessionId, ["planned", "triggered"]),
      ]);
      setStats(isError(s) ? null : s);
      setPlanCount(isError(plans) ? null : plans.length);
    })();
  }, [activeSessionId, surface]);

  useEffect(() => {
    if (!creating || pairs.length) return;
    void (async () => {
      /* Not getPairs: in simulated mode there is no venue, so the venue
         has no pairs to offer and the picker came up empty. */
      const res = await api.getTradablePairs();
      if (isError(res)) return;
      setPairs(
        Object.entries(res)
          .filter(([, cfg]) => cfg.status === "active")
          .map(([key]) => key.replace("/", "-"))
          .sort()
      );
    })();
  }, [creating, pairs.length]);

  const existing = new Set(sessions.map((s) => s.pair));
  const creatable = pairs.filter((p) => !existing.has(p) && p.toLowerCase().includes(search.toLowerCase()));

  const onCreate = async () => {
    if (!newPair) return;
    const res = await api.createSession(newPair);
    if (isError(res)) {
      setError(errorText(res));
      return;
    }
    setCreating(false);
    setNewPair("");
    await load();
    onSelectSession(res);
  };

  const pausedCount = sessions.filter((s) => s.status === "paused").length;

  /**
   * Change a session's status. Every refusal from main is deliberate and worth
   * reading (open position, pair already live), so it renders in the rail
   * rather than being swallowed — the mistake that made strategy deletion look
   * like a no-op.
   */
  const changeStatus = async (session: Session, status: Session["status"]) => {
    setMenuFor(null);
    setError("");
    /* Archiving is a wind-down with real consequences (open positions get
       closed, realising their PnL), so it goes through its own confirm +
       progress dialog rather than a status flip. */
    if (status === "archived") {
      setArchiving(session);
      return;
    }
    const res = await api.setSessionStatus(session.id, status);
    if (isError(res)) {
      setError(errorText(res));
      return;
    }
    await load();
    onSessionsChanged?.();
  };

  return (
    <nav className="rail">
      {/* Home sits above the session list, not in the footer with the other
          global surfaces: it's the launch surface and the way back out of a
          session, so it should read as "up", not as "one more page". */}
      <button
        className={`rail-home ${surface === "home" ? "rail-home-active" : ""}`}
        onClick={() => onNavigate("home")}
      >
        <span className="rail-item-icon">
          <Home size={13} />
        </span>
        <span>Home</span>
      </button>

      <div className="rail-head">
        <span className="label-micro">Sessions</span>
        <div className="flex items-center gap-2">
          <span className="mono" style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)" }}>
            {sessions.length}
            {pausedCount > 0 && ` · ${pausedCount} paused`}
          </span>
          <button
            className="btn-ghost"
            style={{ border: "none", background: "transparent", color: "var(--text-faint)", cursor: "pointer", display: "grid", placeItems: "center" }}
            onClick={() => setCreating((v) => !v)}
            title={creating ? "Cancel" : "New session"}
          >
            {creating ? <X size={13} /> : <Plus size={13} />}
          </button>
        </div>
      </div>

      {creating && (
        <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          <Select value={newPair} onValueChange={setNewPair}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue placeholder="Select pair…" />
            </SelectTrigger>
            <SelectContent>
              <div className="border-b p-2">
                <Input
                  placeholder="Search pair…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="h-7 text-xs"
                  autoFocus
                />
              </div>
              {creatable.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button className="btn btn-primary" style={{ height: 24, justifyContent: "center" }} onClick={onCreate} disabled={!newPair}>
            Create session
          </button>
        </div>
      )}

      {error && (
        <div style={{ padding: "0 10px 6px", fontSize: "var(--text-2xs)", color: "var(--down)" }}>{error}</div>
      )}

      <div className="rail-scroll vy-scroll">
        {/* A session only reads as "open" while you're actually on one of its
            surfaces. On a global surface (Settings, Portfolio…) it collapses
            to a quiet "still selected" state — otherwise Settings looks like
            you're somehow inside ARB-USD. */}
        {sessions.map((session) => {
          const isSelected = session.id === activeSessionId;
          const open = isSelected && isSessionSurface(surface);
          const pnl = open && stats ? stats.realizedPnl : null;
          const pnlText = pnl === null ? "" : formatUsd(pnl, { sign: true });
          const dotClass =
            session.status === "paused" ? "rail-dot-paused" : "rail-dot-active";

          return (
            <div key={session.id} className="flex flex-col">
              {/* The overflow button is a SIBLING of the session button, not a
                  child — a button inside a button is invalid markup and the
                  inner click target behaves inconsistently. */}
              <div className="rail-session-row">
                <button
                  className={`rail-session ${open ? "rail-session-open" : isSelected ? "rail-session-selected" : ""}`}
                  onClick={() => onSelectSession(session)}
                  title={open ? undefined : isSelected ? "Selected session — click to return to it" : undefined}
                >
                  <span className={`rail-dot ${dotClass}`} />
                  <span className="rail-session-pair">{session.pair}</span>
                  {pnlText && (
                    <span
                      className="rail-session-pnl"
                      style={{ color: pnl! > 0 ? "var(--up)" : pnl! < 0 ? "var(--down)" : "var(--text-faint)" }}
                    >
                      {pnlText}
                    </span>
                  )}
                </button>

                <button
                  className={`rail-session-more ${menuFor === session.id ? "rail-session-more-open" : ""}`}
                  title="Session options"
                  aria-haspopup="menu"
                  aria-expanded={menuFor === session.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor((m) => (m === session.id ? null : session.id));
                  }}
                >
                  <MoreHorizontal size={13} />
                </button>

                {menuFor === session.id && (
                  <div className="rail-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                    {session.status === "active" ? (
                      <button className="rail-menu-item" role="menuitem" onClick={() => void changeStatus(session, "paused")}>
                        <Pause size={12} /> Pause
                        <span className="rail-menu-note">stops new entries</span>
                      </button>
                    ) : (
                      <button className="rail-menu-item" role="menuitem" onClick={() => void changeStatus(session, "active")}>
                        <Play size={12} /> Resume
                      </button>
                    )}
                    <button
                      className="rail-menu-item rail-menu-item-danger"
                      role="menuitem"
                      onClick={() => void changeStatus(session, "archived")}
                    >
                      <Archive size={12} /> Archive
                      <span className="rail-menu-note">keeps history</span>
                    </button>
                  </div>
                )}
              </div>

              {open && (
                <>
                  <div className="rail-session-meta">
                    {stats
                      ? `${stats.openCount} open · ${stats.closedCount} closed · $${formatUsd(stats.cashBalance)} cash`
                      : session.status}
                  </div>
                  <div className="rail-surfaces">
                    {SESSION_SURFACES.map(({ id, label, icon: Icon }) => {
                      const active = surface === id;
                      const badge =
                        id === "plans" && planCount !== null
                          ? String(planCount)
                          : id === "orders" && stats
                            ? String(stats.openCount + stats.closedCount)
                            : "";
                      return (
                        <button
                          key={id}
                          className={`rail-item ${active ? "rail-item-active" : ""}`}
                          onClick={() => onNavigate(id, session)}
                        >
                          <span className="rail-item-icon">
                            <Icon size={13} />
                          </span>
                          <span>{label}</span>
                          {badge && <span className="rail-item-badge">{badge}</span>}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          );
        })}

        {sessions.length === 0 && (
          <div style={{ padding: "10px 8px", fontSize: "var(--text-sm)", color: "var(--text-faint)", lineHeight: 1.5 }}>
            No sessions yet. Create one to start trading a pair.
          </div>
        )}

        {archived.length > 0 && (
          <>
            <button className="rail-archive-toggle" onClick={() => setShowArchived((v) => !v)}>
              <Archive size={12} />
              <span>Archived sessions ({archived.length})</span>
              {showArchived ? <ChevronUp size={12} className="ml-auto" /> : <ChevronDown size={12} className="ml-auto" />}
            </button>
            {showArchived && (
              <div className="flex flex-col gap-px pb-1">
                {archived.map((s) => (
                  <div key={s.id} className="rail-session-row">
                  <button
                    className="rail-archived"
                    onClick={() => onNavigate("journal", s)}
                    title="View in journal"
                  >
                    <span style={{ fontSize: "var(--text-base)", fontWeight: 600, color: "var(--muted-foreground)" }}>
                      {s.pair}
                    </span>
                    <span style={{ fontSize: "var(--text-2xs)" }}>
                      archived · read-only history
                    </span>
                  </button>

                  <button
                    className={`rail-session-more ${menuFor === s.id ? "rail-session-more-open" : ""}`}
                    title="Session options"
                    aria-haspopup="menu"
                    aria-expanded={menuFor === s.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor((m) => (m === s.id ? null : s.id));
                    }}
                  >
                    <MoreHorizontal size={13} />
                  </button>

                  {menuFor === s.id && (
                    <div className="rail-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                      {/* Restoring is refused by main if the pair already has a
                          live session — the partial unique index only allows
                          one non-archived session per pair. */}
                      <button className="rail-menu-item" role="menuitem" onClick={() => void changeStatus(s, "active")}>
                        <Play size={12} /> Restore
                        <span className="rail-menu-note">makes it live again</span>
                      </button>
                    </div>
                  )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {archiving && (
        <ArchiveSessionDialog
          session={archiving}
          onClose={() => setArchiving(null)}
          onArchived={() => {
            void load();
            onSessionsChanged?.();
          }}
        />
      )}

      <div className="rail-footer">
        {GLOBAL_SURFACES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`rail-global ${surface === id ? "rail-global-active" : ""}`}
            onClick={() => onNavigate(id)}
          >
            <span className="rail-item-icon">
              <Icon size={13} />
            </span>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
