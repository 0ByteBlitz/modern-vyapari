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

/** The owner's mark — drawn only on armed terms, never decoration. */
export function SignatureMark({ width = 70 }: { width?: number }) {
  return (
    <svg
      className="signature-mark"
      viewBox="0 0 190 48"
      style={{ width, height: (width * 48) / 190 }}
      aria-hidden="true"
    >
      <path
        d="M4 34c10-18 18-26 22-16s-2 22 6 14 10-24 18-20 2 18 12 12 8-14 14-10-2 14 8 10 14-8 22-6 22 4 40 0"
        fill="none"
        stroke="currentColor"
        strokeWidth={width < 100 ? 5 : 3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
 * "Signed by you · <time>" for a plan the owner armed. The time is the stored
 * arming timestamp; when there is none the line says only "Signed by you"
 * rather than inventing one.
 */
export function SignedBy({ armedAt, long = false }: { armedAt: number | null; long?: boolean }) {
  const when = armedAt !== null ? ` · ${formatSignedAt(armedAt)}` : "";
  return (
    <span className={`signed-by${long ? " signed-by-long" : ""}`}>
      <SignatureMark width={long ? 120 : 70} />
      <span>
        {long ? `Signed by you at arming${when}. These terms execute without asking again.` : `Signed by you${when}`}
      </span>
    </span>
  );
}
