/**
 * One switch for "this process may not talk to the network".
 *
 * Added because a unit test opened a live Binance WebSocket by accident: the
 * alert engine takes an internal subscription when an alert is created, and the
 * WS singleton connects on demand. The socket then outlived the test's database
 * and kept the Node process alive, so the suite appeared to hang forever.
 *
 * Tests are the obvious consumer, but the same gate is what an "offline mode"
 * would need later. Keeping it in one place means a new fetch path can be made
 * test-safe by asking one question instead of inventing its own flag.
 *
 * Deliberately *not* a mock or an interceptor: callers check it and degrade
 * honestly (return nothing, serve cache), which is the same behaviour they need
 * when the network is genuinely down.
 */

let disabled = process.env.VYAPARI_NO_NETWORK === "1";

/** True when outbound network calls must be skipped. */
export function isNetworkDisabled(): boolean {
  return disabled;
}

export function setNetworkDisabled(value: boolean): void {
  disabled = value;
}
