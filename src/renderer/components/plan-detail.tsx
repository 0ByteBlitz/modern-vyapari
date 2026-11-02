import { formatLevel } from "@shared/levels";
import type { PriceLevel } from "@shared/levels";
import { describeThreshold } from "@shared/levels";
import type { StoredPlanView, PlanBranchView, LevelDraftView } from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { DetailModal, DetailSection, LevelRow } from "@/components/detail-modal";
import { useAppMode } from "@/lib/mode";

/**
 * Everything an armed plan committed you to, in one place.
 *
 * The plans list shows a card; this answers "what did I actually agree to" —
 * the assumptions, the thesis invalidation, every branch's four levels, the
 * expiry and the budget. Before it existed a plan could be armed and then never
 * inspected again: the resolved numbers were shown once at arming and were gone
 * on the next render.
 *
 * **Levels are labelled by role**, because trigger / entry / stop / target /
 * invalidation are formatted identically and mean opposite things.
 *
 * Like every other plan surface, this **never resolves a level**. A derived
 * level shows `resolvedAtArm` — main's number — labelled as at-arm.
 */
const DAY = 86_400_000;

interface Reading {
  value: number | null;
  atArm: boolean;
  source: string | null;
}

function read(level: LevelDraftView | undefined): Reading {
  if (!level || typeof level !== "object") return { value: null, atArm: false, source: null };
  const l = level as Record<string, unknown>;
  if (l.kind === "static" && typeof l.price === "number") {
    return { value: l.price, atArm: false, source: null };
  }
  const armed = typeof l.resolvedAtArm === "number" ? l.resolvedAtArm : null;
  let source: string | null = null;
  try {
    source = formatLevel(level as PriceLevel);
  } catch {
    /* Unknown shape: show the number without a name rather than blanking it. */
  }
  return { value: armed, atArm: armed !== null, source };
}

function gap(price: number | null, level: number | null): number | null {
  if (price === null || level === null || price === 0) return null;
  return ((level - price) / price) * 100;
}

function Level({
  role,
  level,
  price,
  tone,
}: {
  role: string;
  level: LevelDraftView | undefined;
  price: number | null;
  tone?: "up" | "down" | "caution" | "accent";
}) {
  const r = read(level);
  return (
    <LevelRow
      role={role}
      value={r.value === null ? "—" : formatPrice(String(r.value))}
      source={r.source}
      atArm={r.atArm}
      gapPct={gap(price, r.value)}
      tone={tone}
    />
  );
}

function Branch({ branch, price }: { branch: PlanBranchView; price: number | null }) {
  const fired = branch.status === "triggered";
  const cancelled = branch.status === "cancelled_oco";
  return (
    <div className={`detail-branch ${fired ? "detail-branch-fired" : ""} ${cancelled ? "detail-branch-off" : ""}`}>
      <div className="detail-branch-head">
        <span className="detail-branch-label">{branch.label || branch.id}</span>
        {fired && <span className="badge badge-supervised">fired</span>}
        {cancelled && <span className="badge badge-retired">cancelled</span>}
        <span className="mono ml-auto detail-branch-share">{branch.budgetSharePct}% of budget</span>
      </div>

      <LevelRow role="trigger" value={describeThreshold(triggerValue(branch.trigger))} tone="accent" />
      <Level role="entry" level={branch.entry} price={price} />
      <Level role="stop" level={branch.stop} price={price} tone="down" />
      {(branch.targets ?? []).map((t, i) => (
        <Level
          key={i}
          role={branch.targets.length > 1 ? `target ${i + 1}` : "target"}
          level={t}
          price={price}
          tone="up"
        />
      ))}

      {fired && (
        <p className="detail-branch-note">
          {branch.positionId
            ? `Opened position #${branch.positionId}.`
            : "Fired, but no position was opened — plan execution isn't switched on yet."}
        </p>
      )}
    </div>
  );
}

/** Pull the comparison value out of a stored ConditionGroup for display only.
 *  Reading the engine's shape is fine; constructing it in the renderer is not. */
function triggerValue(group: unknown): unknown {
  const g = group as { conditions?: Array<{ value?: unknown }> } | null;
  return g?.conditions?.[0]?.value ?? "—";
}

export function PlanDetail({
  plan,
  price,
  monitored,
  onClose,
}: {
  plan: StoredPlanView;
  /** Last analysis-feed close, for distances. Null when unavailable. */
  price: number | null;
  /** Whether the engine is watching this plan right now. */
  monitored: boolean;
  onClose: () => void;
}) {
  const mode = useAppMode();
  const left = plan.expiresAt - Date.now();
  const expiry =
    left <= 0
      ? "expired"
      : left >= 2 * DAY
        ? `${Math.floor(left / DAY)} days left`
        : `${Math.max(1, Math.floor(left / 3_600_000))} hours left`;

  return (
    <DetailModal
      kind="Plan"
      title={plan.slug}
      badge={<span className={`badge badge-${plan.state === "triggered" ? "supervised" : "paper"}`}>{plan.state}</span>}
      onClose={onClose}
    >
      <p className="detail-thesis">{plan.thesis}</p>

      <div className="detail-facts">
        <div>
          <span className="label-micro">Pair</span>
          <span className="mono">{plan.pair}</span>
        </div>
        <div>
          <span className="label-micro">Timeframe</span>
          <span className="mono">{plan.evalInterval}</span>
        </div>
        <div>
          <span className="label-micro">Budget</span>
          <span className="mono">{plan.risk.maxQuote}</span>
        </div>
        <div>
          <span className="label-micro">Expiry</span>
          <span className={`mono ${left > 0 && left < 2 * DAY ? "v-caution" : ""}`}>{expiry}</span>
        </div>
      </div>

      {(plan.state === "planned" || plan.state === "triggered") && (
        <p className={`detail-watch ${monitored ? "" : "detail-watch-off"}`}>
          {monitored
            ? `Watched on every closed bar. A trigger opens a ${mode} position with the branch's stop and target.`
            : "Not being watched — the session is paused or archived."}
        </p>
      )}

      <DetailSection title="Assumptions" note="what must be true">
        {plan.assumptions.length === 0 ? (
          <p className="detail-empty">None recorded.</p>
        ) : (
          <ul className="detail-list">
            {plan.assumptions.map((a, i) => (
              <li key={i}>{a.text}</li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Thesis invalidation" note="not the stop">
        <LevelRow role="invalidation" value={describeThreshold(triggerValue(plan.invalidation))} tone="caution" />
      </DetailSection>

      <DetailSection
        title={plan.branches.length === 1 ? "Branch" : "Branches"}
        note={plan.ocoExclusive ? "one-cancels-the-other" : "independent — several can fire"}
      >
        {plan.branches.map((b) => (
          <Branch key={b.rowId ?? b.id} branch={b} price={price} />
        ))}
      </DetailSection>

      {plan.outcomeReason && (
        <DetailSection title="Outcome">
          <p className="detail-empty">{plan.outcomeReason}</p>
        </DetailSection>
      )}
    </DetailModal>
  );
}
