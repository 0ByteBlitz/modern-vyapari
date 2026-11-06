/**
 * How a plan's terms read on screen — one wording for every surface that shows
 * them (Plans, the arming confirmation, Alerts), so a term never reads one way
 * where it is signed and another where it is watched.
 */
import { formatLevel, type PriceLevel } from "@shared/levels";
import type { ConditionIntentView, LevelDraftView } from "@/lib/api";

/** A level for display. "not set" for a level nobody chose yet. */
export function levelText(level: LevelDraftView | undefined): string {
  const kind = (level as { kind?: unknown } | undefined)?.kind;
  return kind === "static" || kind === "derived" ? formatLevel(level as PriceLevel) : "not set";
}

/** A branch's entry. No level is not "unset": the engine fills at the close of
 *  the bar that triggered, so that is what the owner signs. */
export function entryText(level: LevelDraftView | undefined): string {
  const text = levelText(level);
  return text === "not set" ? "at market (trigger bar's close)" : text;
}

const OP_TEXT: Record<ConditionIntentView["operator"], string> = {
  crosses_above: "crosses above",
  crosses_below: "crosses below",
  above: "is above",
  below: "is below",
};

export function intentText(intent: ConditionIntentView | null | undefined): string {
  if (!intent) return "not set";
  const v = typeof intent.value === "number" ? String(intent.value) : levelText(intent.value);
  return `price ${OP_TEXT[intent.operator]} ${v}`;
}

/** An expiry with its time — a date alone says nothing about a 3-hour plan. */
export function expiryText(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
