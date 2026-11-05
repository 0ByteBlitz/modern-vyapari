import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readLockSettings, shouldStartLocked, writeLockSettings } from "../security/app-lock";
import { cleanupTestDb, setupTestDb } from "./test-helper";

describe("app lock settings", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a fresh profile opens to onboarding without changing saved lock preferences", () => {
    const fresh = readLockSettings();
    assert.equal(fresh.lockAtLaunch, false);
    assert.equal(shouldStartLocked("available", fresh), false);

    const saved = writeLockSettings({ lockAtLaunch: true, lockWithWindows: false, idleMinutes: null });
    assert.deepEqual(saved, { lockAtLaunch: true, lockWithWindows: false, idleMinutes: null });
    assert.equal(readLockSettings().lockAtLaunch, true);
    assert.equal(shouldStartLocked("available", saved), true);
  });
});
