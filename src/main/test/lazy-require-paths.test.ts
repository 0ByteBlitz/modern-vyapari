/**
 * Every lazy require() or dynamic import() with a relative path, in main and
 * preload, must point at a file that exists.
 *
 * TypeScript type-checks static imports but not `require()` strings, so a file
 * move can leave a lazy require pointing nowhere with a clean typecheck and a
 * green suite. That is exactly what happened when `ipc.ts` was split into
 * `ipc/`: ten requires kept their old `./main`, `./risk/kill-switch` and
 * `./db/database` paths. The Windows Hello unlock, all three kill-switch
 * handlers and the window controls threw "Cannot find module" at runtime and
 * surfaced as a generic error. The kill switch displayed as working and did
 * nothing — a control that does not control.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const SCAN = [join(ROOT, "src", "main"), join(ROOT, "src", "preload")];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

function resolves(fromFile: string, spec: string): boolean {
  const base = resolve(dirname(fromFile), spec);
  return [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    base, // e.g. a .json asset
  ].some((p) => existsSync(p) && statSync(p).isFile());
}

test("every relative lazy require/import resolves to a source file", () => {
  const pattern = /\b(?:require|import)\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  let checked = 0;
  const broken: string[] = [];

  for (const file of SCAN.flatMap(sources)) {
    const body = readFileSync(file, "utf8");
    for (const m of body.matchAll(pattern)) {
      const spec = m[1]!;
      checked++;
      if (!resolves(file, spec)) {
        const line = body.slice(0, m.index).split("\n").length;
        broken.push(`${relative(ROOT, file)}:${line} → ${spec}`);
      }
    }
  }

  // Guard against a vacuous pass: the ipc/ modules alone hold ten of these.
  assert.ok(checked >= 10, `expected to check at least 10 lazy requires, found ${checked}`);
  assert.deepEqual(broken, [], `lazy require targets that do not exist:\n${broken.join("\n")}`);
});
