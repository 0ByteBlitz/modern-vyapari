/**
 * Which venue is active (roadmap S2-9).
 *
 * **Scope is swappable, not multi-venue.** One venue at a time, chosen
 * deliberately, resolved through this registry rather than imported by name.
 * Trading two venues at once stays deferred (ROADMAP §1) and would also
 * collide with the one-feed-per-purpose rule.
 *
 * ## Security
 *
 * Adapters are a **compile-time map**. There is no dynamic `require`, no
 * plugin directory and no path from configuration to code — a pluggable venue
 * that could load arbitrary code with vault access would be a credential
 * stealer with a config file.
 *
 * **Selecting the active venue is a privileged action**, in the same class as
 * the kill switch: it decides where real money goes. So:
 *
 *  • it is audit-logged;
 *  • it is refused while anything is armed or open, because switching venue
 *    underneath a live position would leave that position orphaned on a venue
 *    the app is no longer talking to;
 *  • **no agent tool may call it**, and no instruction found in web content, a
 *    fetched page or an MCP response may cause it. There is deliberately no
 *    `set_venue` tool, and there must never be one.
 */

import { auditLog } from "../../db/database";
import { createLogger } from "../../logger";
import { AppError } from "../../../shared/errors";
import type { VenueCapabilities, VenueReadPort } from "./port";
import { revolutXVenue } from "./revolutx";
import { paperVenue } from "./paper";
import { appMode } from "../../modes/app-mode";

const log = createLogger("venue");

/** Compile-time map. Adding a venue means editing this file, by design. */
const ADAPTERS: Record<string, VenueReadPort> = {
  [revolutXVenue.capabilities.id]: revolutXVenue,
  [paperVenue.capabilities.id]: paperVenue,
};

const DEFAULT_VENUE_ID = revolutXVenue.capabilities.id;

let activeId: string = DEFAULT_VENUE_ID;

/**
 * The active venue. Call sites use this instead of importing a client.
 *
 * **In simulated mode this returns the paper adapter unconditionally**, before
 * `activeId` is even consulted. That is the point of app modes: the guarantee
 * is not "the selected venue happens to be the paper one", it is that no other
 * adapter is reachable — so a stale selection, a settings bug, or a future call
 * site that forgets to check the mode cannot route a request at a real venue.
 * The mode is fixed for the life of the process (`modes/app-mode.ts`).
 */
export function venue(): VenueReadPort {
  if (appMode() === "simulated") return paperVenue;
  const adapter = ADAPTERS[activeId];
  if (!adapter) {
    /* Fail loudly rather than silently falling back: a wrong venue is a wrong
       set of balances, and quietly substituting one would be worse than an
       error the user can see. */
    throw new AppError(
      "NOT_IMPLEMENTED",
      `No venue adapter is registered for "${activeId}".`,
      { hint: "Choose a supported venue in Settings." }
    );
  }
  return adapter;
}

/** What the active venue can do. Callers branch on this, never on its id. */
/**
 * The real venue live mode would use — regardless of the current mode.
 *
 * Distinct from `venue()`, which in simulated mode is always the paper adapter.
 * Setup needs this one: in simulated mode connecting a venue is optional, but
 * the user is still choosing (and possibly connecting) the venue they would go
 * live on. Null if the configured id has no adapter.
 */
export function liveVenue(): VenueReadPort | null {
  return ADAPTERS[activeId] ?? null;
}

/**
 * Can this build place a real order on any venue? Decides whether live mode
 * can run at all (`resolveMode`). Mode-independent, so `main.ts` can ask before
 * the mode is locked.
 */
export function liveExecutionBuilt(): boolean {
  return Object.values(ADAPTERS).some((a) => a.capabilities.canPlaceOrders);
}

export function venueCapabilities(): VenueCapabilities {
  return venue().capabilities;
}

export function listVenues(): VenueCapabilities[] {
  /* Simulated mode offers no choice of venue, and showing a pickable list of
     real ones would imply the selection does something. */
  if (appMode() === "simulated") return [paperVenue.capabilities];
  return Object.values(ADAPTERS)
    .filter((a) => a.capabilities.id !== paperVenue.capabilities.id)
    .map((a) => a.capabilities);
}

export function activeVenueId(): string {
  /* Report what is actually serving requests, not what is stored. Anything
     else would put a "Revolut X" label on a screen whose numbers came from the
     paper adapter — an ambiguous state, which outranks every preference. */
  return appMode() === "simulated" ? paperVenue.capabilities.id : activeId;
}

export type VenueSwitchDecision = { ok: true; noop: boolean } | { ok: false; reason: string };

/**
 * Should this switch be allowed?
 *
 * Pure and exported **so it can be tested against every branch**. The registry
 * holds exactly one adapter today, so a test driving `setActiveVenue` cannot
 * reach the open-commitments guard — it is refused earlier as an unknown venue.
 * Adding a runtime registration hook to make that reachable would create the
 * one thing the security note forbids: a path from configuration to code.
 * Extracting the decision keeps the map compile-time and the rule covered.
 */
export function evaluateVenueSwitch(
  fromId: string,
  toId: string,
  isKnownVenue: boolean,
  hasOpenCommitments: boolean
): VenueSwitchDecision {
  if (!isKnownVenue) return { ok: false, reason: `Unknown venue "${toId}".` };
  if (toId === fromId) return { ok: true, noop: true };
  if (hasOpenCommitments) {
    return {
      ok: false,
      reason:
        "Close or invalidate everything open before switching venue. Switching underneath an " +
        "open position or an armed plan would strand it on a venue the app is no longer talking to.",
    };
  }
  return { ok: true, noop: false };
}

/**
 * Change the active venue.
 *
 * `hasOpenCommitments` is injected rather than read here so this module stays
 * free of engine imports — and so the caller, which knows about positions and
 * armed plans, owns the definition of "committed".
 */
export function setActiveVenue(
  id: string,
  opts: { hasOpenCommitments: () => boolean }
): { ok: true } | { ok: false; reason: string } {
  const decision = evaluateVenueSwitch(activeId, id, Boolean(ADAPTERS[id]), opts.hasOpenCommitments());
  if (!decision.ok) return decision;
  if (decision.noop) return { ok: true };

  const from = activeId;
  activeId = id;
  auditLog("venue_changed", { from, to: id });
  log.info(`Active venue changed: ${from} → ${id}`);
  return { ok: true };
}

/** Test seam. Not exported through IPC — see the security note above. */
export function setActiveVenueForTesting(id: string): void {
  activeId = id;
}
