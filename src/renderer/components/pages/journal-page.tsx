import { useCallback, useEffect, useState } from "react";
import { Brain, Search, Sparkles, User } from "lucide-react";
import { api, isError, type Session, type JournalEntry, errorText } from "@/lib/api";

/**
 * Journal & memory — the surface the old UI was missing entirely.
 *
 * The bot has been writing trade reviews and distilling lessons since Phase 3;
 * none of it was readable in-app. That matters more than a normal missing
 * screen: the lessons pane is injected verbatim into every future AI
 * conversation, so anything wrong in it keeps influencing decisions until a
 * human removes it. Making it visible is what makes it correctable.
 */
const FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "trade_review", label: "Trade reviews" },
  { id: "lesson", label: "Lessons" },
  { id: "observation", label: "Observations" },
  { id: "strategy_note", label: "Strategy notes" },
  { id: "backtest_review", label: "Backtests" },
];

/** Journal entries are either AI-authored or human-authored; the distinction
 *  drives the accent colour, because "the bot believes this" and "I wrote
 *  this" should never look the same. */
const AI_KINDS = ["trade_review", "lesson", "backtest_review", "strategy_note", "observation"];

function when(ms: number): string {
  const d = Date.now() - ms;
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString([], { day: "2-digit", month: "short" });
}

export function JournalPage({ activeSession }: { activeSession: Session | null }) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [lessons, setLessons] = useState<JournalEntry[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(25);
  const [error, setError] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const load = useCallback(async () => {
    if (!activeSession) return;
    const [list, less, c] = await Promise.all([
      api.listJournal(activeSession.id, { kind: filter, query: search || undefined, limit }),
      api.listJournal(activeSession.id, { kind: "lesson", limit: 20 }),
      api.journalCounts(activeSession.id),
    ]);
    if (isError(list)) setError(errorText(list));
    else {
      setError("");
      setEntries(list);
    }
    if (!isError(less)) setLessons(less);
    if (!isError(c)) setCounts(c);
  }, [activeSession?.id, filter, search, limit]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  /* Real-time auto-refresh when agent writes to journal */
  useEffect(() => {
    return api.onDataUpdated((data) => {
      if (data.kind === "journal") {
        void load();
      }
    });
  }, [load]);

  if (!activeSession) {
    return (
      <div className="empty-state">
        <span style={{ fontSize: "var(--text-lg)", color: "var(--muted-foreground)" }}>No session selected</span>
        <span>Memory is per-session — pick one in the rail.</span>
      </div>
    );
  }

  return (
    <div className="journal-layout">
      {/* ── entries ── */}
      <div className="journal-main vy-scroll">
        <div className="journal-toolbar">
          <div className="journal-search">
            <Search size={13} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${counts.all ?? 0} entries — full text and tags`}
              spellCheck={false}
            />
          </div>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`chip ${filter === f.id ? "chip-active" : ""}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {counts[f.id] !== undefined && f.id !== "all" && (
                <span className="mono" style={{ marginLeft: 5, color: "var(--text-faint)" }}>{counts[f.id]}</span>
              )}
            </button>
          ))}
        </div>

        {error && (
          <div className="panel" style={{ padding: "10px 12px", fontSize: "var(--text-md)", color: "var(--down)" }}>
            {error}
          </div>
        )}

        {entries.map((e) => {
          const isAI = AI_KINDS.includes(e.kind);
          const tags = e.tags.split(",").filter(Boolean);
          const isWin = tags.includes("win");
          const isLoss = tags.includes("loss");
          // `noUncheckedIndexedAccess` is on: destructuring an array yields
          // `string | undefined`, and an empty journal entry is possible.
          const [firstLine = "", ...rest] = e.content.split("\n");
          const title = firstLine.replace(/^[#*\s]+/, "").trim() || e.kind.replace(/_/g, " ");
          const body = rest.join("\n").trim() || firstLine;
          const isExpanded = expandedIds.has(e.id);
          const isLong = body.length > 150 || body.includes("\n");

          return (
            <article key={e.id} className="journal-entry" style={{ borderLeftColor: isAI ? "var(--ai)" : "var(--accent)" }}>
              <div className="journal-entry-head">
                <span className={`journal-author ${isAI ? "journal-author-ai" : ""}`}>
                  {isAI ? <Sparkles size={10} /> : <User size={10} />}
                  {isAI ? "Agent" : "You"}
                </span>
                <span className="journal-entry-title">{title}</span>
                {(isWin || isLoss) && (
                  <span className={isWin ? "v-up" : "v-down"} style={{ fontSize: "var(--text-sm)", fontWeight: 700 }}>
                    {isWin ? "win" : "loss"}
                  </span>
                )}
                <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
                  {when(e.created_at)}
                </span>
              </div>
              <div
                className="journal-entry-body"
                style={{
                  display: isExpanded ? "block" : "-webkit-box",
                  WebkitLineClamp: isExpanded ? "unset" : 2,
                  WebkitBoxOrient: "vertical",
                  lineClamp: isExpanded ? "unset" : 2,
                  overflow: isExpanded ? "visible" : "hidden",
                }}
              >
                {body}
              </div>
              {isLong && (
                <button
                  onClick={() => toggleExpand(e.id)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "var(--accent)",
                    fontSize: "var(--text-xs)",
                    fontWeight: 600,
                    cursor: "pointer",
                    marginTop: "4px",
                    textAlign: "left",
                  }}
                >
                  {isExpanded ? "▲ Show less" : "▼ Read full entry"}
                </button>
              )}
              {tags.length > 0 && (
                <div className="journal-entry-tags">
                  {tags.map((t, i) => (
                    <span key={`${t}-${i}`} className="tag">{t}</span>
                  ))}
                </div>
              )}
            </article>
          );
        })}

        {entries.length === 0 && !error && (
          <div className="empty-state">
            <span>{search ? "No entries match that search." : `No journal entries for ${activeSession.pair} yet.`}</span>
            <span style={{ fontSize: "var(--text-sm)", color: "var(--text-ghost)" }}>
              The bot writes one review automatically each time a paper position closes.
            </span>
          </div>
        )}

        {entries.length >= limit && (
          <div className="journal-footer">
            <span>
              Showing {entries.length} of {counts.all ?? entries.length} · older entries are archived, not deleted
            </span>
            <button className="btn ml-auto" onClick={() => setLimit((l) => l + 25)}>
              Load older
            </button>
          </div>
        )}
      </div>

      {/* ── lessons in context ── */}
      <aside className="journal-side">
        <div className="panel-header">
          <Brain size={14} style={{ color: "var(--ai)" }} />
          <span style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>Lessons in context</span>
          <span className="mono ml-auto" style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)" }}>
            {lessons.length} / 5
          </span>
        </div>
        <div className="journal-side-note">
          This is injected verbatim into every conversation for {activeSession.pair}.
          A wrong line here keeps shaping the bot's answers until it's removed.
        </div>
        <div className="vy-scroll" style={{ flex: 1, overflowY: "auto" }}>
          {lessons.map((l, i) => (
            <div key={l.id} className="lesson-row">
              <span className="mono lesson-num">{i + 1}</span>
              <div className="lesson-body">
                <span>{l.content}</span>
                <div className="lesson-meta mono">
                  <span>distilled {when(l.created_at)}</span>
                </div>
              </div>
            </div>
          ))}
          {lessons.length === 0 && (
            <div style={{ padding: "12px 10px", fontSize: "var(--text-sm)", color: "var(--text-faint)", lineHeight: 1.6 }}>
              No lessons distilled yet. The reviewer folds them out of trade
              reviews every 5 closed positions — deliberately slow, so one
              lucky trade can't become a belief.
            </div>
          )}
        </div>
        <div className="journal-side-foot">
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
            Distilled automatically every 5 closed trades
          </span>
        </div>
      </aside>
    </div>
  );
}
