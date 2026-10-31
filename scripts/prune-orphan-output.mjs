/**
 * Delete compiled output whose source no longer exists.
 *
 * **`tsc -b` never removes an output whose input was deleted.** That is not a
 * bug in tsc, but it means the build directory accumulates files that the
 * source tree says should not exist — and Node will happily load them.
 *
 * ## It has now bitten twice, and the second time was worse
 *
 * **First (2026-07-29 → 2026-08-01):** `event-bus.test.ts` and
 * `proactive-trader.test.ts` were deleted as dead code. Their compiled output
 * survived and `npm test` kept running it, so every count reported for three
 * days — including the "196 tests green" written into CLAUDE.md — counted five
 * tests from files that no longer existed. `proactive-trader` was deleted
 * *precisely because* a passing test over wrong logic certifies nonsense; it
 * then went on certifying it. This script was written for that.
 *
 * **Second (2026-08-05 → 2026-08-09):** `src/main/ipc.ts` was split into
 * `src/main/ipc/`. The source file was deleted; `dist/main/ipc.js` was not.
 * Node resolves `require("./ipc")` to `ipc.js` **before** `ipc/index.js`, so
 * the stale file *shadowed the entire new directory* and every launch ran the
 * pre-split IPC surface. Channels added since — `usage:report`, `mode:get`,
 * `plans:calibration` — did not exist at runtime, and **rebuilding could not
 * fix it**, because the thing to fix was a file the build had no reason to
 * touch. It presented as "no handler registered", which sounds like a missing
 * registration rather than a stale artifact.
 *
 * That is why this now covers the whole build and not just tests: the first
 * occurrence cost a wrong number, the second cost a silently wrong application.
 *
 * ## Why compare against source rather than wiping `dist`
 *
 * `tsc -b` is incremental. Deleting outputs without also invalidating
 * `.tsbuildinfo` leaves the build believing they are up to date, so it emits
 * nothing and the files stay gone. Deleting only *orphans* is safe precisely
 * because tsc will never re-emit them — their source is gone.
 *
 * Zero dependencies, by the same rule as everything else here.
 */
import { readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
/** Compiled trees and the source tree each was built from. */
const TREES = [
  { out: join(ROOT, "dist", "main"), src: join(ROOT, "src", "main") },
  { out: join(ROOT, "dist", "preload"), src: join(ROOT, "src", "preload") },
  { out: join(ROOT, "dist", "shared"), src: join(ROOT, "src", "shared") },
];

/** Suffixes tsc emits, longest first so `.d.ts.map` is matched before `.ts`. */
const EMITTED = [".d.ts.map", ".d.ts", ".js.map", ".js"];

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let removed = 0;
for (const { out, src } of TREES) {
  for (const file of walk(out)) {
    const suffix = EMITTED.find((s) => file.endsWith(s));
    if (!suffix) continue;

    const stem = relative(out, file).slice(0, -suffix.length);
    /* A `.ts` source, or a `.tsx` one — either would legitimately produce this
       output, so an orphan is only an orphan when neither exists. */
    const hasSource = [".ts", ".tsx"].some((ext) => existsSync(join(src, stem + ext)));
    if (hasSource) continue;

    rmSync(file, { force: true });
    console.log(`pruned orphan: ${relative(ROOT, file)}`);
    removed++;
  }
}

if (removed > 0) {
  console.log(`Pruned ${removed} compiled file(s) with no source.`);
}
