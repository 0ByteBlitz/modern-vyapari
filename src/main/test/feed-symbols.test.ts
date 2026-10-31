/**
 * Symbol mapping for the analysis feed (roadmap S2-9).
 *
 * This replaced five hand-written copies of `${base}USDT` and five copies of
 * the non-USD guard. The property that actually matters is the guard, not the
 * concatenation: **a non-USD pair must map to null, never to a best-effort
 * string.** Returning `GBPUSDT`-shaped nonsense for a GBP pair is how
 * FX-contaminated candles came to be written under a symbol that never traded
 * at those prices — the contamination schema v8 had to purge outright.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseAppSymbol,
  hasFeed,
  toFeedSymbol,
  fromFeedSymbol,
  isSameMarket,
  noFeedReason,
} from "../integrations/feed/symbols";

describe("app → feed", () => {
  test("USD and USDT quotes both map", () => {
    assert.equal(toFeedSymbol("BTC-USD"), "BTCUSDT");
    assert.equal(toFeedSymbol("ARB-USDT"), "ARBUSDT");
  });

  test("case is normalised", () => {
    assert.equal(toFeedSymbol("btc-usd"), "BTCUSDT");
  });

  test("a non-USD quote maps to NULL, not a guess", () => {
    /* The whole reason this module exists. A GBP pair has no analysis feed;
       synthesising one mixes an FX rate into price history. */
    assert.equal(toFeedSymbol("HYPE-GBP"), null);
    assert.equal(toFeedSymbol("BTC-EUR"), null);
  });

  test("malformed input maps to null rather than throwing", () => {
    for (const bad of ["", "BTC", "-USD", "BTC-", "///"]) {
      assert.equal(toFeedSymbol(bad), null, bad);
    }
  });
});

describe("feed → app", () => {
  test("a USDT pair maps back", () => {
    assert.equal(fromFeedSymbol("BTCUSDT"), "BTC-USD");
  });

  test("non-USDT symbols are refused", () => {
    /* The !ticker@arr firehose carries cross pairs and fiat pairs. Letting one
       through produces a symbol that looks tradable and is not. */
    assert.equal(fromFeedSymbol("ETHBTC"), null);
    assert.equal(fromFeedSymbol("EURUSD"), null);
    assert.equal(fromFeedSymbol("USDT"), null);
    assert.equal(fromFeedSymbol(""), null);
  });

  test("round-trips for USD pairs", () => {
    for (const s of ["BTC-USD", "ARB-USD", "TRX-USD"]) {
      assert.equal(fromFeedSymbol(toFeedSymbol(s)!), s);
    }
  });
});

describe("hasFeed and matching", () => {
  test("hasFeed agrees with toFeedSymbol", () => {
    for (const s of ["BTC-USD", "ARB-USDT", "HYPE-GBP", "nonsense", ""]) {
      assert.equal(hasFeed(s), toFeedSymbol(s) !== null, s);
    }
  });

  test("isSameMarket matches a subscription to a stream message", () => {
    assert.equal(isSameMarket("BTC-USD", "BTCUSDT"), true);
    assert.equal(isSameMarket("BTC-USD", "btcusdt"), true);
    assert.equal(isSameMarket("BTC-USD", "ETHUSDT"), false);
    assert.equal(isSameMarket("BTC-GBP", "BTCUSDT"), false, "a pair with no feed matches nothing");
  });

  test("parseAppSymbol splits and upper-cases", () => {
    assert.deepEqual(parseAppSymbol("arb-usd"), { base: "ARB", quote: "USD" });
    assert.equal(parseAppSymbol("arb"), null);
  });
});

describe("the refusal explains itself", () => {
  test("names the quote currency and why conversion is refused", () => {
    const why = noFeedReason("HYPE-GBP");
    assert.match(why, /GBP/);
    assert.match(why, /FX/i, "the reason must mention what conversion would do");
  });

  test("an unrecognised pair says so rather than blaming the quote", () => {
    assert.match(noFeedReason("garbage"), /not a recognised pair/);
  });
});
