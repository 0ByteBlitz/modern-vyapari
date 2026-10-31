/**
 * The price and volume a condition sees on one bar.
 *
 * **Extracted so there is exactly one of these.** The paper engine, the plan
 * monitor and the structural dry run (S3-5) all have to build the same maps
 * from the same bars, because a dry run that judged a plan against slightly
 * different keys would answer a question about a plan that does not exist.
 *
 * The `field`-qualified key is not cosmetic: `evaluateCondition` looks up
 * `makeIndicatorKey(indicator, params, field)`, and an unqualified price
 * condition builds `price:` — which matches nothing and reads **false for
 * ever** while the plan displays as armed. That defect shipped once already.
 */
import { makeIndicatorKey } from "./indicator-types";
import type { CandleNumeric } from "./indicator-types";

export interface BarValues {
  current: Map<string, number | null>;
  previous: Map<string, number | null>;
}

/**
 * Values for bar `idx` (default: the last), with `previous` being `idx - 1`.
 *
 * Returns empty maps when there is no preceding bar. Every `crosses_above` /
 * `crosses_below` condition compares the two, so a caller with one bar has
 * nothing to say rather than a bar that appears to cross nothing.
 */
export function barValues(bars: CandleNumeric[], idx = bars.length - 1): BarValues {
  const current = new Map<string, number | null>();
  const previous = new Map<string, number | null>();
  const c = bars[idx];
  const p = bars[idx - 1];
  if (!c || !p) return { current, previous };

  for (const field of ["open", "high", "low", "close"] as const) {
    const k = makeIndicatorKey("price", {}, field);
    current.set(k, c[field]);
    previous.set(k, p[field]);
  }
  const volKey = makeIndicatorKey("volume", {});
  current.set(volKey, c.volume);
  previous.set(volKey, p.volume);
  return { current, previous };
}
