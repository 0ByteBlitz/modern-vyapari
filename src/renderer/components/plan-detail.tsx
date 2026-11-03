import { formatLevel } from "@shared/levels";
import type { PriceLevel } from "@shared/levels";
import { describeThreshold } from "@shared/levels";
import { useEffect, useState } from "react";
import { api, isError, type StoredPlanView, type PlanBranchView, type LevelDraftView, type PlanWatch } from "@/lib/api";
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

/** What the engine is doing with this plan, re-read on every data broadcast —
 *  a feed pause, a session pause and the kill switch all arrive that way. */
function usePlanWatch(rowId: number): PlanWatch | null {
  const [watch, setWatch] = useState<PlanWatch | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api.planWatch(rowId).then((r) => {
        if (live) setWatch(isError(r) ? null : r);
      });
    load();
    const off = api.onDataUpdated(load);
    return () => {
      live = false;
      off();
    };
  }, [rowId]);
  return watch;
}

function watchLine(watch: PlanWatch, mode: string, canFire: boolean): { text: string; off: boolean } {
  if (!watch.watched) return { text: "Not being watched — restart the app if this lasts.", off: true };
  if (watch.feedSilentSince !== null) {
    const since = new Date(watch.feedSilentSince).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
    return {
      text: `No price data since ${since}. Decisions and paper stops wait until it returns; the app keeps reconnecting.`,
      off: true,
    };
  }
  if (watch.feedPausedSince !== null) {
    const since = new Date(watch.feedPausedSince).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
    return {
      text: `Paused — price bars are missing from ${since}. Decisions resume once they load; stops and targets still apply.`,
      off: true,
    };
  }
  if (watch.entryBlocked === "session_paused")
    return { text: "Watched, but a trigger opens no position while the session is paused. Resume the session to allow entries.", off: true };
  if (watch.entryBlocked === "kill_switch")
    return { text: "Watched, but a trigger opens no position while the kill switch is on.", off: true };
  if (!canFire) return { text: "Watched on every closed bar until it resolves.", off: false };
  return { text: `Watched on every closed bar. A trigger opens a ${mode} position with the branch's stop and target.`, off: false };
}

/** The card's one-line version: shown only when the plan is not simply being
 *  watched with entries open. */
export function PlanWatchNote({ plan }: { plan: StoredPlanView }) {
  const watch = usePlanWatch(plan.rowId);
  if (!watch || (plan.state !== "planned" && plan.state !== "triggered")) return null;
  const text = !watch.watched
    ? "Not being watched"
    : watch.feedSilentSince !== null
      ? "No price data — not being watched"
      : watch.feedPausedSince !== null
      ? "Paused — price bars missing"
      : watch.entryBlocked === "session_paused"
        ? "Session paused — a trigger opens no position"
        : watch.entryBlocked === "kill_switch"
          ? "Kill switch on — a trigger opens no position"
          : null;
  return text ? <p className="plans-warn">{text}</p> : null;
}

export function PlanDetail({
  plan,
  price,
  onClose,
}: {
  plan: StoredPlanView;
  /** Last analysis-feed close, for distances. Null when unavailable. */
  price: number | null;
  onClose: () => void;
}) {
  const mode = useAppMode();
  const watch = usePlanWatch(plan.rowId);
  const line = watch && watchLine(watch, mode, plan.branches.some((b) => (b.status ?? "pending") === "pending"));
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

      {(plan.state === "planned" || plan.state === "triggered") && line && (
        <p className={`detail-watch ${line.off ? "detail-watch-off" : ""}`}>{line.text}</p>
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
