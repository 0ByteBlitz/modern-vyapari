import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { backgroundScheduler } from "../services/scheduler";
import { alertEngine } from "../insights/alert-engine";
import { setupTestDb, cleanupTestDb, createTestSession } from "./test-helper";

describe("Background Job Scheduler Suite", () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    cleanupTestDb();
    backgroundScheduler.stop();
  });

  test("Background scheduler starts and stops cleanly without errors", () => {
    backgroundScheduler.start();
    backgroundScheduler.stop();
    assert.equal(true, true);
  });

  test("Background scheduler missed alert watchdog executes check across active rules", async () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    alertEngine.addAlert(
      { indicator: "price", params: {}, field: "close", operator: "above", value: 70000 },
      "BTC Target Alert",
      "BTC-USD",
      15,
      session.id
    );

    const checked = await backgroundScheduler.runMissedAlertCheck();
    assert.ok(checked >= 1, `Should have checked at least 1 alert rule target, got ${checked}`);
  });

  test("Background scheduler records hourly equity snapshots for active sessions", () => {
    const session = createTestSession("BTC-USD", "active", "10000.00");
    backgroundScheduler.takeEquitySnapshot();

    const db = require("../db/database").getDb();
    const snapshots = db
      .prepare(`SELECT * FROM journal WHERE session_id = ? AND tags LIKE '%equity,snapshot%'`)
      .all(session.id) as any[];

    assert.equal(snapshots.length, 1);
    assert.ok(snapshots[0].content.includes("Hourly Equity Snapshot"));
  });
});
