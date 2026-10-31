/**
 * The venue port (roadmap S2-9, `docs/ARCHITECTURE.md` §4).
 *
 * **Shaped by what this app needs, not by what Revolut X offers.** A port with
 * one implementation is usually the wrong port — you do not learn the seam
 * until the second adapter exists — so the mitigation is to derive it from the
 * call sites that already exist rather than from a venue's API surface. Today
 * those are: balances, pair configuration, tickers, venue candles (for
 * reconciliation only), and the order path Sprint 4 will add.
 *
 * ## What a venue is, and is not
 *
 * The venue is **execution and account truth** — balances, orders, fills,
 * reconciliation. It is *not* the analysis feed. `getCandles` exists here for
 * reconciliation against the venue's own view and **must never be charted or
 * fed to an indicator**; that rule predates this port (CLAUDE.md, owner
 * decision 2026-07-26) and the port must make it easier to keep, not harder,
 * which is why the method is named and documented as such.
 *
 * ## Capabilities are declared, never assumed
 *
 * Venues differ in ways that matter for safety, not just for features: whether
 * a stop can rest **on the venue**, whether OCO exists server-side, what the
 * daily order cap is. A lowest-common-denominator port would smooth those away,
 * and the specific danger is a venue-side stop the app then quietly emulates
 * locally — which the plan forbids outright, because a local stop is not a stop
 * if the app is closed. So an adapter *declares* what it supports and callers
 * branch on it explicitly.
 *
 * ## Security constraints on any implementation
 *
 *  • Adapters are **compiled in, never dynamically loaded**. No plugin
 *    directory, no user-supplied path, no dynamic `require`. A pluggable venue
 *    that can run arbitrary code with vault access is a credential stealer with
 *    a config file.
 *  • Credentials are read from the vault inside the adapter and **never leave
 *    the main process**, never enter a log, a prompt, or the database.
 *  • Responses are **untrusted input**. A venue — or worse, a third-party MCP
 *    host standing in for one — can return anything. Adapters validate before
 *    returning, and never pass raw payloads into a model prompt.
 *  • **No AI call may sit in the order path.** An MCP tool call is
 *    deterministic code rather than a model call, so MCP-as-transport does not
 *    breach that; but order placement stays signed REST regardless.
 */

import type { IntegrationAuthSpec } from "../../security/integration-secrets";

/* ── Money and market types ─────────────────────────────────────────── */

/** Money and quantities stay strings end to end — never float arithmetic. */
export interface VenueBalance {
  currency: string;
  available: string;
  reserved: string;
  staked?: string;
  total: string;
}

export interface VenueTicker {
  /** Canonical app symbol, e.g. "BTC-USD" — never the venue's own spelling. */
  symbol: string;
  bid: string;
  ask: string;
  mid: string;
  last_price: string;
}

export interface VenuePair {
  base: string;
  quote: string;
  base_step: string;
  quote_step: string;
  min_order_size: string;
  max_order_size: string;
  min_order_size_quote: string;
  status: string;
}

export interface VenueCandle {
  /** Bar open time, ms epoch. Named `startMs` rather than the venue's `start`
   *  so an adapter is forced to map explicitly — a field that happens to line
   *  up today is how two shapes silently diverge later. */
  startMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/* ── Capabilities ───────────────────────────────────────────────────── */

/**
 * What an adapter can actually do.
 *
 * Every field exists because a caller must branch on it. Adding a flag nothing
 * reads would be a control that does not control — this project's recurring
 * bug class — so the set stays minimal and grows with real call sites.
 */
export interface VenueCapabilities {
  /** How this venue authenticates, and which secret fields it needs. Declared
   *  so settings can render the right form and so a second scheme has
   *  somewhere to live — see `security/integration-secrets.ts`. */
  readonly auth: IntegrationAuthSpec;
  /** Stable adapter id. Recorded on rows and in the audit log. */
  readonly id: string;
  /** Shown in settings and in execution-truth annotations in the UI. */
  readonly displayName: string;
  /** Can the venue hold a stop-loss / take-profit order server-side?
   *  **If false, the app must refuse live trading rather than emulate one** —
   *  a local stop is not a stop if the app is closed (plan hard rule). */
  readonly venueSideProtectiveOrders: boolean;
  /** Does the venue cancel the sibling of a bracket itself? If false, OCO is
   *  the app's responsibility and must be visible as such. */
  readonly venueSideOco: boolean;
  /** Hard cap on orders per day, if the venue imposes one. Revolut X: 1000. */
  readonly dailyOrderLimit: number | null;
  /** Whether this adapter can place orders at all. A read-only adapter — an
   *  MCP transport, for instance — declares false and the order path refuses
   *  it loudly instead of discovering the gap at submit time. */
  readonly canPlaceOrders: boolean;
}

/* ── The port ───────────────────────────────────────────────────────── */

/**
 * Read-side operations. Deliberately separate from execution: an adapter may
 * legitimately implement only this half (a venue whose MCP server is read-only
 * by design), and the type system should say so rather than a runtime throw.
 */
export interface VenueReadPort {
  readonly capabilities: VenueCapabilities;

  /** Account balances — execution truth, used to value real holdings. */
  getBalances(): Promise<VenueBalance[]>;

  /** Venue trading rules per pair: steps, minimums, status. Also the authority
   *  on whether a pair can be traded at all. */
  getPairs(): Promise<Record<string, VenuePair>>;

  /** Top of book. Used for portfolio valuation and the basis monitor. */
  getTickers(symbols?: string[]): Promise<VenueTicker[]>;

  /**
   * Venue candles — **reconciliation only.**
   *
   * Not for charts, not for indicators, not for backtests, not for level
   * resolution. Those come from the analysis feed, and mixing the two inside
   * one computation is the failure that cost schema v8 a full candle purge.
   */
  getCandlesForReconciliation(
    symbol: string,
    intervalMinutes: number,
    sinceMs?: number,
    untilMs?: number
  ): Promise<VenueCandle[]>;
}

/**
 * Execution. Empty for now **on purpose**: Sprint 4 owns the order path, and
 * writing speculative method signatures before the risk engine wires into them
 * would be scaffolding that lies about being ready. The interface exists so the
 * split between read and execute is expressible today, and so an adapter can
 * declare `canPlaceOrders: false` honestly.
 */
export interface VenueExecutionPort {
  readonly capabilities: VenueCapabilities;
}

export type VenuePort = VenueReadPort & Partial<VenueExecutionPort>;
