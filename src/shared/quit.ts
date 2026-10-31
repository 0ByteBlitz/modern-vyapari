/**
 * What quitting stops — one definition, read by the themed dialog in the
 * renderer and by main's native fallback, so the two can never say different
 * things.
 *
 * Compiles into both bundles: no imports, ever (same rule as `levels.ts`).
 *
 * Why a quit needs saying at all: the spine is J3, *the plan executes without
 * me*, and that only holds while the app is open. An armed plan cannot trigger
 * and a paper position's stop and target are not checked while it is closed.
 * The old native box said "In later phases…", which was true of no phase and
 * named nothing the owner could check.
 *
 * Unknown is a value, not zero: if the counts could not be read, the dialog
 * says so rather than reporting "nothing is armed" — the flattering direction.
 */

export interface QuitSummary {
  mode: "simulated" | "live";
  /** Plans in `planned` — armed, waiting for a trigger. Null when unreadable. */
  armedPlans: number | null;
  /** Open positions whose stop and target are checked by this app. Null when unreadable. */
  openPositions: number | null;
}

export interface QuitCopy {
  title: string;
  /** The single sentence under the title. */
  lead: string;
  /** What stops while the app is closed; empty when nothing does. */
  consequences: string[];
  /** True when quitting stops something — the safe action takes the focus. */
  guarded: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function describeQuit(s: QuitSummary): QuitCopy {
  const title = "Quit Modern Vyapari?";
  if (s.armedPlans === null || s.openPositions === null) {
    return {
      title,
      lead: "Couldn't check what's being watched. Armed plans and open positions aren't watched while the app is closed.",
      consequences: [],
      guarded: true,
    };
  }
  const consequences: string[] = [];
  if (s.armedPlans > 0) {
    consequences.push(`${plural(s.armedPlans, "armed plan", "armed plans")} can't trigger`);
  }
  if (s.openPositions > 0) {
    consequences.push(
      s.openPositions === 1
        ? "1 open position's stop and target aren't checked"
        : `${s.openPositions} open positions' stops and targets aren't checked`
    );
  }
  if (consequences.length === 0) {
    return { title, lead: "Nothing is armed or open.", consequences, guarded: false };
  }
  return { title, lead: "While the app is closed:", consequences, guarded: true };
}
