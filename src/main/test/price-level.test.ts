/**
 * `PriceLevel` thresholds (plan §17.6).
 *
 * The properties under test are the safety ones:
 *
 *   • numeric thresholds behave EXACTLY as before — every existing caller passes
 *     three arguments and must be unaffected;
 *   • an unresolvable level makes a condition false, never true;
 *   • a live, developing level cannot validate without a drift guard, because
 *     without one it is free to wander into a different trade than the one that
 *     was approved.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateConditionGroup,
  extractRequiredLevels,
  makeLevelKey,
  isPriceLevel,
  validateSpec,
  type ConditionGroup,
  type StrategySpec,
} from "../strategy/strategy-spec";
import { makeIndicatorKey } from "../insights/indicator-types";
import { describeThreshold, isDeveloping, isFrozen } from "../../shared/levels";
import type { DerivedLevel, PriceLevel } from "../../shared/levels";

const CLOSE = makeIndicatorKey("price", {}, "close");

function priceMaps(current: number, previous: number) {
  return {
    current: new Map<string, number | null>([[CLOSE, current]]),
    previous: new Map<string, number | null>([[CLOSE, previous]]),
  };
}

const vahLevel: DerivedLevel = {
  kind: "derived",
  source: "volume_profile",
  params: { binWidth: 10, valueAreaPct: 70, distribution: "uniform" },
  window: { from: 1_700_000_000_000, to: "developing" },
  field: "vah",
  resolve: "live",
  resolvedAtArm: 71_800,
  driftTolerance: { binChange: true },
  onDrift: "reconfirm",
};

function group(value: unknown, operator = "above"): ConditionGroup {
  return {
    logic: "and",
    conditions: [{ indicator: "price", params: {}, field: "close", operator: operator as any, value: value as any }],
  };
}

describe("Numeric thresholds are unchanged", () => {
  test("above / below still work with three arguments", () => {
    const { current, previous } = priceMaps(105, 100);
    assert.equal(evaluateConditionGroup(group(100), current, previous), true);
    assert.equal(evaluateConditionGroup(group(110), current, previous), false);
    assert.equal(evaluateConditionGroup(group(110, "below"), current, previous), true);
  });

  test("crosses_above and between still work", () => {
    const { current, previous } = priceMaps(105, 99);
    assert.equal(evaluateConditionGroup(group(100, "crosses_above"), current, previous), true);
    // No cross when the previous bar was already above.
    const already = priceMaps(105, 101);
    assert.equal(
      evaluateConditionGroup(group(100, "crosses_above"), already.current, already.previous),
      false
    );
    assert.equal(evaluateConditionGroup(group([100, 110], "between"), current, previous), true);
    assert.equal(evaluateConditionGroup(group([106, 110], "between"), current, previous), false);
  });
});

describe("PriceLevel thresholds", () => {
  test("a static level compares like the number it holds", () => {
    const { current, previous } = priceMaps(105, 100);
    const level: PriceLevel = { kind: "static", price: 100 };
    assert.equal(evaluateConditionGroup(group(level), current, previous), true);
    assert.equal(evaluateConditionGroup(group({ kind: "static", price: 110 }), current, previous), false);
  });

  test("a derived level resolves through the levels map", () => {
    const { current, previous } = priceMaps(72_000, 71_000);
    const levels = new Map<string, number | null>([[makeLevelKey(vahLevel), 71_800]]);

    assert.equal(evaluateConditionGroup(group(vahLevel), current, previous, levels), true);

    // Same condition, level now resolved higher than price: no trigger.
    const moved = new Map<string, number | null>([[makeLevelKey(vahLevel), 74_200]]);
    assert.equal(evaluateConditionGroup(group(vahLevel), current, previous, moved), false);
  });

  test("an unresolved level makes the condition FALSE, never true", () => {
    /* A level nobody could compute is exactly the value that must not quietly
       become a trigger. Empty map, missing key, and explicit null all agree. */
    const { current, previous } = priceMaps(72_000, 71_000);
    assert.equal(evaluateConditionGroup(group(vahLevel), current, previous), false);
    assert.equal(evaluateConditionGroup(group(vahLevel), current, previous, new Map()), false);
    assert.equal(
      evaluateConditionGroup(
        group(vahLevel),
        current,
        previous,
        new Map([[makeLevelKey(vahLevel), null]])
      ),
      false
    );
  });

  test("crosses_above works against a resolved level", () => {
    const levels = new Map<string, number | null>([[makeLevelKey(vahLevel), 71_800]]);
    const crossed = priceMaps(72_000, 71_500);
    assert.equal(
      evaluateConditionGroup(group(vahLevel, "crosses_above"), crossed.current, crossed.previous, levels),
      true
    );
    const alreadyAbove = priceMaps(72_000, 71_900);
    assert.equal(
      evaluateConditionGroup(group(vahLevel, "crosses_above"), alreadyAbove.current, alreadyAbove.previous, levels),
      false
    );
  });

  test("between accepts a mix of numbers and levels", () => {
    const val: DerivedLevel = { ...vahLevel, field: "val", resolvedAtArm: 69_000 };
    const levels = new Map<string, number | null>([
      [makeLevelKey(val), 69_500],
      [makeLevelKey(vahLevel), 71_800],
    ]);
    const inside = priceMaps(70_000, 69_800);
    assert.equal(
      evaluateConditionGroup(group([val, vahLevel], "between"), inside.current, inside.previous, levels),
      true
    );
    const outside = priceMaps(72_500, 71_900);
    assert.equal(
      evaluateConditionGroup(group([val, vahLevel], "between"), outside.current, outside.previous, levels),
      false
    );
    // One bound unresolvable ⇒ the whole comparison is unavailable ⇒ false.
    assert.equal(
      evaluateConditionGroup(
        group([val, vahLevel], "between"),
        inside.current,
        inside.previous,
        new Map([[makeLevelKey(vahLevel), 71_800]])
      ),
      false
    );
  });
});

describe("Level keys and extraction", () => {
  test("keys are stable and distinguish the field", () => {
    const val: DerivedLevel = { ...vahLevel, field: "val" };
    assert.equal(makeLevelKey(vahLevel), makeLevelKey({ ...vahLevel }));
    assert.notEqual(makeLevelKey(vahLevel), makeLevelKey(val));
  });

  test("keys do not depend on param insertion order", () => {
    const a: DerivedLevel = { ...vahLevel, params: { binWidth: 10, valueAreaPct: 70 } };
    const b: DerivedLevel = { ...vahLevel, params: { valueAreaPct: 70, binWidth: 10 } };
    assert.equal(makeLevelKey(a), makeLevelKey(b));
  });

  test("extractRequiredLevels finds levels in both plain and between thresholds, deduped", () => {
    const val: DerivedLevel = { ...vahLevel, field: "val" };
    const g: ConditionGroup = {
      logic: "or",
      conditions: [
        group(vahLevel).conditions[0]!,
        { logic: "and", conditions: [group([val, vahLevel], "between").conditions[0]!] },
        group(50).conditions[0]!,
      ],
    };
    const found = extractRequiredLevels(g);
    assert.equal(found.length, 2, "the repeated VAH reference must be deduped");
    assert.ok(found.some((l) => makeLevelKey(l) === makeLevelKey(vahLevel)));
    assert.ok(found.some((l) => makeLevelKey(l) === makeLevelKey(val)));
  });

  test("isPriceLevel does not mistake a number or an array for a level", () => {
    assert.equal(isPriceLevel(100), false);
    assert.equal(isPriceLevel([1, 2]), false);
    assert.equal(isPriceLevel(null), false);
    assert.equal(isPriceLevel(vahLevel), true);
  });
});

describe("Validation of level thresholds", () => {
  const baseSpec = (value: unknown): StrategySpec =>
    ({
      id: "level-spec",
      pair: "BTC-USD",
      type: "signal",
      entry: group(value),
      exit: group(999_999),
      sizing: { mode: "fixed_quote", amount: 100 },
      schedule: { eval_interval: "15m" },
      risk: { max_open_positions: 1, max_daily_trades: 3, stop_loss_pct: 2 },
    }) as unknown as StrategySpec;

  test("a well-formed derived level validates", () => {
    assert.deepEqual(validateSpec(baseSpec(vahLevel)), []);
  });

  test("a live developing level without a drift guard is refused", () => {
    const noGuard: DerivedLevel = { ...vahLevel, driftTolerance: {} };
    const errors = validateSpec(baseSpec(noGuard));
    assert.ok(
      errors.some((e) => e.includes("driftTolerance")),
      `expected a driftTolerance error, got: ${errors.join(" | ")}`
    );
  });

  test("a derived level without resolvedAtArm is refused", () => {
    const { resolvedAtArm, ...rest } = vahLevel;
    const errors = validateSpec(baseSpec(rest));
    assert.ok(
      errors.some((e) => e.includes("resolvedAtArm")),
      `expected a resolvedAtArm error, got: ${errors.join(" | ")}`
    );
  });

  test("a frozen level needs no drift guard — its window cannot change", () => {
    const frozen: DerivedLevel = {
      ...vahLevel,
      window: { from: 1_700_000_000_000, to: 1_700_600_000_000 },
      resolve: "snapshot_at_arm",
      driftTolerance: {},
    };
    assert.deepEqual(validateSpec(baseSpec(frozen)), []);
    assert.equal(isFrozen(frozen), true);
    assert.equal(isDeveloping(frozen), false);
    assert.equal(isDeveloping(vahLevel), true);
  });

  test("two derived bounds in a `between` are not order-checked", () => {
    /* Two developing levels can legitimately cross as the market moves;
       ordering them at authoring time would reject a valid band. */
    const val: DerivedLevel = { ...vahLevel, field: "val" };
    assert.deepEqual(validateSpec(baseSpec2([vahLevel, val])), []);
  });

  function baseSpec2(value: unknown): StrategySpec {
    const s = baseSpec(value) as unknown as { entry: ConditionGroup };
    s.entry = group(value, "between");
    return s as unknown as StrategySpec;
  }

  test("numeric bounds ARE still order-checked", () => {
    const errors = validateSpec(baseSpec2([110, 100]));
    assert.ok(errors.some((e) => e.includes("low must be less than high")));
  });
});

describe("Threshold display", () => {
  test("levels render as names, not [object Object]", () => {
    assert.equal(describeThreshold(vahLevel), "VAH (developing)");
    assert.equal(describeThreshold({ ...vahLevel, window: { from: 1, to: 2 } }), "VAH (fixed range)");
    assert.equal(describeThreshold(100), "100");
    assert.equal(describeThreshold([100, 110]), "100 – 110");
    assert.equal(describeThreshold(undefined), "—");
    assert.ok(!describeThreshold([vahLevel, 100]).includes("object"));
  });
});
