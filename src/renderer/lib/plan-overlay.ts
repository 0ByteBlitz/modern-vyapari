import type { Chart } from "klinecharts";
import type { StoredPlanView, LevelDraftView } from "@/lib/api";

/**
 * Draw an armed plan's levels on the Research chart (roadmap J-3, geometric half).
 *
 * The owner opened the bookmark panel expecting to pick an armed plan and see
 * it laid over the chart. This is that: entry, stop, targets and the thesis
 * invalidation, each drawn as a locked price line **labelled by the role it
 * plays** — the five format identically and mean opposite things.
 *
 * **These are a view of the plan, never ink.** They are not written to
 * `chart_drawings`, which is the answer to "does the drawing reset if I turn it
 * off?" — there is nothing to reset, because nothing was saved. Persisting them
 * would create a second definition of a level that already has one: edit the
 * plan and the ink would go stale, delete the plan and the ink would outlive
 * it. Same rule as everywhere else here — one definition, two consumers.
 *
 * **Derived levels are drawn at `resolvedAtArm`** — main's number, from the
 * moment of arming — and labelled `at arm`. That is not the chart computing its
 * own answer (which is what made the fake CVD indicator wrong); it is the chart
 * rendering a value main already committed to. A derived level with no
 * `resolvedAtArm` belongs to a draft and is skipped rather than drawn at zero.
 */

/** Role → colour. Matches the detail views, so a stop is the same red in both. */
const ROLE_COLOR: Record<string, string> = {
  entry: "#22d3ee",
  stop: "#f2566a",
  target: "#2fcc8b",
  invalidation: "#f5a524",
};

export interface PlanOverlayHandle {
  overlayIds: string[];
  /** Indicators this overlay switched on, so toggling off removes only those. */
  indicators: string[];
}

interface Reading {
  price: number | null;
  atArm: boolean;
}

function read(level: LevelDraftView | undefined): Reading {
  if (!level || typeof level !== "object") return { price: null, atArm: false };
  const l = level as Record<string, unknown>;
  if (l.kind === "static" && typeof l.price === "number") return { price: l.price, atArm: false };
  const armed = typeof l.resolvedAtArm === "number" ? l.resolvedAtArm : null;
  return { price: armed, atArm: armed !== null };
}

/**
 * Chart indicators worth switching on for a plan's derived levels.
 *
 * A plan built on an anchored VWAP is easier to read with that VWAP visible.
 * Only sources that map to a real registered indicator appear here — an entry
 * that switched on something that does not exist would silently do nothing.
 */
const SOURCE_INDICATOR: Record<string, string> = {
  avwap: "AVWAP",
  vwap: "VWAP",
  cvd: "CVD",
};

function levelSources(plan: StoredPlanView): string[] {
  const out = new Set<string>();
  const consider = (l: LevelDraftView | undefined) => {
    const src = (l as Record<string, unknown> | undefined)?.source;
    if (typeof src === "string" && SOURCE_INDICATOR[src]) out.add(SOURCE_INDICATOR[src]);
  };
  for (const b of plan.branches) {
    consider(b.entry);
    consider(b.stop);
    for (const t of b.targets ?? []) consider(t);
  }
  return [...out];
}

/** Pull a numeric threshold out of a stored ConditionGroup, for display. */
function thresholdOf(group: unknown): number | null {
  const g = group as { conditions?: Array<{ value?: unknown }> } | null;
  const v = g?.conditions?.[0]?.value;
  if (typeof v === "number") return v;
  const r = read(v as LevelDraftView);
  return r.price;
}

function line(
  chart: Chart,
  price: number,
  role: string,
  label: string,
  atArm: boolean
): string | null {
  const color = ROLE_COLOR[role] ?? "#8b95a5";
  const id = chart.createOverlay({
    name: "priceLine",
    points: [{ value: price }],
    /* Locked: this is a rendering of a committed plan, not something to drag.
       Dragging it would imply the plan changed, and an armed plan cannot be
       edited at all. */
    lock: true,
    styles: {
      line: { color, style: role === "invalidation" ? "dashed" : "solid", size: 1 },
      text: { color, size: 10, family: "IBM Plex Mono, monospace" },
    },
    extendData: `${label}${atArm ? " · at arm" : ""}`,
  } as any);
  return typeof id === "string" ? id : null;
}

/** Draw every level of one plan. Returns what was created, for removal. */
export function drawPlan(
  chart: Chart,
  plan: StoredPlanView,
  addIndicator: (name: string) => boolean
): PlanOverlayHandle {
  const overlayIds: string[] = [];
  const indicators: string[] = [];

  const push = (id: string | null) => {
    if (id) overlayIds.push(id);
  };

  const invalidation = thresholdOf(plan.invalidation);
  if (invalidation !== null) {
    push(line(chart, invalidation, "invalidation", `${plan.slug} · invalidation`, false));
  }

  for (const b of plan.branches) {
    const name = b.label || b.id;
    const trigger = thresholdOf(b.trigger);
    if (trigger !== null) push(line(chart, trigger, "entry", `${name} · trigger`, false));

    const entry = read(b.entry);
    if (entry.price !== null) push(line(chart, entry.price, "entry", `${name} · entry`, entry.atArm));

    const stop = read(b.stop);
    if (stop.price !== null) push(line(chart, stop.price, "stop", `${name} · stop`, stop.atArm));

    (b.targets ?? []).forEach((t, i) => {
      const r = read(t);
      if (r.price === null) return;
      const suffix = (b.targets ?? []).length > 1 ? ` ${i + 1}` : "";
      push(line(chart, r.price, "target", `${name} · target${suffix}`, r.atArm));
    });
  }

  /* Indicators are additive and only removed if WE added them — a plan overlay
     must not switch off an indicator the trader turned on themselves. */
  for (const ind of levelSources(plan)) {
    if (addIndicator(ind)) indicators.push(ind);
  }

  return { overlayIds, indicators };
}

export function erasePlan(
  chart: Chart,
  handle: PlanOverlayHandle,
  removeIndicator: (name: string) => void
): void {
  for (const id of handle.overlayIds) chart.removeOverlay({ id } as any);
  for (const ind of handle.indicators) removeIndicator(ind);
}
