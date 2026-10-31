import { getDb } from "../db/database";
import { getPaperBalance } from "../paper/account";
import { getLessonsForPair, type SharedLesson } from "../db/shared-store";
import { classifyRegime, describeRegime, regimeApplies, type MarketRegime } from "../insights/regime";
import { dbCandleSource } from "../insights/level-resolver";

/** Regime is measured on the plan default interval. */
const REGIME_INTERVAL_MIN = 240;
const REGIME_BARS = 150;
import { getSessionById, type Session } from "../sessions/service";

/**
 * Session context assembly (plan §5, §8): every chat turn for a session must
 * carry pair + session data so Claude reasons about THIS pair's history, not
 * a blank slate. This is injected into the system prompt on every request.
 *
 * Three memory layers per the plan:
 *   1. Structured facts (trade stats) — queried fresh each time, exact.
 *   2. Recent journal — last few entries, chronological.
 *   3. Distilled lessons — most recent 'lesson' kind entries (curated summary).
 * Full-text journal search beyond this snapshot is exposed via the
 * read_session_memory tool (see tools.ts), not dumped wholesale here.
 */

interface TradeStats {
  totalTrades: number;
  buys: number;
  sells: number;
  lastTradeAt: number | null;
  paperTrades: number;
  liveTrades: number;
}

function getTradeStats(sessionId: number): TradeStats {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buys,
         SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sells,
         MAX(executed_at) AS last_trade_at,
         SUM(CASE WHEN mode = 'paper' THEN 1 ELSE 0 END) AS paper_trades,
         SUM(CASE WHEN mode = 'live' THEN 1 ELSE 0 END) AS live_trades
       FROM trades WHERE session_id = ?`
    )
    .get(sessionId) as {
    total: number;
    buys: number | null;
    sells: number | null;
    last_trade_at: number | null;
    paper_trades: number | null;
    live_trades: number | null;
  };
  return {
    totalTrades: row.total,
    buys: row.buys ?? 0,
    sells: row.sells ?? 0,
    lastTradeAt: row.last_trade_at,
    paperTrades: row.paper_trades ?? 0,
    liveTrades: row.live_trades ?? 0,
  };
}

interface JournalRow {
  kind: string;
  content: string;
  tags: string;
  created_at: number;
}

function getRecentJournal(sessionId: number, limit: number): JournalRow[] {
  return getDb()
    .prepare(
      `SELECT kind, content, tags, created_at FROM journal
       WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(sessionId, limit) as unknown as JournalRow[];
}


/** What a lesson rests on, in one clause. The text's own "seen in 4 of 6" is
 *  the model's claim; this is the recorded count. */
function evidenceNote(l: SharedLesson): string {
  if (!l.evidence_trades) return "";
  return ` (from ${l.evidence_trades} closed ${l.evidence_trades === 1 ? "trade" : "trades"})`;
}

/**
 * Lessons for this session's PAIR, from the store both modes open.
 *
 * Keyed by pair rather than session on purpose: a lesson about how a market
 * behaves does not stop being true because a session was archived, and it must
 * survive the move from simulated to live. What must NOT cross is a hit rate —
 * that stays in the mode's own database (`plans/calibration.ts`).
 */
function getLessons(pair: string, limit: number): SharedLesson[] {
  return getLessonsForPair(pair, limit);
}

/**
 * What kind of market is this pair in right now?
 *
 * Measured, never asked of the model. Used to say which lessons apply — see
 * `insights/regime.ts` for why an unconditional lesson is either
 * overgeneralised or wrong.
 */
function currentRegime(pair: string): MarketRegime {
  try {
    const bars = dbCandleSource(pair, REGIME_INTERVAL_MIN, 0, Date.now()).slice(-REGIME_BARS);
    return classifyRegime(bars);
  } catch {
    return classifyRegime([]);
  }
}

function getActiveStrategyCount(sessionId: number): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM strategies WHERE session_id = ? AND state != 'retired'`)
    .get(sessionId) as { c: number };
  return row.c;
}

function formatAge(createdAtMs: number): string {
  const days = Math.floor((Date.now() - createdAtMs) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function formatJournalEntry(j: JournalRow): string {
  const tags = j.tags ? ` [${j.tags}]` : "";
  const date = new Date(j.created_at).toLocaleDateString();
  return `- (${date}, ${j.kind}${tags}) ${j.content}`;
}

interface OpenPositionRow {
  symbol: string;
  entry_price: string;
  quantity: string;
  stop_price: string | null;
  target_price: string | null;
  opened_at: number;
}

function getOpenPositions(sessionId: number): OpenPositionRow[] {
  return getDb()
    .prepare(
      `SELECT symbol, entry_price, quantity, stop_price, target_price, opened_at
       FROM paper_positions WHERE session_id = ? AND status = 'open'
       ORDER BY opened_at DESC`
    )
    .all(sessionId) as unknown as OpenPositionRow[];
}

function getRecentTriggeredAlerts(sessionId: number, limit = 5): { label: string; triggered_at: number }[] {
  return getDb()
    .prepare(
      `SELECT label, triggered_at FROM alerts
       WHERE session_id = ? AND status = 'triggered' AND triggered_at IS NOT NULL
       ORDER BY triggered_at DESC LIMIT ?`
    )
    .all(sessionId, limit) as unknown as { label: string; triggered_at: number }[];
}

/**
 * Plans the engine is actively watching on this session.
 *
 * Injected into every conversation because the alternative is an agent that
 * cannot see the product. Before this, the owner could ask "paper trade the
 * armed plan" and the agent had no way to know a plan existed — it answered
 * about strategies, the one thing it could observe. Tools alone do not fix
 * that: a tool is only called when the model already suspects there is
 * something to look at.
 *
 * `triggered` is included deliberately, same as the monitor's own filter — a
 * thesis can be disproved while its position is green, so a fired plan is not
 * a finished one.
 */
function getWatchedPlans(sessionId: number): PlanRowLite[] {
  return getDb()
    .prepare(
      `SELECT id, slug, state, thesis, expires_at, oco_exclusive
         FROM trade_plans
        WHERE session_id = ? AND state IN ('planned','triggered')
        ORDER BY id ASC`
    )
    .all(sessionId) as unknown as PlanRowLite[];
}

interface PlanRowLite {
  id: number;
  slug: string;
  state: string;
  thesis: string;
  expires_at: number;
  oco_exclusive: number;
}

/**
 * Builds the session-context block injected into the system prompt.
 * Returns null for free-view chat (no session) — caller falls back to the
 * generic system prompt.
 */
export function buildSessionContext(sessionId: number): string {
  const session: Session | null = getSessionById(sessionId);
  if (!session) return "No session context available (session not found).";

  const stats = getTradeStats(sessionId);
  const recentJournal = getRecentJournal(sessionId, 8);
  const lessons = getLessons(session.pair, 5);
  const regime = currentRegime(session.pair);
  const activeStrategies = getActiveStrategyCount(sessionId);
  const triggeredAlerts = getRecentTriggeredAlerts(sessionId, 5);
  const openPositions = getOpenPositions(sessionId);
  const watchedPlans = getWatchedPlans(sessionId);

  const lines: string[] = [];
  lines.push(`## Session context`);
  lines.push(`Pair: ${session.pair}`);
  lines.push(`Session status: ${session.status} · opened ${formatAge(session.created_at)}`);
  lines.push(`Active strategies: ${activeStrategies}`);
  /* One account, shared across sessions — a per-session figure here would
     tell the agent each pair has its own money, which is what the schema used
     to imply and never meant. */
  lines.push(`Paper account balance (shared across sessions): $${getPaperBalance().toFixed(2)}`);
  lines.push(
    `Trade history: ${stats.totalTrades} trade(s) (${stats.buys} buy / ${stats.sells} sell) — ` +
      `${stats.paperTrades} paper, ${stats.liveTrades} live` +
      (stats.lastTradeAt ? `; last trade ${formatAge(stats.lastTradeAt)}` : "; no trades yet")
  );

  /* Before open positions, because a plan is what the owner authored and the
     position is only its consequence — and because with execution unwired,
     plans are the only thing actually running. */
  if (watchedPlans.length > 0) {
    lines.push("");
    lines.push(`### Armed plans (the engine is watching these)`);
    for (const p of watchedPlans) {
      const left = p.expires_at - Date.now();
      const expiry =
        left <= 0 ? "EXPIRED" : left < 2 * 86_400_000 ? `expires in ${Math.max(1, Math.round(left / 3_600_000))}h` : `expires in ${Math.floor(left / 86_400_000)}d`;
      lines.push(`- "${p.slug}" [${p.state}] — ${p.thesis} (${expiry})`);
    }
    /* State the boundary here rather than leaving the model to infer it from
       the word "armed": expiry, invalidation and drift act; a trigger records
       and opens nothing. Getting this wrong is what made the agent offer to
       build a strategy instead. */
    lines.push(
      `Use get_plan for the assumptions, invalidation and branch levels. The engine evaluates these every ` +
        `closed bar — expiry, thesis invalidation and drift all act — but a triggered branch does NOT open a ` +
        `position yet. You cannot create or arm a plan; only the owner can.`
    );
  }

  if (openPositions.length > 0) {
    lines.push("");
    lines.push(`### Currently open positions`);
    for (const p of openPositions) {
      const stop = p.stop_price ? `, stop: $${parseFloat(p.stop_price).toFixed(2)}` : "";
      const target = p.target_price ? `, target: $${parseFloat(p.target_price).toFixed(2)}` : "";
      lines.push(
        `- ${p.symbol} @ $${parseFloat(p.entry_price).toFixed(2)} (qty: ${parseFloat(p.quantity).toFixed(6)}${stop}${target}) opened ${formatAge(p.opened_at)}`
      );
    }
  }

  if (triggeredAlerts.length > 0) {
    lines.push("");
    lines.push(`### Recently triggered alerts`);
    for (const a of triggeredAlerts) {
      lines.push(`- "${a.label}" fired ${formatAge(a.triggered_at)}`);
    }
  }

  if (lessons.length > 0) {
    lines.push("");
    /* Split by whether the conditions match, rather than dumped as one list.
       A lesson learned in a trend, applied unqualified in a range, is worse
       than no lesson — so the ones that do not match are still shown (they may
       still be useful) but are labelled, which is what stops the agent
       treating them as established fact about right now. */
    const applies = lessons.filter((l) => regimeApplies(l.regime as never, regime.trend));
    const others = lessons.filter((l) => !applies.includes(l));

    lines.push(`### What this market is doing now`);
    lines.push(`${describeRegime(regime)} — measured from ADX and ATR, not judged.`);

    if (applies.length > 0) {
      lines.push("");
      lines.push(`### Lessons that apply in these conditions`);
      for (const l of applies) lines.push(`- ${l.content}${evidenceNote(l)}`);
    }
    if (others.length > 0) {
      lines.push("");
      lines.push(`### Lessons learned in DIFFERENT conditions — weigh accordingly`);
      for (const l of others) {
        lines.push(`- [learned in ${l.regime}] ${l.content}${evidenceNote(l)}`);
      }
    }
  }

  if (recentJournal.length > 0) {
    lines.push("");
    lines.push(`### Recent journal entries (most recent first)`);
    lines.push(...recentJournal.map(formatJournalEntry));
  }

  if (lessons.length === 0 && recentJournal.length === 0 && triggeredAlerts.length === 0) {
    lines.push("");
    lines.push(`No journal history yet for this pair — this is a fresh session.`);
  }

  lines.push("");
  lines.push(
    `Use the read_candles, query_trades, read_session_memory, and write_journal tools to pull more ` +
      `detail or record observations. Do not assume data beyond what is shown here or returned by tools.`
  );

  return lines.join("\n");
}
