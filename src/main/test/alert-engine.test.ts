import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { alertEngine } from "../insights/alert-engine";
import { setupTestDb, cleanupTestDb, createTestSession } from "./test-helper";
import { getDb } from "../db/database";
import type { CandleNumeric } from "../insights/indicator-types";

describe("Alert Engine & Offline Backfill Catch-up Suite", () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    cleanupTestDb();
  });

  test("Offline candle backfill triggers active alert when threshold crossed while offline", () => {
    const session = createTestSession("ARB-USD", "active", "10000.00");

    // Add price_above alert for ARB-USD @ 0.0782
    const alert = alertEngine.addAlert(
      {
        indicator: "price",
        params: {},
        field: "close",
        operator: "above",
        value: 0.0782,
      },
      "ARB Breakout Alert",
      "ARB-USD",
      15,
      session.id
    );

    assert.equal(alert.status, "active");

    /* The alert must PREDATE the candles, which is what "while offline" means:
       the alert was created, the app was closed, and the bars accumulated after
       it. Backdating it here also exercises the reload path, since a real
       restart rebuilds `activeAlerts` from the DB.

       This previously created the alert at `now` and fed it bars from an hour
       earlier — which the engine correctly ignores. An alert created today must
       not fire on last week's history; it would trigger the instant you made it
       and tell you nothing about the present. */
    const baseTime = Date.now() - 3600000;
    getDb().prepare("UPDATE alerts SET created_at = ? WHERE id = ?").run(baseTime - 60_000, alert.id);
    alertEngine.loadFromDb();

    const historicalCandles: CandleNumeric[] = [
      { timestamp: baseTime, open: 0.0750, high: 0.0760, low: 0.0745, close: 0.0755, volume: 100 },
      { timestamp: baseTime + 900000, open: 0.0755, high: 0.0790, low: 0.0750, close: 0.0785, volume: 200 }, // Crossed 0.0782!
    ];

    // Evaluate offline synced candles
    alertEngine.evaluateHistoricalCandles("ARB-USD", 15, historicalCandles);

    // Verify alert updated to triggered in DB and returned in listAlerts query
    const alerts = alertEngine.getSessionAlerts(session.id);
    assert.equal(alerts.length, 1);
    const updated = alerts[0]!;
    assert.equal(updated.status, "triggered");
    assert.ok(updated.triggered_at);
  });

  test("a freshly created alert does NOT fire on history that predates it", () => {
    /* The other half of the contract. Without this guard an alert would trigger
       the moment you created it, on a move that already happened — reporting the
       past as if it were news. */
    const session = createTestSession("ARB-USD", "active", "10000.00");

    alertEngine.addAlert(
      { indicator: "price", params: {}, field: "close", operator: "above", value: 0.0782 },
      "ARB Breakout Alert",
      "ARB-USD",
      15,
      session.id
    );

    const baseTime = Date.now() - 3600000;
    alertEngine.evaluateHistoricalCandles("ARB-USD", 15, [
      { timestamp: baseTime, open: 0.075, high: 0.076, low: 0.0745, close: 0.0755, volume: 100 },
      { timestamp: baseTime + 900000, open: 0.0755, high: 0.079, low: 0.075, close: 0.0785, volume: 200 },
    ]);

    const alerts = alertEngine.getSessionAlerts(session.id);
    assert.equal(alerts[0]!.status, "active", "must still be waiting, not triggered by old bars");
  });
});
