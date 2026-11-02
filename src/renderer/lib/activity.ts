import type { ActivityEvent } from "@/lib/api";

/**
 * Turning an audit row into something worth reading.
 *
 * ## The defect this replaces
 *
 * The feed rendered `action.replace(/_/g, " ")` and **discarded `detail`
 * entirely** — so it said "plan branch triggered" when the row already knew
 * *which* branch, at *what price*, and whether a position followed. Every
 * interesting fact was in the database and none of it reached the screen. That
 * is why the panel read as a list of function names.
 *
 * ## What belongs in a feed
 *
 * Decisions and outcomes, not lifecycle. "Basis monitor started" is true and
 * uninteresting: it happens on every launch and tells the owner nothing they
 * would act on. Those are demoted to `chore` so they can be filtered out while
 * still existing for the audit log, which is a different surface with a
 * different job (Settings › Audit log shows everything, deliberately).
 *
 * ## Unknown actions never vanish
 *
 * An action with no formatter falls back to its humanised name plus whatever
 * detail can be read. A feed that silently dropped events it did not recognise
 * would be worse than a generic one — the missing line is invisible, and the
 * next engine path added would go unnoticed until someone wondered why nothing
 * was logged.
 */

export type ActivityTone = "entry" | "exit" | "decision" | "refusal" | "warning" | "chore" | "engine";

export interface DescribedActivity {
  tag: string;
  tone: ActivityTone;
  text: string;
  /** Lifecycle chatter, hidden by default. */
  chore: boolean;
}

function parse(detail: string | null | undefined): Record<string, unknown> {
  if (!detail) return {};
  try {
    const v = JSON.parse(detail);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Trim a price to something readable without inventing precision. */
function price(v: unknown): string {
  const n = num(v);
  if (n === null) return "";
  const abs = Math.abs(n);
  return abs >= 100 ? n.toFixed(2) : abs >= 1 ? n.toFixed(4) : n.toPrecision(4);
}

function money(v: unknown): string {
  const n = num(v);
  if (n === null) return "";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

export function describeActivity(ev: ActivityEvent): DescribedActivity {
  const d = parse(ev.detail);
  const slug = str(d.slug) ?? str(d.name) ?? "";
  const branch = str(d.branch) ?? "";
  const plan = slug && branch ? `${slug}/${branch}` : slug;

  switch (ev.action) {
    /* ── The product: a plan acting ──────────────────────────────── */
    case "plan_branch_triggered": {
      const at = price(d.price);
      const opened = d.positionOpened === true;
      /* Says what did NOT happen as well as what did — "triggered" alone reads
         as "you have a position", and often there isn't one. */
      return {
        tag: "trigger",
        tone: "decision",
        chore: false,
        text: `${plan || "a plan"} triggered${at ? ` at ${at}` : ""} — ${
          opened ? `position #${num(d.position_id) ?? "?"} opened` : "no position opened"
        }`,
      };
    }
    case "plan_entry_refused":
      return {
        tag: "refused",
        tone: "refusal",
        chore: false,
        /* The reason is the whole value of this line. */
        text: `${plan || "a plan"} fired but the entry was refused — price ${price(d.price)} is ${
          str(d.reason) ?? "outside the approved geometry"
        }`,
      };
    case "plan_entry_blocked_kill_switch":
    case "paper_entry_blocked_kill_switch":
      return {
        tag: "blocked",
        tone: "warning",
        chore: false,
        text: `entry blocked by the kill switch${str(d.reason) ? ` — ${str(d.reason)}` : ""}`,
      };
    case "plan_position_opened": {
      const div = num(d.entry_divergence_pct);
      return {
        tag: "entry",
        tone: "entry",
        chore: false,
        text:
          `${plan || "plan"} bought at ${price(d.price)}` +
          (div !== null && Math.abs(div) >= 0.1 ? ` (${div > 0 ? "+" : ""}${div.toFixed(2)}% off the approved entry)` : "") +
          `, stop ${price(d.stop)}${d.target ? `, target ${price(d.target)}` : ""}`,
      };
    }
    case "paper_position_opened":
      return {
        tag: "entry",
        tone: "entry",
        chore: false,
        text: `bought at ${price(d.price)}, stop ${price(d.stop)}${d.target ? `, target ${price(d.target)}` : ""}`,
      };
    case "paper_position_closed":
      return {
        tag: "exit",
        tone: "exit",
        chore: false,
        text: `closed at ${price(d.exit_price)} — ${String(d.reason ?? "exit").replace(/_/g, " ")}, PnL ${money(
          d.realized_pnl
        )}`,
      };
    case "plan_state_changed":
      return {
        tag: "plan",
        tone: "decision",
        chore: false,
        text: `${slug || "a plan"} → ${str(d.to) ?? "?"}${str(d.reason) ? ` — ${str(d.reason)}` : ""}`,
      };
    case "plan_armed":
      return { tag: "armed", tone: "decision", chore: false, text: `${slug || "a plan"} armed — the engine is watching it` };
    case "plan_created":
      return { tag: "plan", tone: "engine", chore: false, text: `${slug || "a plan"} drafted` };
    case "agent_drafted_plan":
      return { tag: "agent", tone: "decision", chore: false, text: `the agent drafted ${slug || "a plan"} for you to review` };
    case "agent_created_level_reference":
      return { tag: "agent", tone: "engine", chore: false, text: `the agent named a level: ${str(d.label) ?? "a level"}` };

    /* ── Things that should interrupt you ────────────────────────── */
    case "kill_switch_tripped":
      return { tag: "halt", tone: "warning", chore: false, text: `kill switch tripped — ${str(d.reason) ?? "no new entries"}` };
    case "kill_switch_reset":
      return { tag: "halt", tone: "decision", chore: false, text: "kill switch reset — new entries allowed again" };
    case "monitor_gap": {
      const ms = num(d.ms) ?? 0;
      const mins = Math.round(ms / 60_000);
      return {
        tag: "gap",
        tone: "warning",
        chore: false,
        /* The honest consequence, not just the fact. */
        text: `nothing was watching for ${mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`} — plans could not trigger in that window`,
      };
    }
    case "notification_abandoned":
      return {
        tag: "alert",
        tone: "warning",
        chore: false,
        text: `gave up sending "${str(d.title) ?? "a notification"}" — you were not told any other way`,
      };
    case "alert_triggered":
      return { tag: "alert", tone: "decision", chore: false, text: `alert fired: ${str(d.label) ?? "an alert"}` };
    case "venue_changed":
      return { tag: "venue", tone: "warning", chore: false, text: `venue changed to ${str(d.to) ?? "?"}` };
    /* Loud only in the direction that matters: choosing live is a warning,
       choosing simulated is the safe default and reads as a decision. Both
       were red, so the safe choice looked like an alarm. */
    case "app_mode_selected":
      return {
        tag: "mode",
        tone: d.mode === "live" ? "warning" : "decision",
        chore: false,
        text: `${str(d.mode) ?? "?"} mode selected — takes effect on the next launch`,
      };
    case "app_mode_reset":
      return {
        tag: "mode",
        tone: "decision",
        chore: false,
        text: `saved live choice cleared — live trading isn't available, so the app runs simulated`,
      };

    /* ── Lifecycle. True, and not what a feed is for. ────────────── */
    case "app_started":
      return { tag: "engine", tone: "chore", chore: true, text: `app started in ${str(d.mode) ?? "?"} mode` };
    case "basis_monitor_started":
    case "session_selected":
    case "keypair_generated":
    case "api_key_saved":
    case "anthropic_api_key_saved":
    case "browserbase_key_saved":
    case "browserbase_key_cleared":
    case "telegram_configured":
    case "telegram_disconnected":
      return { tag: "chore", tone: "chore", chore: true, text: ev.action.replace(/_/g, " ") };

    default:
      /* Never dropped. An unrecognised action still shows, with whatever the
         payload offers, so a newly added engine path is visible immediately
         rather than silently missing from the feed. */
      return {
        tag: "engine",
        tone: "engine",
        chore: false,
        text: ev.action.replace(/_/g, " ") + (slug ? ` — ${slug}` : ""),
      };
  }
}

export const ACTIVITY_TONE_COLOR: Record<ActivityTone, string> = {
  entry: "var(--up)",
  exit: "var(--accent)",
  decision: "var(--foreground)",
  refusal: "var(--caution)",
  warning: "var(--down)",
  chore: "var(--text-faint)",
  engine: "var(--muted-foreground)",
};
