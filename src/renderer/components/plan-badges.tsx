import { PLAN_STATE_LABEL, type PlanState } from "@shared/ipc-types";

/**
 * A plan's state as a pill, one look per state everywhere a plan appears.
 *
 * Draft is orchid because the agent may have written it. Armed carries the
 * indigo ring: it is the only state the owner created by signing. Triggered is
 * the solid indigo pill. Finished states are quiet outlines; invalidated is
 * coral because the thesis was proved wrong.
 */
export function PlanStateBadge({ state }: { state: PlanState }) {
  return (
    <span className={`plan-state plan-state-${state}`}>
      {state === "planned" && <ArmedRing />}
      {PLAN_STATE_LABEL[state]}
    </span>
  );
}

export function ArmedRing() {
  return (
    <svg className="plan-state-ring" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="6" cy="6" r="2" fill="currentColor" />
    </svg>
  );
}

export function formatSignedAt(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString([], { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}, ${time}`;
}

/**
 * "Signed by you · <time>" for a plan the owner armed. Plain text: the record
 * of the signature is the timestamp, and a drawn squiggle added nothing to it.
 * When there is no stored time the line says only "Signed by you" rather than
 * inventing one.
 */
export function SignedBy({ armedAt, long = false }: { armedAt: number | null; long?: boolean }) {
  const when = armedAt !== null ? ` · ${formatSignedAt(armedAt)}` : "";
  return (
    <span className={`signed-by${long ? " signed-by-long" : ""}`}>
      {long ? `Signed by you at arming${when}. These terms execute without asking again.` : `Signed by you${when}`}
    </span>
  );
}
