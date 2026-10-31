/**
 * Authored intent → evaluable condition (roadmap S2-8).
 *
 * The renderer used to build `ConditionGroup` JSON itself. The risk was not
 * only coupling: a caller that got the shape slightly wrong produced a group
 * the engine would happily store and then evaluate as *nothing*. So the
 * property that matters here is the **refusal** — a malformed intent must come
 * back with a reason, never as an empty group.
 *
 * Why an empty group is the dangerous outcome: `validatePlan` reads an empty
 * invalidation as a *missing* one, so a silently-dropped condition surfaces as
 * "this plan has no thesis invalidation" three steps away from the mistake.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compileIntent, describeIntent, type ConditionIntent } from "../plans/condition-intent";
import type { PriceLevel } from "../../shared/levels";

const intent = (over: Partial<ConditionIntent> = {}): ConditionIntent => ({
  subject: "price",
  operator: "crosses_above",
  value: 72_000,
  ...over,
});

describe("compiling", () => {
  test("a price intent becomes a single-condition AND group", () => {
    const res = compileIntent(intent());
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.group, {
      logic: "and",
      conditions: [
        { indicator: "price", params: {}, field: "close", operator: "crosses_above", value: 72_000 },
      ],
    });
  });

  test("the price field is always qualified, or the condition can never be true", () => {
    /* `evaluateCondition` keys on makeIndicatorKey(indicator, params, field),
       and the engine only publishes field-qualified price keys. An unqualified
       condition builds `price:`, matches nothing, and reads false for ever
       while the plan displays as armed. Found on 2026-08-01 when the monitor
       was first wired to real bars. */
    for (const operator of ["above", "below", "crosses_above", "crosses_below"] as const) {
      const res = compileIntent(intent({ operator }));
      assert.equal(res.ok, true);
      if (!res.ok) return;
      const c = res.group.conditions[0];
      assert.ok(c && !("logic" in c), "expected a condition, not a nested group");
      assert.equal(c.field, "close", operator);
    }
  });

  test("every supported operator compiles", () => {
    for (const operator of ["above", "below", "crosses_above", "crosses_below"] as const) {
      assert.equal(compileIntent(intent({ operator })).ok, true, operator);
    }
  });

  test("a PriceLevel value passes through untouched", () => {
    /* A plan authored against a promoted reference — the renderer never needs
       to know what a reference is structurally. */
    const level: PriceLevel = { kind: "static", price: 71_800 };
    const res = compileIntent(intent({ value: level }));
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.group.conditions[0], {
      indicator: "price",
      params: {},
      field: "close",
      operator: "crosses_above",
      value: level,
    });
  });
});

describe("refusals — never an empty group", () => {
  test("a missing intent is refused", () => {
    for (const bad of [null, undefined]) {
      const res = compileIntent(bad);
      assert.equal(res.ok, false, String(bad));
    }
  });

  test("a blank or non-numeric value is refused, not coerced", () => {
    /* The realistic case: the user left the price field empty, so the renderer
       sent Number("") — NaN. Storing that as a condition would give a plan
       that can never trigger while looking armed. */
    for (const value of [Number.NaN, Infinity, "72000" as unknown as number, null as unknown as number]) {
      const res = compileIntent(intent({ value }));
      assert.equal(res.ok, false, String(value));
      if (res.ok) continue;
      assert.match(res.reason, /price or a level/i);
    }
  });

  test("an unsupported operator is refused", () => {
    const res = compileIntent(intent({ operator: "between" as never }));
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /Unsupported operator/);
  });

  test("an unsupported subject is refused", () => {
    const res = compileIntent(intent({ subject: "rsi" as never }));
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /Unsupported condition subject/);
  });

  test("a refusal never carries a group", () => {
    const res = compileIntent(intent({ value: Number.NaN }));
    assert.equal("group" in res, false, "a caller must not be able to store a partial result");
  });
});

describe("describeIntent", () => {
  test("reads as English for each operator", () => {
    assert.equal(describeIntent(intent({ operator: "crosses_above" })), "price crosses above 72000");
    assert.equal(describeIntent(intent({ operator: "below", value: 66_000 })), "price is below 66000");
  });

  test("a level is described as one, not stringified", () => {
    const level: PriceLevel = { kind: "static", price: 1 };
    assert.match(describeIntent(intent({ value: level })), /a level$/);
  });
});
