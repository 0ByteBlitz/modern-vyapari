/**
 * The simulated-mode venue.
 *
 * ## What this adapter is for
 *
 * It is the structural half of app modes. In simulated mode the registry hands
 * back *this* — an adapter with **no credentials, no HTTP client, no signing
 * path, and no import of `revx/client`**. `canPlaceOrders` is `false`, and it
 * is false because there is nothing here that could place an order, not because
 * a flag says so. That is the same class of guarantee as `PlanState` having no
 * `live_auto` member: an absence rather than a defence.
 *
 * A reviewer should be able to confirm the property by reading the imports.
 *
 * ## Why it answers reads at all, instead of throwing
 *
 * Simulated mode has to be *usable*, or the owner will run live to get their
 * work done and the safety property evaporates. So the read methods return
 * empty results rather than errors: the portfolio shows no venue holdings, the
 * pair list is empty, tickers are empty.
 *
 * **Empty is not zero, and the difference matters here.** These are honest
 * absences — in simulated mode there genuinely are no venue balances, because
 * there is no account. What the app must never do is *invent* a plausible
 * balance to make the screen look complete; a fabricated number that flows into
 * position sizing is precisely this project's recurring defect. Paper cash
 * lives in `sessions.paper_balance` where it always has, and the analysis feed
 * supplies every price the engine actually trades on — neither comes from here.
 *
 * ## What it is not
 *
 * Not a mock venue and not a simulator. The fill model lives in
 * `paper/paper-exchange.ts`, shared with the backtester, and it reads the
 * analysis feed. Adding a second source of simulated prices here would be a
 * second fill model, which is the one thing §17 forbids outright.
 */

import type { IntegrationAuthSpec } from "../../security/integration-secrets";
import type {
  VenueBalance,
  VenueCandle,
  VenueCapabilities,
  VenuePair,
  VenueReadPort,
  VenueTicker,
} from "./port";

/** No fields, because there is nothing to authenticate against. Settings
 *  renders no credential form for simulated mode as a result. */
export const PAPER_AUTH: IntegrationAuthSpec = {
  integrationId: "simulated",
  scheme: "none",
  fields: [],
};

export const PAPER_CAPABILITIES: VenueCapabilities = {
  id: "simulated",
  displayName: "Simulated (no venue)",
  auth: PAPER_AUTH,
  /* Both false and both honest: there is no venue to rest an order on. The
     order path refuses this adapter loudly rather than discovering the gap at
     submit time. */
  venueSideProtectiveOrders: false,
  venueSideOco: false,
  dailyOrderLimit: null,
  /* The launch gate's binary check. Nothing in this file could make it true. */
  canPlaceOrders: false,
};

export const paperVenue: VenueReadPort = {
  capabilities: PAPER_CAPABILITIES,

  /* No account exists, so there are no balances. Deliberately not a synthetic
     figure — see the module note. */
  async getBalances(): Promise<VenueBalance[]> {
    return [];
  },

  /* Pair *rules* (tick size, minimums, tradable status) are venue facts and
     this mode has no venue. Sessions are created against the analysis feed's
     symbols, which is what plans resolve and the engine trades. */
  async getPairs(): Promise<Record<string, VenuePair>> {
    return {};
  },

  async getTickers(): Promise<VenueTicker[]> {
    return [];
  },

  /* Reconciliation compares local state against a venue. There is nothing to
     reconcile against, and returning fabricated bars here would put invented
     prices one careless call away from a chart — the exact mixing rule the
     feed-roles decision exists to prevent. */
  async getCandlesForReconciliation(): Promise<VenueCandle[]> {
    return [];
  },
};
