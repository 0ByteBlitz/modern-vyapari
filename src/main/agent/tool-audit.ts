import { auditLog } from "../db/database";
import { createLogger } from "../logger";

const log = createLogger("tool-audit");

/**
 * One audit row per agent tool call (#10), written centrally from the agent
 * loop so a new tool is covered without anyone remembering to add a line.
 *
 * Before this only three writing tools left a row. Reads that send the owner's
 * data to the AI provider (trades, session memory, screenshots, fetched pages)
 * left none, and the chat transcript keeps only `[[tool:name]]` markers and can
 * be cleared or compacted — so what the agent did, and on whose behalf, could
 * simply vanish. `audit_log` is never touched by Clear or Compact.
 *
 * The actor and session live inside the JSON detail rather than in new
 * columns: the only query that needs them filters by `action`, which is a
 * column, and `json_extract` over `detail` is already how session activity is
 * resolved (`db/queries.ts`).
 */
export const AGENT_TOOL_CALL = "agent_tool_call";

/** Who did it: the general conversation, or one session's. */
export function agentActor(sessionId: number | null | undefined): string {
  return sessionId ? `agent:session:${sessionId}` : "agent:general";
}

/* Keys whose value is never recorded, whatever the tool. Image data is bulk,
   not evidence; anything credential-shaped must never reach the DB. */
const OMIT_KEY = /key|secret|token|password|passphrase|base64|image|data$/i;
const MAX_STRING = 160;
const MAX_JSON = 300;

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A short, safe summary of what the agent asked the tool for. */
export function summarizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (OMIT_KEY.test(k)) {
      out[k] = "[omitted]";
    } else if (typeof v === "string") {
      out[k] = clip(v, MAX_STRING);
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      out[k] = v;
    } else if (v !== undefined) {
      let json: string;
      try {
        json = JSON.stringify(v);
      } catch {
        json = "[unserialisable]";
      }
      out[k] = clip(json, MAX_JSON);
    }
  }
  return out;
}

/**
 * The ids a tool's result says it created or changed. Read from the shapes the
 * writing tools return (`agent/tools.ts`); a tool that returns none has none.
 */
export function touchedIds(result: unknown): Record<string, number> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  const ids: Record<string, number> = {};
  const num = (v: unknown) => (typeof v === "number" || typeof v === "bigint" ? Number(v) : undefined);
  const plan = num(r.plan_id);
  if (plan !== undefined) ids.planId = plan;
  const ref = num(r.reference_id);
  if (ref !== undefined) ids.referenceId = ref;
  const removed = num(r.removed);
  if (removed !== undefined) ids.alertId = removed;
  if (r.alert && typeof r.alert === "object") {
    const a = num((r.alert as Record<string, unknown>).id);
    if (a !== undefined) ids.alertId = a;
  }
  // write_journal returns `{ ok, id, kind }`.
  const journal = typeof r.kind === "string" ? num(r.id) : undefined;
  if (journal !== undefined) ids.journalId = journal;
  return Object.keys(ids).length > 0 ? ids : undefined;
}

/** A tool that reports failure in its result rather than by throwing. */
export function resultError(result: unknown): string | null {
  if (result && typeof result === "object" && "error" in result) {
    const e = (result as { error: unknown }).error;
    if (typeof e === "string" && e) return e;
  }
  return null;
}

export function auditToolCall(row: {
  sessionId: number | null;
  tool: string;
  input: Record<string, unknown>;
  model: string;
  turnId: string;
  outcome: "ok" | "error";
  error?: string;
  result?: unknown;
}): void {
  /* A failed write is logged, never thrown: thrown here, it would land in the
     loop's tool-error path and report a tool that succeeded as failed. */
  try {
    writeRow(row);
  } catch (err) {
    log.error(`Could not audit tool call "${row.tool}"`, err);
  }
}

function writeRow(row: Parameters<typeof auditToolCall>[0]): void {
  auditLog(AGENT_TOOL_CALL, {
    actor: agentActor(row.sessionId),
    sessionId: row.sessionId || null,
    tool: row.tool,
    input: summarizeToolInput(row.input),
    outcome: row.outcome,
    error: row.error ? clip(row.error, 200) : undefined,
    model: row.model,
    turnId: row.turnId,
    touched: row.outcome === "ok" ? touchedIds(row.result) : undefined,
  });
}
