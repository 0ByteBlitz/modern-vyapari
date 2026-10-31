/**
 * The monitor says when it was NOT watching.
 *
 * An armed plan is only evaluated while this process runs, and an unwatched
 * window is otherwise indistinguishable from "price never came". S3-6's
 * calibration record measures trigger rate, so counting a gap as a non-trigger
 * corrupts the owner's own hit rate in the flattering direction, with nothing
 * that would notice. These pin the gap being detectable and, just as
 * importantly, NOT being invented.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb } from "./test-helper";
import {
  beat,
  lastBeat,
  gapSinceLastRun,
  describeGap,
  GAP_THRESHOLD_MS,
} from "../paper/monitor-heartbeat";

const T0 = 1_785_000_000_000;

describe("monitor heartbeat", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a first-ever run reports no gap", () => {
    /* Nothing was ever promised, so there is nothing to have missed. Claiming
       a gap "since the beginning of time" would be noise on a fresh install. */
    assert.equal(lastBeat(), null);
    assert.equal(gapSinceLastRun(T0), null);
  });

  test("a beat is readable back", () => {
    beat(T0);
    assert.equal(lastBeat(), T0);
  });

  test("ordinary jitter is not a gap", () => {
    beat(T0);
    /* One missed beat is a busy event loop, not an outage. Reporting it would
       train the owner to ignore the message that matters. */
    assert.equal(gapSinceLastRun(T0 + GAP_THRESHOLD_MS - 1), null);
  });

  test("a real outage is reported with its window", () => {
    beat(T0);
    const gap = gapSinceLastRun(T0 + 6 * 3_600_000);
    assert.ok(gap, "six hours down must be reported");
    assert.equal(gap.from, T0);
    assert.equal(gap.ms, 6 * 3_600_000);
  });

  test("the duration reads in units a person uses", () => {
    assert.match(describeGap({ from: 0, to: 0, ms: 30 * 60_000 }), /30 minutes/);
    assert.match(describeGap({ from: 0, to: 0, ms: 6 * 3_600_000 }), /hours/);
    assert.match(describeGap({ from: 0, to: 0, ms: 5 * 86_400_000 }), /days/);
  });

  test("a later beat replaces the earlier one", () => {
    beat(T0);
    beat(T0 + 60_000);
    assert.equal(lastBeat(), T0 + 60_000);
    /* And the gap is measured from the LAST beat, not the first — otherwise a
       long-running session would report an outage it never had. */
    assert.equal(gapSinceLastRun(T0 + 60_000 + 1000), null);
  });
});
