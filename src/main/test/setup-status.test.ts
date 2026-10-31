/**
 * Setup completeness is not tied to one venue.
 *
 * Onboarding used to require Revolut X's keypair and API key before anything
 * else, even though simulated mode trades on the paper adapter and needs no
 * exchange account — so anyone without that one exchange could not try the app.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isSetupComplete } from "../ipc/setup";
import { paperVenue } from "../integrations/venue/paper";

describe("setup completeness", () => {
  test("simulated mode needs only an AI provider", () => {
    assert.equal(isSetupComplete({ configured: true }, { required: false, configured: false }), true);
  });

  test("live mode also needs its venue", () => {
    assert.equal(isSetupComplete({ configured: true }, { required: true, configured: false }), false);
    assert.equal(isSetupComplete({ configured: true }, { required: true, configured: true }), true);
  });

  test("no mode is usable without an AI provider", () => {
    assert.equal(isSetupComplete({ configured: false }, { required: false, configured: true }), false);
    assert.equal(isSetupComplete({ configured: false }, { required: true, configured: true }), false);
  });

  test("the paper venue is configured by definition — there is no account", () => {
    assert.equal(paperVenue.isConfigured(), true);
  });
});
