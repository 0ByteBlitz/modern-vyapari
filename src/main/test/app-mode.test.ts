/**
 * Simulated and live are app modes (launch gate).
 *
 * Two of these are **binary launch-gate items**, not nice-to-haves:
 *
 *   • simulated mode cannot place an order;
 *   • the running mode is unambiguous.
 *
 * The first is tested as an *absence*, not a flag: the paper adapter has no
 * credentials, no HTTP client and no signing path, and the registry hands it
 * back before the configured venue id is even consulted. A test that only
 * asserted `canPlaceOrders === false` would pass just as happily against an
 * adapter that could place orders and lied about it.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb, cleanupTestDb } from "./test-helper";
import {
  appMode,
  databaseFileName,
  isAppMode,
  lockMode,
  readMode,
  writeMode,
  DEFAULT_MODE,
  __resetModeForTests,
} from "../modes/app-mode";
import { venue, venueCapabilities, listVenues, activeVenueId } from "../integrations/venue/registry";
import { paperVenue } from "../integrations/venue/paper";
import { replaceLessonsForPair, getLessonsForPair } from "../db/shared-store";

/* os.tmpdir(), never ".": with TEMP and TMPDIR unset (most Linux shells and CI
   runners) the old fallback wrote a scratch folder into the repo root on every
   run, untracked and never removed. */
const SCRATCH = tmpdir();

describe("simulated mode has no route to a real order", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("the registry returns the paper adapter, whatever venue is configured", () => {
    __resetModeForTests("simulated");
    /* Not "the selected venue happens to be paper" — no other adapter is
       reachable. A stale selection or a settings bug cannot route a request at
       a real venue. */
    assert.equal(venue(), paperVenue);
    assert.equal(activeVenueId(), "simulated");
    assert.equal(venueCapabilities().canPlaceOrders, false);
  });

  test("no venue other than the paper one is even offered", () => {
    __resetModeForTests("simulated");
    const ids = listVenues().map((v) => v.id);
    /* Listing real venues would imply the selection does something. */
    assert.deepEqual(ids, ["simulated"]);
  });

  test("the paper adapter imports nothing that could sign a request", () => {
    /* The guarantee is structural, so the test reads the source — a flag can be
       flipped by a careless edit, whereas importing the venue client has to be
       done deliberately, and this fails the moment it is.
       Only the IMPORT lines are scanned: the module's own doc comment names
       `revx/client` while explaining that it does not import it, and a naive
       whole-file substring match failed on that. Checking what the file
       actually pulls in is both narrower and closer to the real property. */
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "src", "main", "integrations", "venue", "paper.ts"),
      "utf8"
    );
    const imports = src.split(/\r?\n/).filter((l) => l.trimStart().startsWith("import"));
    for (const forbidden of ["revx/", "credentials", "https", "node:http"]) {
      assert.ok(
        !imports.some((l) => l.includes(forbidden)),
        `paper adapter must not import ${forbidden}`
      );
    }
    /* And it must declare the capability honestly. */
    assert.equal(paperVenue.capabilities.canPlaceOrders, false);
  });

  test("its reads are empty, never invented", async () => {
    __resetModeForTests("simulated");
    /* Empty is the honest answer: there is no account. A fabricated balance
       would flow into position sizing, which is this project's recurring
       defect wearing a new hat. */
    assert.deepEqual(await venue().getBalances(), []);
    assert.deepEqual(await venue().getPairs(), {});
    assert.deepEqual(await venue().getTickers(), []);
  });

  test("live mode resolves the real adapter again", () => {
    __resetModeForTests("live");
    assert.notEqual(venue(), paperVenue);
    assert.equal(activeVenueId(), "revolutx");
  });
});

describe("the mode is unambiguous and safe by default", () => {
  test("simulated is the default", () => {
    assert.equal(DEFAULT_MODE, "simulated");
  });

  test("an unreadable or unknown mode file resolves to simulated", () => {
    /* The only safe direction. A corrupt config must never be the reason the
       app comes up pointed at real money. */
    assert.equal(readMode(join(SCRATCH, "definitely-not-a-real-dir-xyz")), "simulated");
    assert.equal(isAppMode("live_auto"), false);
    assert.equal(isAppMode("live"), true);
  });

  test("a written mode round-trips", () => {
    const dir = mkdtempSync(join(SCRATCH, "vyapari-mode-"));
    try {
      writeMode(dir, "live");
      assert.equal(readMode(dir), "live");
      writeMode(dir, "simulated");
      assert.equal(readMode(dir), "simulated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the mode cannot be changed once the process has locked it", () => {
    __resetModeForTests();
    lockMode("simulated");
    /* Swapping mode underneath a running monitor would mean the database, the
       engine and the cached rows disagree about which world they are in. */
    assert.throws(() => lockMode("live"), /requires a restart/);
    assert.equal(appMode(), "simulated");
    __resetModeForTests();
  });
});

describe("the two modes cannot share a database file", () => {
  test("each mode names a different file", () => {
    assert.notEqual(databaseFileName("simulated"), databaseFileName("live"));
  });

  test("the historic file belongs to simulated", () => {
    /* Live execution has never run — every row in `mybot.db` is paper. Naming
       it the live file would label simulated fills as real AND hide the
       owner's actual history from the default mode. */
    assert.equal(databaseFileName("simulated"), "mybot.db");
    assert.equal(databaseFileName("live"), "mybot-live.db");
  });
});

describe("lessons cross modes; nothing else does", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("a lesson written in one mode is readable in the other", () => {
    __resetModeForTests("simulated");
    replaceLessonsForPair("ARB-USD", ["The 0.40 shelf absorbs, seen in 3 of 4 approaches."], "simulated");

    __resetModeForTests("live");
    const seen = getLessonsForPair("ARB-USD");
    /* Market knowledge transfers. Starting live with an empty memory would
       discard everything simulation taught. */
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.origin, "simulated", "and its origin is recorded, not hidden");
  });

  test("distillation replaces rather than appends", () => {
    replaceLessonsForPair("ARB-USD", ["first", "second"], "simulated");
    replaceLessonsForPair("ARB-USD", ["revised"], "simulated");
    /* Each pass returns the WHOLE set — it merges duplicates and drops what
       newer evidence contradicts. Appending would resurrect a lesson the model
       had just decided was wrong. */
    assert.deepEqual(getLessonsForPair("ARB-USD").map((l) => l.content), ["revised"]);
  });

  test("lessons are keyed by pair, not by session", () => {
    replaceLessonsForPair("ARB-USD", ["arb lesson"], "simulated");
    replaceLessonsForPair("BTC-USD", ["btc lesson"], "simulated");
    assert.deepEqual(getLessonsForPair("BTC-USD").map((l) => l.content), ["btc lesson"]);
  });
});
