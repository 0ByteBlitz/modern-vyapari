/**
 * One typed listener registry, replacing four hand-rolled copies (roadmap
 * S2-7a): `binance-ws` candle listeners, `alert-engine` triggers,
 * `paper-exchange` position closes, and `kill-switch` state changes.
 *
 * **This is deduplication, not re-architecture.** Each of those four wrote the
 * same twelve lines — an array, a push, a filter to unsubscribe, and a loop
 * with a try/catch — and each got the error handling subtly its own way. One
 * implementation means one place to get it right.
 *
 * **The rule that constrains what may use this** (roadmap S2-7, non-negotiable):
 * a registry carries *notifications of things that have already happened*. It
 * must never carry a step in a sequence that decides money. There is no
 * ordering guarantee between listeners, so anything order-dependent — the paper
 * engine's protective-levels-then-signals sequence, the risk gates before an
 * entry — stays a direct call. A plan monitor and the paper engine racing on
 * the same candle could otherwise open a position while caps were still being
 * checked.
 *
 * A previous attempt at a general event bus was deleted on 2026-07-29 for
 * failing exactly this: it sat beside the direct wiring rather than replacing
 * it, logged every payload at debug on a per-second path, and its event map
 * carried `order:intent` / `order:executed`. This deliberately has no central
 * map, no payload logging, and no `once`/`waitFor` — the last of which is how a
 * bus starts being used for sequencing.
 */

import { createLogger } from "../logger";

const log = createLogger("events");

export type Listener<Args extends unknown[]> = (...args: Args) => void;

export class ListenerRegistry<Args extends unknown[]> {
  private listeners: Array<Listener<Args>> = [];

  /** `label` appears in the log when a listener throws, so a broken consumer
   *  is identifiable without a stack trace that only names this file. */
  constructor(private readonly label: string) {}

  /** Subscribe. Returns the unsubscribe function — the same contract all four
   *  original registries had, so call sites are unchanged. */
  add(cb: Listener<Args>): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  /** Drop every listener. Used on shutdown and on test teardown. */
  clear(): void {
    this.listeners = [];
  }

  get size(): number {
    return this.listeners.length;
  }

  /**
   * Notify everyone.
   *
   * Two properties. All four originals already had the first — each with its
   * own try/catch and its own wording of the log line — which is precisely the
   * argument for one implementation rather than four:
   *
   *  • **A throwing listener never stops the others, or the caller.** These are
   *    notifications; a broken review agent must not be able to halt the engine
   *    that trades. The error is logged and iteration continues.
   *  • **Iteration is over a snapshot**, so subscribing or unsubscribing from
   *    inside a listener cannot change who gets called for the event already in
   *    flight. To be accurate about what this fixes: the four originals removed
   *    via `filter`, which allocates a new array, so an in-flight `for…of` was
   *    already safe. The snapshot makes that a property of this class rather
   *    than an accident of how `unsubscribe` happens to be written — swap
   *    `filter` for `splice` and the old code would have started silently
   *    skipping whichever listener sat next.
   *
   * Deliberately does not log the payload. This runs per candle tick, and the
   * deleted event bus proved what per-second debug logging of every payload
   * does to a log file that exists to make real failures findable.
   */
  emit(...args: Args): void {
    if (this.listeners.length === 0) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(...args);
      } catch (err) {
        log.error(`${this.label} listener threw`, err);
      }
    }
  }
}
