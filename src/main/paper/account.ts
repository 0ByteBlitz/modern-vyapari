/**
 * One paper balance for the whole app, not one per session.
 *
 * ## What was wrong
 *
 * `sessions.paper_balance` defaulted to `'10000.00'`, so **every session was
 * minted ten thousand dollars out of nothing**, and the portfolio total was
 * their sum. The arrow ran the opposite way to how it read: portfolio cash was
 * derived from sessions rather than shared among them. Open five sessions and
 * the headline said $50,000 — a figure that looks like capital and is actually
 * a count of how many sessions you happened to create.
 *
 * It also meant "what if I have no cash?" had no answer, because the state was
 * unreachable. That is not reassuring; it is the defect.
 *
 * ## Why one balance
 *
 * There were three competing notions of available capital: a plan's
 * `risk.maxQuote` (absolute, signed at arm time), a session's balance, and the
 * portfolio total. Only the first was intentional. Two definitions of one idea
 * is the rule this codebase keeps paying for, and *how much can I actually
 * deploy* is exactly the kind of state that must not be ambiguous.
 *
 * A session is a **workspace** — a pair's plans, journal and history. Cash is
 * not a property of a workspace. It belongs to the account, and there is one
 * account per app mode because the two databases never mix.
 *
 * In live mode this table is not the authority: the venue's balances are, via
 * `venue().getBalances()`. This is the simulated account.
 */

import { getDb } from "../db/database";
import { FEED_SCOPE_SQL } from "../integrations/feed/symbols";

/** What a fresh simulated account starts with, and what returns measure from. */
export const DEFAULT_STARTING_BALANCE = 10_000;

export interface PaperAccount {
  balance: number;
  /** What it started at, so a return is computable without replaying fills. */
  initialBalance: number;
  updatedAt: number;
}

export function getPaperAccount(): PaperAccount {
  const row = getDb()
    .prepare(`SELECT balance, initial_balance, updated_at FROM paper_account WHERE id = 1`)
    .get() as { balance: string; initial_balance: string; updated_at: number } | undefined;

  /* Absent only before the migration has run on a brand-new file. Seeding here
     rather than returning zero: a zero balance would silently refuse every
     entry and look like a risk rule rather than a missing row. */
  if (!row) {
    return { balance: DEFAULT_STARTING_BALANCE, initialBalance: DEFAULT_STARTING_BALANCE, updatedAt: 0 };
  }
  return {
    balance: parseFloat(row.balance),
    initialBalance: parseFloat(row.initial_balance),
    updatedAt: row.updated_at,
  };
}

export function getPaperBalance(): number {
  const b = getPaperAccount().balance;
  return Number.isFinite(b) ? b : 0;
}

/**
 * Set the balance after a fill. Money stays a string in the column.
 *
 * **Upsert, not update.** A plain `UPDATE … WHERE id = 1` against a missing row
 * affects nothing and reports success, so every fill would settle silently and
 * the balance would sit frozen at its default for ever — a write path that does
 * not write, which is the same shape as a control that does not control. The
 * row is normally seeded by the v20 migration; this makes a missing one
 * self-healing rather than silently wrong.
 */
export function setPaperBalance(next: number): void {
  getDb()
    .prepare(
      `INSERT INTO paper_account (id, balance, initial_balance, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at`
    )
    .run(next.toString(), String(DEFAULT_STARTING_BALANCE), Date.now());
}

/**
 * Reset the account — the owner choosing what they are trading with.
 *
 * Resets `initial_balance` too, because a return measured against a starting
 * figure the owner has since changed is not a return.
 */
export function resetPaperAccount(startingBalance: number): void {
  const v = Number.isFinite(startingBalance) && startingBalance > 0 ? startingBalance : DEFAULT_STARTING_BALANCE;
  getDb()
    .prepare(
      `INSERT INTO paper_account (id, balance, initial_balance, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET balance = excluded.balance,
                                     initial_balance = excluded.initial_balance,
                                     updated_at = excluded.updated_at`
    )
    .run(v.toString(), v.toString(), Date.now());
}

/**
 * Can this trade be funded?
 *
 * Returns a reason rather than a boolean: "not enough cash" is a refusal the
 * owner will read, and the numbers are what make it actionable. Now reachable,
 * where the per-session mint made it impossible.
 */
export function canFund(quoteAmount: number): { ok: true } | { ok: false; reason: string } {
  const balance = getPaperBalance();
  if (quoteAmount <= balance) return { ok: true };
  return {
    ok: false,
    reason: `Needs ${quoteAmount.toFixed(2)} but the paper account holds ${balance.toFixed(2)}.`,
  };
}

/* ── Account value: cash is not the same as what you have ───────────── */

export interface AccountValue {
  /** Spendable. Falls when a position opens, rises when one closes. */
  cash: number;
  /** Open positions marked to the analysis feed's latest close. */
  openValue: number;
  /** Mark minus entry, across open positions. Zero when nothing is open. */
  unrealisedPnl: number;
  /** cash + openValue — what the account is actually worth right now. */
  equity: number;
  /**
   * Open positions with no recent candle, valued at cost.
   *
   * Surfaced rather than hidden: valuing at entry is the least-wrong option,
   * but it silently reports zero unrealised P&L for that position, and a
   * reader deserves to know the figure is incomplete rather than flat.
   */
  unpricedPositions: number;
}

/**
 * What the account is worth, cash and open positions together.
 *
 * **Cash alone reads as a drawdown while a position is open** — opening one
 * spends the money, so the balance drops by the full size of the entry and
 * nothing yet shows what was bought. `getEquity` on the paper engine was
 * written for exactly this and **was called by nothing**, so every surface
 * showed cash and called it the account. This is that function, reachable.
 *
 * Marks come from the **analysis feed** — the same source the engine fills
 * against. Pricing an open position from the venue would put two sources inside
 * one number, which is the rule that cost schema v8 a full candle purge.
 */
export function getAccountValue(): AccountValue {
  const cash = getPaperBalance();
  const rows = getDb()
    .prepare(
      `SELECT p.symbol AS symbol, p.entry_price AS entry_price, p.quantity AS quantity,
              (SELECT c.close FROM candles c
                WHERE c.symbol = p.symbol AND ${FEED_SCOPE_SQL}
                ORDER BY c.start_ms DESC LIMIT 1) AS mark
       FROM paper_positions p WHERE p.status = 'open'`
    )
    .all() as Array<{ symbol: string; entry_price: string; quantity: string; mark: string | null }>;

  let openValue = 0;
  let cost = 0;
  let unpriced = 0;
  for (const r of rows) {
    const qty = parseFloat(r.quantity);
    const entry = parseFloat(r.entry_price);
    const mark = r.mark === null ? null : parseFloat(r.mark);
    if (!Number.isFinite(qty) || !Number.isFinite(entry)) continue;
    /* No candle → value at cost and SAY so, rather than reporting a confident
       zero unrealised P&L for a position nobody can price. */
    const price = mark !== null && Number.isFinite(mark) ? mark : (unpriced++, entry);
    openValue += price * qty;
    cost += entry * qty;
  }

  return {
    cash,
    openValue,
    unrealisedPnl: openValue - cost,
    equity: cash + openValue,
    unpricedPositions: unpriced,
  };
}
