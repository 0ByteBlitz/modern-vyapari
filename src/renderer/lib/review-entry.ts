import type { JournalEntry } from "@/lib/api";

/**
 * What a `trade_review` journal entry says, read from the fields main wrote.
 *
 * Main writes two shapes under one kind (`agent/review.ts`):
 *   • a closed position — tags `paper,<owner kind>,<exit_reason>,win|loss|breakeven,<owner name>`
 *   • a plan that ended with no position — tags `plan,<end state>,no-trade`
 * and both open the content with a generated header line,
 * `[PAIR] <name> — <how it ended>…`, then a blank line, then the review.
 *
 * The outcome is read by **exact tag token**. A substring test on the tag
 * string called a losing trade from a plan named `window-break` a win, and
 * called every no-trade note a loss.
 */
export type ReviewTone = "up" | "down" | "flat";

export interface ReviewOutcome {
  label: string;
  tone: ReviewTone;
}

export interface ReviewParts {
  outcome: ReviewOutcome;
  /** The plan or strategy the review is about, or null when the header is not there. */
  name: string | null;
  /** The generated header line — pair, name, how it ended — or null. */
  header: string | null;
  /** The review itself. */
  body: string;
}

/* `manual` and `session_archived` are the operator cutting the trade short.
   The review prompt is told not to call those a win or a loss, so the badge
   does not either. */
const ADMINISTRATIVE_EXIT: Record<string, string> = {
  manual: "closed by you",
  session_archived: "session archived",
};

function outcomeOf(tags: string[]): ReviewOutcome {
  if (tags.includes("no-trade")) {
    const state = tags[1];
    return { label: state ? `no trade · ${state}` : "no trade", tone: "flat" };
  }
  const admin = ADMINISTRATIVE_EXIT[tags[2] ?? ""];
  if (admin) return { label: admin, tone: "flat" };
  if (tags.includes("win")) return { label: "win", tone: "up" };
  if (tags.includes("loss")) return { label: "loss", tone: "down" };
  if (tags.includes("breakeven")) return { label: "breakeven", tone: "flat" };
  return { label: "review", tone: "flat" };
}

const HEADER = /^\[[^\]]+\] (.+?) — /;

export function readReview(entry: JournalEntry): ReviewParts {
  const tags = entry.tags.split(",").map((t) => t.trim());
  const split = entry.content.indexOf("\n\n");
  const first = split > 0 ? entry.content.slice(0, split) : "";
  const match = first ? HEADER.exec(first) : null;
  return {
    outcome: outcomeOf(tags),
    name: match?.[1] ?? null,
    header: match ? first : null,
    body: match ? entry.content.slice(split + 2).trim() : entry.content,
  };
}
