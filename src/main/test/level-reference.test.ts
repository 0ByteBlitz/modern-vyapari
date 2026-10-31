/**
 * Promote drawing → plan reference (roadmap S2-2).
 *
 * Two things are under test, and the second matters more than the first:
 *
 *  1. The mapping — a horizontal line means "this price", a rectangle means
 *     "this window", and everything else is **refused with a reason**. The
 *     refusals are the substance: a drawing that cannot become a resolvable
 *     level must not become a plausible-looking one, because a plan armed
 *     against an unresolvable level evaluates false forever while looking armed.
 *
 *  2. Erasing the ink must not erase the meaning. A reference outlives the
 *     drawing it came from, because a plan may already be armed against it.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, cleanupTestDb } from "./test-helper";
import { getDb } from "../db/database";
import { saveDrawing, deleteDrawing } from "../db/queries";
import { drawingToLevel, isPromotable } from "../plans/level-reference";
import {
  promoteDrawingToReference,
  listLevelReferences,
  detachDrawing,
  saveLevelReference,
} from "../plans/level-reference-service";

const T0 = 1_785_000_000_000;
const DAY = 86_400_000;

describe("drawing → level mapping", () => {
  test("a horizontal line becomes a static level at its price", () => {
    const res = drawingToLevel({
      kind: "horizontalStraightLine",
      points: [{ timestamp: T0, value: 72_000 }],
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.level, { kind: "static", price: 72_000 });
  });

  test("every horizontal variant maps the same way", () => {
    for (const kind of ["horizontalRayLine", "horizontalSegment", "priceLine", "simpleTag"]) {
      const res = drawingToLevel({ kind, points: [{ timestamp: T0, value: 5 }] });
      assert.equal(res.ok, true, `${kind} should promote`);
    }
  });

  test("a rectangle becomes a FIXED-RANGE profile — a closed window, so nothing drifts", () => {
    const res = drawingToLevel(
      {
        kind: "rect",
        points: [
          { timestamp: T0, value: 70_000 },
          { timestamp: T0 - 5 * DAY, value: 74_000 },
        ],
      },
      { binWidth: 50 }
    );
    assert.equal(res.ok, true);
    if (!res.ok || res.level.kind !== "derived") return assert.fail("expected a derived level");
    assert.equal(res.level.source, "volume_profile");
    assert.equal(res.level.field, "poc");
    // Corners may be drawn in either order; the window must come out ordered.
    assert.equal(res.level.window.from, T0 - 5 * DAY);
    assert.equal(res.level.window.to, T0);
    assert.notEqual(res.level.window.to, "developing");
  });

  test("a rectangle without an explicit bin width is REFUSED", () => {
    /* Never an automatic bin width: it changes as history grows, so the level
       would move for a reason that has nothing to do with the market. */
    const res = drawingToLevel({
      kind: "rect",
      points: [
        { timestamp: T0 - DAY, value: 1 },
        { timestamp: T0, value: 2 },
      ],
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /bin width/i);
  });

  test("a promoted level never carries a fabricated resolvedAtArm", () => {
    /* There is no "value at arm" before arming. A placeholder here would be a
       made-up number in the field every drift check measures against. */
    const res = drawingToLevel(
      { kind: "rect", points: [{ timestamp: T0 - DAY, value: 1 }, { timestamp: T0, value: 2 }] },
      { binWidth: 10 }
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(Object.prototype.hasOwnProperty.call(res.level, "resolvedAtArm"), false);
  });
});

/* The regexes pin the *distinction* each refusal draws, not its exact
   wording — a sloping line is refused for a different reason than a fib, and
   collapsing the two into one generic "can't promote that" would be the real
   regression. Copy was simplified on 2026-08-01; these moved with it. */
describe("refusals, each for its own reason", () => {
  const cases: Array<[string, RegExp]> = [
    ["segment", /sloping line/i],
    ["straightLine", /sloping line/i],
    ["priceChannelLine", /sloping line/i],
    ["fibonacciLine", /fibonacci/i],
    ["gannBox", /fibonacci/i],
    ["fiveWaves", /wave counts/i],
    ["xabcd", /wave counts/i],
    ["positionTool", /no price to track/i],
    ["measureTool", /no price to track/i],
  ];

  for (const [kind, expected] of cases) {
    test(`${kind} is refused`, () => {
      const res = drawingToLevel({
        kind,
        points: [
          { timestamp: T0, value: 1 },
          { timestamp: T0 + DAY, value: 2 },
        ],
      });
      assert.equal(res.ok, false, `${kind} must not promote`);
      if (res.ok) return;
      assert.match(res.reason, expected);
    });
  }

  test("an unknown kind is refused rather than guessed at", () => {
    const res = drawingToLevel({ kind: "someFutureTool", points: [{ timestamp: T0, value: 1 }] });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /can't be turned into a level/i);
  });

  test("a drawing with no points is refused", () => {
    const res = drawingToLevel({ kind: "horizontalStraightLine", points: [] });
    assert.equal(res.ok, false);
  });

  test("isPromotable agrees with drawingToLevel", () => {
    assert.equal(isPromotable("priceLine"), true);
    assert.equal(isPromotable("rect"), true);
    assert.equal(isPromotable("fibonacciLine"), false);
    assert.equal(isPromotable("segment"), false);
  });
});

describe("persistence", () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  test("promoting a saved drawing stores a reference pointing back at it", () => {
    const d = saveDrawing({
      symbol: "BTC-USD",
      intervalMin: null,
      kind: "horizontalStraightLine",
      points: [{ timestamp: T0, value: 72_000 }],
    });

    const res = promoteDrawingToReference(d.id, { label: "range high" });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.reference.drawing_id, d.id);
    assert.equal(res.reference.label, "range high");
    assert.deepEqual(res.reference.level, { kind: "static", price: 72_000 });

    const listed = listLevelReferences("BTC-USD");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, res.reference.id);
  });

  test("a refused promotion stores nothing", () => {
    const d = saveDrawing({
      symbol: "BTC-USD",
      intervalMin: 240,
      kind: "fibonacciLine",
      points: [
        { timestamp: T0, value: 1 },
        { timestamp: T0 + DAY, value: 2 },
      ],
    });
    const res = promoteDrawingToReference(d.id);
    assert.equal(res.ok, false);
    assert.equal(listLevelReferences("BTC-USD").length, 0);
  });

  test("deleting the drawing does NOT delete the reference — the ink goes, the meaning stays", () => {
    const d = saveDrawing({
      symbol: "ETH-USD",
      intervalMin: null,
      kind: "priceLine",
      points: [{ timestamp: T0, value: 3_000 }],
    });
    const res = promoteDrawingToReference(d.id);
    assert.equal(res.ok, true);

    detachDrawing(d.id);
    deleteDrawing(d.id);

    const listed = listLevelReferences("ETH-USD");
    assert.equal(listed.length, 1, "the reference must survive its drawing");
    assert.equal(listed[0]?.drawing_id, null, "and must no longer point at a row that is gone");
    assert.deepEqual(listed[0]?.level, { kind: "static", price: 3_000 });
  });

  test("a NULL interval reference is returned on every timeframe", () => {
    saveLevelReference({
      symbol: "SOL-USD",
      intervalMin: null,
      label: "weekly high",
      level: { kind: "static", price: 200 },
    });
    saveLevelReference({
      symbol: "SOL-USD",
      intervalMin: 240,
      label: "4h only",
      level: { kind: "static", price: 190 },
    });

    assert.equal(listLevelReferences("SOL-USD", 240).length, 2);
    assert.equal(listLevelReferences("SOL-USD", 60).length, 1);
  });

  test("promoting a drawing that no longer exists is refused, not crashed", () => {
    const res = promoteDrawingToReference(9999);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /no longer exists/i);
  });

  test("level_references survives a fresh schema build", () => {
    const tables = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='level_references'`)
      .all();
    assert.equal(tables.length, 1);
  });
});
