/**
 * Read-only queries backing the redesigned surfaces (Orders, Journal,
 * Dashboard activity, Portfolio).
 *
 * Everything here is SELECT-only by construction. The engines own all writes;
 * the UI is a viewer. Money values stay strings on the way out — the renderer
 * formats, it never does float arithmetic on prices.
 */
import { getDb } from "./database";
import { getAccountValue } from "../paper/account";
import type {
  ActivityEvent,
  ChartDrawing,
  JournalEntry,
  OrderRecord,
  PortfolioSummary,
  SessionSummary,
} from "../../shared/ipc-types";

// Shapes live in the shared IPC contract so main and renderer cannot drift.
export type { ActivityEvent, ChartDrawing, JournalEntry, OrderRecord, PortfolioSummary, SessionSummary };

/* ── Orders ──────────────────────────────────────────────────────────── */

export function listOrders(sessionId: number, limit = 200): OrderRecord[] {
  /* Fee comes from a correlated SUM, not a join.
     `LEFT JOIN trades` produced one output row PER FILL, so a partially filled
     order (which is what reconciliation against a real venue will produce)
     appeared two or three times in the Orders list, each row showing one
     fill's fee as if it were the order's total — and the duplicates counted
     against LIMIT, silently truncating the history. Paper fills one trade per
     order, so this was invisible today and would have surfaced the first time
     a live order filled in pieces. */
  return getDb()
    .prepare(
      `SELECT o.id, o.session_id, o.strategy_id, s.name AS strategy_name, o.client_order_id, o.symbol, o.side,
              o.type, o.quantity, o.quote_amount, o.price, o.status, o.mode, o.created_at,
              -- Cast back to TEXT: money crosses IPC as a string, always.
              (SELECT CAST(SUM(CAST(t.fee AS REAL)) AS TEXT) FROM trades t WHERE t.order_id = o.id) AS fee
       FROM orders o
       LEFT JOIN strategies s ON s.id = o.strategy_id
       WHERE o.session_id = ?
       ORDER BY o.created_at DESC
       LIMIT ?`
    )
    .all(sessionId, limit) as unknown as OrderRecord[];
}

/* ── Journal ─────────────────────────────────────────────────────────── */


/**
 * Journal entries for a session, newest first.
 * `query` runs against the FTS5 index; `kind` filters by entry type.
 */
export function listJournal(
  sessionId: number,
  opts: { kind?: string; query?: string; limit?: number } = {}
): JournalEntry[] {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 100, 500);
  const kind = opts.kind && opts.kind !== "all" ? opts.kind : null;
  const query = opts.query?.trim() || null;

  if (query) {
    // journal_fts has no session_id, so join back to journal and filter there.
    const kindClause = kind ? "AND j.kind = ?" : "";
    const params: (string | number)[] = [query, sessionId];
    if (kind) params.push(kind);
    params.push(limit);

    return db
      .prepare(
        `SELECT j.id, j.session_id, j.kind, j.content, j.tags, j.ref_strategy_id, j.created_at
         FROM journal_fts f
         JOIN journal j ON j.id = f.rowid
         WHERE journal_fts MATCH ? AND j.session_id = ? ${kindClause}
         ORDER BY j.created_at DESC LIMIT ?`
      )
      .all(...params) as unknown as JournalEntry[];
  }

  const kindClause = kind ? "AND kind = ?" : "";
  const params: (string | number)[] = [sessionId];
  if (kind) params.push(kind);
  params.push(limit);

  return db
    .prepare(
      `SELECT id, session_id, kind, content, tags, ref_strategy_id, created_at
       FROM journal WHERE session_id = ? ${kindClause}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params) as unknown as JournalEntry[];
}

/** Per-kind counts, for the journal's filter chips. */
export function journalCounts(sessionId: number): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT kind, COUNT(*) AS n FROM journal WHERE session_id = ? GROUP BY kind`)
    .all(sessionId) as { kind: string; n: number }[];

  const out: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    out[r.kind] = r.n;
    total += r.n;
  }
  out.all = total;
  return out;
}

/* ── Engine activity ─────────────────────────────────────────────────── */


/**
 * The audit log — every order-affecting action the deterministic engines took.
 * The dashboard shows this verbatim: it is the record of what the *code* did,
 * with no AI anywhere in the path, which is exactly what makes it trustworthy.
 */
export function listActivity(limit = 60): ActivityEvent[] {
  return getDb()
    .prepare(`SELECT id, action, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT ?`)
    .all(Math.min(limit, 300)) as unknown as ActivityEvent[];
}

/**
 * The audit log as one session sees it: its own events, plus the app-wide ones
 * that change what its plans could do — a monitor gap (nothing could trigger)
 * and the kill switch (no new entries) — while the session was live: not
 * before it was created, and not after it was archived.
 *
 * The session dashboard used to show `listActivity` unfiltered, so ETH-USD's
 * feed listed BTC-USD's "session created" and every mode change. Events name
 * their owner in different ways — a session id under three spellings, or a
 * plan, position, strategy or alert id — so each is resolved to its session
 * here rather than by matching text in the renderer.
 */
export function listSessionActivity(sessionId: number, limit = 60): ActivityEvent[] {
  return getDb()
    .prepare(
      `SELECT id, action, detail, created_at FROM audit_log a
       WHERE (a.action IN ('monitor_gap', 'kill_switch_tripped', 'kill_switch_reset')
              AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = :sid AND a.created_at >= s.created_at
                          AND (s.status != 'archived' OR a.created_at <= s.updated_at)))
          OR json_extract(a.detail, '$.sessionId') = :sid
          OR json_extract(a.detail, '$.session_id') = :sid
          OR (substr(a.action, 1, 8) = 'session_' AND json_extract(a.detail, '$.id') = :sid)
          OR EXISTS (SELECT 1 FROM trade_plans p WHERE p.id = json_extract(a.detail, '$.planId') AND p.session_id = :sid)
          OR EXISTS (SELECT 1 FROM paper_positions p WHERE p.id = json_extract(a.detail, '$.position_id') AND p.session_id = :sid)
          OR EXISTS (SELECT 1 FROM strategies s WHERE s.id = COALESCE(json_extract(a.detail, '$.strategy_id'), json_extract(a.detail, '$.strategyId')) AND s.session_id = :sid)
          OR EXISTS (SELECT 1 FROM alerts al WHERE al.id = json_extract(a.detail, '$.alertId') AND al.session_id = :sid)
       ORDER BY a.created_at DESC LIMIT :lim`
    )
    .all({ sid: sessionId, lim: Math.min(limit, 300) }) as unknown as ActivityEvent[];
}

/* ── Chart drawings (research annotations) ───────────────────────────── */


export function listDrawings(symbol: string, intervalMin?: number): ChartDrawing[] {
  // interval_min NULL means "every timeframe" — a horizontal level drawn on
  // the 1h is still true on the 5m, so those must come back on both.
  return getDb()
    .prepare(
      `SELECT * FROM chart_drawings
       WHERE symbol = ? AND (interval_min IS NULL ${intervalMin !== undefined ? "OR interval_min = ?" : ""})
       ORDER BY created_at ASC`
    )
    .all(...(intervalMin !== undefined ? [symbol, intervalMin] : [symbol])) as unknown as ChartDrawing[];
}

export function saveDrawing(d: {
  id?: number;
  symbol: string;
  intervalMin: number | null;
  kind: string;
  points: unknown;
  extend?: unknown;
  locked?: boolean;
}): ChartDrawing {
  const db = getDb();
  const now = Date.now();
  const points = JSON.stringify(d.points ?? []);
  const extend = JSON.stringify(d.extend ?? {});
  const locked = d.locked ? 1 : 0;

  if (d.id) {
    db.prepare(
      `UPDATE chart_drawings SET points = ?, extend = ?, locked = ?, updated_at = ? WHERE id = ?`
    ).run(points, extend, locked, now, d.id);
    return db.prepare(`SELECT * FROM chart_drawings WHERE id = ?`).get(d.id) as unknown as ChartDrawing;
  }

  const res = db
    .prepare(
      `INSERT INTO chart_drawings (symbol, interval_min, kind, points, extend, locked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(d.symbol, d.intervalMin, d.kind, points, extend, locked, now, now);

  return db
    .prepare(`SELECT * FROM chart_drawings WHERE id = ?`)
    .get(Number(res.lastInsertRowid)) as unknown as ChartDrawing;
}

export function deleteDrawing(id: number): { ok: true } {
  getDb().prepare(`DELETE FROM chart_drawings WHERE id = ?`).run(id);
  return { ok: true };
}

export function clearDrawings(symbol: string): { deleted: number } {
  const res = getDb().prepare(`DELETE FROM chart_drawings WHERE symbol = ?`).run(symbol);
  return { deleted: Number(res.changes) };
}

/* ── Portfolio (cross-session) ───────────────────────────────────────── */



/** Aggregate paper performance across every non-archived session. */
export function portfolioSummary(includeArchived = false): PortfolioSummary {
  const db = getDb();

  const sessions = db
    .prepare(
      `SELECT id, uuid, pair, status, paper_balance FROM sessions
       ${includeArchived ? "" : "WHERE status != 'archived'"}
       ORDER BY created_at ASC`
    )
    .all() as { id: number; uuid: string; pair: string; status: string; paper_balance: string }[];

  const out: SessionSummary[] = sessions.map((s) => {
    const agg = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
           SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
           SUM(CASE WHEN status = 'closed' AND CAST(realized_pnl AS REAL) > 0 THEN 1 ELSE 0 END) AS wins,
           COALESCE(SUM(CASE WHEN status = 'closed' THEN CAST(realized_pnl AS REAL) ELSE 0 END), 0) AS pnl,
           COALESCE(SUM(CAST(COALESCE(fees_total, entry_fee) AS REAL)), 0) AS fees,
           MAX(COALESCE(closed_at, opened_at)) AS last_at
         FROM paper_positions WHERE session_id = ?`
      )
      .get(s.id) as any;

    /* Plans, not strategies. This read the strategies table, frozen since
       30 Jul, so "armed" was always 0 and a session with armed plans and an
       open position was badged "idle" — an armed-vs-idle ambiguity in the
       direction that hides risk. */
    const plans = db
      .prepare(
        `SELECT SUM(CASE WHEN state IN ('draft','planned','triggered') THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN state = 'planned' THEN 1 ELSE 0 END) AS armed
         FROM trade_plans WHERE session_id = ?`
      )
      .get(s.id) as any;

    return {
      id: s.id,
      uuid: s.uuid,
      pair: s.pair,
      status: s.status,
      openCount: agg?.open_count || 0,
      closedCount: agg?.closed_count || 0,
      wins: agg?.wins || 0,
      realizedPnl: agg?.pnl || 0,
      fees: agg?.fees || 0,
      planCount: plans?.active || 0,
      armedCount: plans?.armed || 0,
      lastActivityAt: agg?.last_at ?? null,
    };
  });

  const value = getAccountValue();

  return {
    sessions: out,
    totals: {
      /* THE fix. This used to sum a per-session balance that defaulted to
         10,000 each, so the portfolio's headline cash was really a count of
         sessions: five sessions read $50,000. One account, read once.

         Cash AND equity, because they are different facts and showing only
         cash makes an open position look like a loss: opening one spends the
         money, so cash drops by the full entry and nothing yet shows what was
         bought. */
      cashBalance: value.cash,
      equity: value.equity,
      unrealisedPnl: value.unrealisedPnl,
      unpricedPositions: value.unpricedPositions,
      realizedPnl: out.reduce((a, s) => a + s.realizedPnl, 0),
      fees: out.reduce((a, s) => a + s.fees, 0),
      openCount: out.reduce((a, s) => a + s.openCount, 0),
      closedCount: out.reduce((a, s) => a + s.closedCount, 0),
      wins: out.reduce((a, s) => a + s.wins, 0),
      sessions: out.length,
    },
  };
}
