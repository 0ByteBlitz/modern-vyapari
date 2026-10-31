/**
 * No vendor lock-in: vendor SDKs stay behind their ports.
 *
 * The app talks to an AI provider through `src/main/ai/` and to a venue through
 * `src/main/integrations/venue/`. If any other module imports a vendor SDK or
 * client directly, swapping the vendor stops being "write an adapter" and
 * becomes "find every place that assumed this one" — which is how a single
 * vendor gets locked in, one convenient import at a time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Package or path → the only folder allowed to import it. */
const BOUNDARIES: Array<{ what: RegExp; label: string; allowedUnder: string }> = [
  { what: /["']@anthropic-ai\/sdk["']/, label: "Anthropic SDK", allowedUnder: "src/main/ai/" },
  { what: /["']openai["']/, label: "OpenAI SDK", allowedUnder: "src/main/ai/" },
  { what: /["']@google\/(genai|generative-ai)["']/, label: "Google AI SDK", allowedUnder: "src/main/ai/" },
  { what: /["']ollama["']/, label: "Ollama SDK", allowedUnder: "src/main/ai/" },
];

test("vendor AI SDKs are imported only inside src/main/ai/", () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (rel.startsWith("src/main/test/")) continue;
    const body = readFileSync(file, "utf8");
    for (const b of BOUNDARIES) {
      if (b.what.test(body) && !rel.startsWith(b.allowedUnder)) offenders.push(`${rel} imports the ${b.label}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the boundary check is not vacuous: the Anthropic adapter is found inside it", () => {
  const adapter = readFileSync(join(SRC, "main", "ai", "anthropic.ts"), "utf8");
  assert.match(adapter, /from "@anthropic-ai\/sdk"/);
});
