/**
 * The venue port and registry (roadmap S2-9).
 *
 * The tests worth having here are not "does the adapter call the client" —
 * that is a mock asserting a mock. They are the *rules* the layer exists to
 * enforce, each of which is a safety property:
 *
 *  • an unknown venue fails loudly rather than falling back to a default,
 *    because a silently substituted venue is a silently wrong set of balances;
 *  • the venue cannot be switched while something is open, because switching
 *    underneath a position strands it on a venue the app no longer talks to;
 *  • capabilities are honest about what is unverified — `canPlaceOrders` is
 *    false until Sprint 4, and `venueSideProtectiveOrders` is false until S4-2
 *    confirms it against the real API.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb } from "./test-helper";
import {
  venue,
  venueCapabilities,
  listVenues,
  activeVenueId,
  setActiveVenue,
  setActiveVenueForTesting,
  evaluateVenueSwitch,
} from "../integrations/venue/registry";
import { REVOLUTX_CAPABILITIES } from "../integrations/venue/revolutx";
import { __resetModeForTests } from "../modes/app-mode";

const never = () => false;
const always = () => true;

describe("venue registry", () => {
  beforeEach(() => {
    setupTestDb();
    /* These are the LIVE-mode rules. In simulated mode the registry returns the
       paper adapter before `activeId` is consulted at all, so none of the
       switching logic below is reachable — that guarantee has its own tests in
       `app-mode.test.ts`. */
    __resetModeForTests("live");
    setActiveVenueForTesting("revolutx");
  });
  afterEach(() => {
    setActiveVenueForTesting("revolutx");
    cleanupTestDb();
  });

  test("Revolut X is registered and active by default", () => {
    assert.equal(activeVenueId(), "revolutx");
    assert.equal(venueCapabilities().id, "revolutx");
    assert.equal(venueCapabilities().displayName, "Revolut X");
    assert.ok(listVenues().some((v) => v.id === "revolutx"));
  });

  test("an unknown active venue throws rather than falling back", () => {
    /* Falling back to "some venue" would mean showing one venue's balances
       under another's name. An error the user can see is strictly better. */
    setActiveVenueForTesting("does-not-exist");
    assert.throws(() => venue(), /No venue adapter is registered/);
  });

  test("switching to an unknown venue is refused", () => {
    const res = setActiveVenue("nope", { hasOpenCommitments: never });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /Unknown venue/);
    assert.equal(activeVenueId(), "revolutx", "a refused switch must not change the active venue");
  });

  test("switching is refused while anything is open", () => {
    /* Driven through the pure decision rather than setActiveVenue: only one
       adapter is registered, so a real call is refused as an unknown venue
       before it can reach this guard. Adding a runtime registration hook to
       make it reachable would be the config-to-code path the security note
       forbids. */
    const res = evaluateVenueSwitch("revolutx", "some-other-venue", true, true);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /Close or invalidate everything open/);
  });

  test("switching is allowed when nothing is open", () => {
    const res = evaluateVenueSwitch("revolutx", "some-other-venue", true, false);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.noop, false);
  });

  test("the unknown-venue check runs before the commitment guard", () => {
    const res = evaluateVenueSwitch("revolutx", "nope", false, false);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /Unknown venue/);
  });

  test("switching to the same venue is a no-op even with open commitments", () => {
    assert.equal(setActiveVenue("revolutx", { hasOpenCommitments: always }).ok, true);
    assert.equal(activeVenueId(), "revolutx");
  });
});

describe("capabilities are honest about what is unverified", () => {
  test("Revolut X declares it cannot place orders yet", () => {
    /* S4-1 has not been written. A capability claiming otherwise would be a
       control that does not control — the failure this project keeps finding. */
    assert.equal(REVOLUTX_CAPABILITIES.canPlaceOrders, false);
  });

  test("venue-side protective orders are declared false until verified", () => {
    /* The plan's hard rule is that every live position carries a venue-side
       stop. Claiming support before S4-2 confirms it against the real API
       would be exactly the kind of unearned confidence that gets a position
       left unprotected. */
    assert.equal(REVOLUTX_CAPABILITIES.venueSideProtectiveOrders, false);
  });

  test("the documented daily order cap is carried, not rediscovered by rejection", () => {
    assert.equal(REVOLUTX_CAPABILITIES.dailyOrderLimit, 1000);
  });
});
