/**
 * Revolut X behind the venue port (roadmap S2-9).
 *
 * A thin adapter over the existing `revx/client`, not a rewrite. The client
 * keeps the signing, the HTTP and the venue's own shapes; this states what
 * Revolut X *is* in the app's terms and declares what it can do.
 *
 * The capability values are not decoration — each one is a fact that changes
 * what the app is allowed to do:
 *
 *  • `venueSideProtectiveOrders` gates live trading entirely. The plan's hard
 *    rule is that every live position carries a venue-side stop, so an adapter
 *    that cannot rest one must refuse live mode rather than emulate it locally.
 *    **Set to `false` here deliberately: it is unverified.** Sprint 4 (S4-2)
 *    confirms it against the real API, and claiming support before then would
 *    be exactly the "value presented with more confidence than it earned"
 *    failure this codebase keeps paying for.
 *  • `dailyOrderLimit` is the documented Revolut X cap of 1,000 limit orders
 *    per day. The risk engine is meant to refuse at 90% of it with a visible
 *    warning, rather than discovering the ceiling by being rejected.
 *  • `canPlaceOrders` is `false` until S4-1 exists. `exchange/revolutx-exchange.ts`
 *    still throws `LiveExecutionNotImplementedError`, and this flag is the
 *    honest, checkable version of that throw.
 */

import * as revx from "../../revx/client";
import type { IntegrationAuthSpec } from "../../security/integration-secrets";
import type {
  VenueBalance,
  VenueCandle,
  VenueCapabilities,
  VenuePair,
  VenueReadPort,
  VenueTicker,
} from "./port";

/**
 * Revolut X signs each request with an Ed25519 key and identifies itself with
 * an API key header.
 *
 * `legacyStorage: true` is load-bearing documentation: these secrets still live
 * at the original fixed filenames (`private.key.enc`, `public.pem`,
 * `apikey.bin`), **not** in the per-integration store. Moving them buys
 * tidiness and risks the one value that cannot be re-derived — a private key
 * the venue has already been told about — and there is no backup routine yet
 * (roadmap L-3). New integrations use the new store from the start.
 */
export const REVOLUTX_AUTH: IntegrationAuthSpec = {
  integrationId: "revolutx",
  scheme: "ed25519_signed",
  legacyStorage: true,
  fields: [
    { key: "api_key", label: "API key", sensitive: true },
    { key: "private_key", label: "Ed25519 private key", sensitive: true },
  ],
};

export const REVOLUTX_CAPABILITIES: VenueCapabilities = {
  id: "revolutx",
  displayName: "Revolut X",
  auth: REVOLUTX_AUTH,
  /* Unverified against the live API — see the module note. S4-2 sets this. */
  venueSideProtectiveOrders: false,
  venueSideOco: false,
  dailyOrderLimit: 1000,
  /* No order placement exists yet (S4-1). */
  canPlaceOrders: false,
};

export const revolutXVenue: VenueReadPort = {
  capabilities: REVOLUTX_CAPABILITIES,

  async getBalances(): Promise<VenueBalance[]> {
    return revx.getBalances();
  },

  async getPairs(): Promise<Record<string, VenuePair>> {
    return revx.getPairsConfig();
  },

  async getTickers(symbols?: string[]): Promise<VenueTicker[]> {
    return revx.getTickers(symbols);
  },

  /** Reconciliation only. See the port's note — never chart from this. */
  async getCandlesForReconciliation(
    symbol: string,
    intervalMinutes: number,
    sinceMs?: number,
    untilMs?: number
  ): Promise<VenueCandle[]> {
    const rows = await revx.getCandles(symbol, intervalMinutes, sinceMs, untilMs);
    /* Mapped rather than passed through: the venue's `start` becomes the port's
       `startMs`. One explicit mapping now is cheaper than discovering that two
       shapes drifted apart after a venue changed a field name. */
    return rows.map((c) => ({
      startMs: c.start,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  },
};
