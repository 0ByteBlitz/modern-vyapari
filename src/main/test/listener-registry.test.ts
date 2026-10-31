/**
 * The shared listener registry (roadmap S2-7a).
 *
 * Worth testing despite being ~30 lines, because it now sits under four
 * engines and the two properties it guarantees are exactly the ones the four
 * hand-rolled copies each got slightly differently:
 *
 *  • a throwing listener must not stop the others, or the caller — these are
 *    notifications, and a broken review agent must not be able to halt the
 *    engine that trades;
 *  • iteration is over a snapshot, so subscribing or unsubscribing from inside
 *    a listener cannot change who is notified of the event already in flight.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ListenerRegistry } from "../events/listener-registry";

describe("ListenerRegistry", () => {
  test("notifies every listener with the emitted arguments", () => {
    const reg = new ListenerRegistry<[string, number]>("test");
    const seen: Array<[string, number]> = [];
    reg.add((a, b) => seen.push([a, b]));
    reg.add((a, b) => seen.push([a.toUpperCase(), b * 2]));

    reg.emit("btc", 4);
    assert.deepEqual(seen, [
      ["btc", 4],
      ["BTC", 8],
    ]);
  });

  test("unsubscribe removes exactly one listener", () => {
    const reg = new ListenerRegistry<[]>("test");
    let a = 0;
    let b = 0;
    const off = reg.add(() => a++);
    reg.add(() => b++);

    reg.emit();
    off();
    reg.emit();

    assert.equal(a, 1, "the unsubscribed listener must stop being called");
    assert.equal(b, 2, "the other listener must keep being called");
    assert.equal(reg.size, 1);
  });

  test("a throwing listener does not stop the others, and does not reach the caller", () => {
    /* The property that matters most. The review agent is attached to the paper
       engine as a close listener; if it could throw into the engine, a bad
       review would stop trading. */
    const reg = new ListenerRegistry<[number]>("test");
    const order: string[] = [];
    reg.add(() => {
      order.push("first");
    });
    reg.add(() => {
      throw new Error("listener blew up");
    });
    reg.add(() => {
      order.push("third");
    });

    assert.doesNotThrow(() => reg.emit(1));
    assert.deepEqual(order, ["first", "third"]);
  });

  test("unsubscribing during an emit does not skip a later listener", () => {
    /* Iterating the live array while a listener removes itself is the classic
       way to silently skip whoever sat next. A "fire once then unsubscribe"
       listener is a completely reasonable thing to write, so this must hold. */
    const reg = new ListenerRegistry<[]>("test");
    const seen: string[] = [];

    const off = reg.add(() => {
      seen.push("self-removing");
      off();
    });
    reg.add(() => seen.push("second"));
    reg.add(() => seen.push("third"));

    reg.emit();
    assert.deepEqual(seen, ["self-removing", "second", "third"]);

    seen.length = 0;
    reg.emit();
    assert.deepEqual(seen, ["second", "third"], "and the removal still took effect");
  });

  test("subscribing during an emit does not notify the newcomer for the in-flight event", () => {
    const reg = new ListenerRegistry<[]>("test");
    const seen: string[] = [];
    reg.add(() => {
      seen.push("existing");
      reg.add(() => seen.push("added-mid-emit"));
    });

    reg.emit();
    assert.deepEqual(seen, ["existing"]);

    seen.length = 0;
    reg.emit();
    assert.deepEqual(seen, ["existing", "added-mid-emit"]);
  });

  test("clear drops everything", () => {
    const reg = new ListenerRegistry<[]>("test");
    let n = 0;
    reg.add(() => n++);
    reg.add(() => n++);
    reg.clear();
    reg.emit();
    assert.equal(n, 0);
    assert.equal(reg.size, 0);
  });

  test("emitting with no listeners is a no-op", () => {
    const reg = new ListenerRegistry<[string]>("test");
    assert.doesNotThrow(() => reg.emit("nobody listening"));
  });
});
