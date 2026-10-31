/**
 * Symbol mapping between the app and the analysis feed (roadmap S2-9).
 *
 * The app speaks `BASE-QUOTE` (`BTC-USD`). Binance speaks `BASEUSDT`. That
 * translation was written by hand in **five** places — `indicators.ts` twice,
 * `binance-ws.ts`, `binance-derivatives.ts`, `basis-monitor.ts` — with the
 * non-USD guard repeated in five more. Five copies of a mapping rule is five
 * places for a venue with different conventions to break, and five places to
 * forget the rule below.
 *
 * ## The rule that must not be lost in the consolidation
 *
 * **Non-USD quotes are refused, never converted.** Binance quotes USDT, so
 * analysis is USD-quote only. Synthesising `BASEUSDT ÷ QUOTEUSDT` is exactly
 * what schema v8 had to purge: the FX rate defaulted to 1 until its first tick,
 * so raw USD prices were stored under a GBP symbol, and the REST backfill
 * applied no conversion at all — one symbol's cached history contained both
 * scales with a ~1.3x step where they met.
 *
 * So `toFeedSymbol` returns **null** for a non-USD quote. Null means "this pair
 * has no analysis feed", which is a fact callers must handle, not an error to
 * paper over. A session on a GBP pair can still exist — Revolut X trades them —
 * it simply cannot be charted or backtested.
 *
 * Pure: no IO, no config. When a second feed arrives this becomes the adapter's
 * method rather than a module, but the shape stays.
 */

/** Quote currencies that mean "US dollar" for analysis purposes. */
const USD_QUOTES = new Set(["USD", "USDT"]);

/** What the feed appends to a base to make a USD-quoted pair. */
const FEED_QUOTE = "USDT";

export interface ParsedSymbol {
  base: string;
  quote: string;
}

/** Split `BTC-USD` into its parts. Returns null if it is not that shape. */
export function parseAppSymbol(symbol: string): ParsedSymbol | null {
  const [base, quote] = (symbol ?? "").split("-");
  if (!base || !quote) return null;
  return { base: base.toUpperCase(), quote: quote.toUpperCase() };
}

/**
 * Does this pair have an analysis feed at all?
 *
 * The single definition of the guard that was written five times. A caller that
 * needs to explain *why* to a user should say the pair is not USD-quoted, not
 * that something failed.
 */
export function hasFeed(symbol: string): boolean {
  const parsed = parseAppSymbol(symbol);
  return parsed !== null && USD_QUOTES.has(parsed.quote);
}

/**
 * App symbol → feed symbol, or **null when there is no feed for it**.
 *
 * Null is the important half. Returning a best-effort string for a GBP pair is
 * how FX-contaminated candles got written under a symbol that never traded at
 * those prices.
 */
export function toFeedSymbol(symbol: string): string | null {
  const parsed = parseAppSymbol(symbol);
  if (!parsed || !USD_QUOTES.has(parsed.quote)) return null;
  return `${parsed.base}${FEED_QUOTE}`;
}

/**
 * Feed symbol → app symbol, or null if it is not a USD-quoted spot pair.
 *
 * Deliberately strict: the `!ticker@arr` firehose carries cross pairs, fiat
 * pairs and leveraged tokens, and letting one through produces a symbol that
 * looks tradable and is not.
 */
export function fromFeedSymbol(feedSymbol: string): string | null {
  if (!feedSymbol?.endsWith(FEED_QUOTE)) return null;
  const base = feedSymbol.slice(0, -FEED_QUOTE.length);
  if (!base) return null;
  return `${base}-USD`;
}

/**
 * Do an app symbol and a feed symbol refer to the same market?
 *
 * Used where a stream message must be matched back to a subscription. Written
 * as a comparison rather than left to callers so it cannot drift from
 * `toFeedSymbol`.
 */
export function isSameMarket(appSymbol: string, feedSymbol: string): boolean {
  const mapped = toFeedSymbol(appSymbol);
  return mapped !== null && mapped === feedSymbol.toUpperCase();
}

/** Human explanation for a pair with no analysis feed. One wording, everywhere. */
export function noFeedReason(symbol: string): string {
  const parsed = parseAppSymbol(symbol);
  if (!parsed) return `"${symbol}" is not a recognised pair.`;
  return (
    `${symbol} is quoted in ${parsed.quote}, and the analysis feed is USD-quoted only. ` +
    `Converting would mix an FX rate into price history — use the USD pair instead.`
  );
}

/* ── Feed scope ─────────────────────────────────────────────────────── */

/**
 * The `candles.source` value of the active analysis feed.
 *
 * Eighteen SQL predicates across ten files spelled this as the literal
 * `'binance'`. The identity of the analysis feed was therefore a string
 * repeated through the query layer, which meant a second feed could never be
 * introduced without finding all eighteen — and missing one would not fail,
 * it would silently blend two sources inside one computation. That is the
 * failure the one-feed-per-purpose rule exists to prevent, and the one schema
 * v8 had to purge a candle table over.
 *
 * **Source is identity, not metadata.** Switching feeds does not migrate
 * history; it starts a new cache, exactly as archiving starts a new session
 * epoch.
 */
export const ANALYSIS_FEED_SOURCE = "binance";

/**
 * The SQL fragment scoping a candle query to the analysis feed.
 *
 * A fragment rather than a bound parameter deliberately: these predicates sit
 * inside larger hand-written queries with their own placeholder ordering, and
 * threading one more parameter through eighteen call sites is precisely the
 * mechanical edit that goes wrong once and is never noticed. The value is a
 * module constant, not user input, so there is nothing here to inject.
 */
export const FEED_SCOPE_SQL = `source = '${ANALYSIS_FEED_SOURCE}'`;
