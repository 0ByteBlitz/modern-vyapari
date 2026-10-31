/**
 * The IPC surface is exactly what the preload bridge asks for.
 *
 * **Written before splitting `ipc.ts` into per-domain modules, and run green
 * first**, so the split had something to be judged against. Moving 95 handlers
 * between files is precisely the mechanical edit that goes wrong once and is
 * never noticed: a dropped handler is a channel that rejects at runtime, in
 * whichever surface happens to call it, weeks later.
 *
 * These read the **source**, not a running app. `ipc.ts` imports electron and
 * calls `app.getPath` at registration, so a test process cannot invoke it —
 * and a guard that could not run would be no guard at all.
 *
 * The invariant chosen is deliberately not a checked-in snapshot of channel
 * names. A snapshot rots: it has to be updated by hand on every legitimate
 * addition, and a list nobody trusts gets updated reflexively. Equality with
 * the preload bridge is self-maintaining and says something truer — **every
 * channel main answers is one the renderer asks for, and every channel the
 * renderer asks for is one main answers.**
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAIN = join(__dirname, "..", "..", "..", "src", "main");
const PRELOAD = join(__dirname, "..", "..", "..", "src", "preload", "preload.ts");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every `ipcMain.handle("x", …)` in main, with the file it came from. */
function registered(): Array<{ channel: string; file: string }> {
  const found: Array<{ channel: string; file: string }> = [];
  for (const file of sources(MAIN)) {
    if (file.includes(`${join("main", "test")}`)) continue;
    const body = readFileSync(file, "utf8");
    for (const m of body.matchAll(/ipcMain\.handle\(\s*\n?\s*"([^"]+)"/g)) {
      found.push({ channel: m[1]!, file });
    }
  }
  return found;
}

function invoked(): string[] {
  const body = readFileSync(PRELOAD, "utf8");
  return [...body.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the IPC surface", () => {
  test("every channel the renderer asks for is answered by main", () => {
    const missing = [...new Set(invoked())].filter(
      (c) => !registered().some((r) => r.channel === c)
    );
    /* This is the failure the split could have caused: the bridge still offers
       the method, the handler moved to a file nobody imported, and the call
       rejects at runtime in whichever surface happens to use it. */
    assert.deepEqual(missing, [], "channels invoked from preload with no handler");
  });

  test("every channel main answers is one the renderer asks for", () => {
    const inv = new Set(invoked());
    const orphans = registered()
      .map((r) => r.channel)
      .filter((c) => !inv.has(c));
    /* The other direction, and it is not merely tidiness: a handler nothing
       calls is surface area the sandbox model has to keep honest for no
       benefit. If one is ever added deliberately, it belongs behind a comment
       here rather than passing silently. */
    assert.deepEqual([...new Set(orphans)], [], "handlers no preload method reaches");
  });

  test("no channel is registered twice", () => {
    const seen = new Map<string, string[]>();
    for (const { channel, file } of registered()) {
      seen.set(channel, [...(seen.get(channel) ?? []), file]);
    }
    const dupes = [...seen.entries()].filter(([, files]) => files.length > 1);
    /* Electron throws on a second handler for the same channel, so this would
       be a launch crash — but only if the second registration runs, which after
       a split depends on which register functions are wired up. */
    assert.deepEqual(dupes, [], "the same channel registered in two places");
  });

  test("every handler reports failures under its own channel name", () => {
    const problems: string[] = [];
    for (const file of sources(MAIN)) {
      if (file.includes(`${join("main", "test")}`)) continue;
      const body = readFileSync(file, "utf8");
      for (const block of body.split("ipcMain.handle(").slice(1)) {
        const name = /^\s*\n?\s*"([^"]+)"/.exec(block)?.[1];
        if (!name) continue;
        /* Only the part before the next handler belongs to this one. */
        const scope = block.slice(0, 4000);
        if (!scope.includes("safe(")) continue;
        if (!scope.includes(`"${name}"`, scope.indexOf("safe("))) problems.push(name);
      }
    }
    /* `safe()` logs under the label it is given. A handler carrying a
       neighbour's label sends whoever is debugging it to the wrong subsystem —
       cheap to get wrong while moving code between files, and invisible until
       the day something breaks. */
    assert.deepEqual(problems, [], "handlers whose safe() label is not their own channel");
  });
});
