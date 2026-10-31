/**
 * The Research chart's layout — which indicators are on, and their parameters.
 *
 * **It used to be React state only**, so tuning RSI to 7 and reopening the app
 * put it back to 14 with nothing said. A setting that silently does not stick
 * is the same family as a control that does not control: you believe you
 * configured something and you did not.
 *
 * Stored in localStorage, following `density.ts`: this is a per-machine display
 * preference that **no engine reads**. Nothing here changes a number the app
 * produces — a strategy's RSI period comes from its spec, and a plan's levels
 * come from the resolver. Routing it through IPC would buy nothing and would
 * paint the default layout first, then visibly swap it.
 *
 * Drawings are deliberately NOT here. They live in `chart_drawings` (schema v9)
 * because a drawing can be promoted into a level a plan triggers on, and
 * something the engine can act on belongs in the database, not in a browser
 * store that a cache clear would wipe.
 *
 * One saved layout, applied to every symbol — TradingView's "default template".
 * Named per-symbol templates are a further step and are not this.
 */

export interface ChartLayout {
  /** Indicators drawn over the price pane, e.g. MA, BOLL, AVWAP. */
  overlays: string[];
  /** Indicators in their own sub-pane, e.g. VOL, RSI, CVD. */
  panes: string[];
  /** name → calcParams. Absent means "use the indicator's defaults". */
  params: Record<string, number[]>;
}

const KEY = "research_chart_layout";

export const DEFAULT_LAYOUT: ChartLayout = {
  overlays: ["MA"],
  panes: ["VOL"],
  params: {},
};

/**
 * Read the saved layout.
 *
 * Anything malformed falls back to the default rather than throwing: a corrupt
 * preference must not stop the chart rendering, and the worst case here is that
 * the trader re-adds an indicator.
 */
export function loadChartLayout(): ChartLayout {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<ChartLayout>;
    return {
      overlays: Array.isArray(parsed.overlays) ? parsed.overlays.filter((v) => typeof v === "string") : DEFAULT_LAYOUT.overlays,
      panes: Array.isArray(parsed.panes) ? parsed.panes.filter((v) => typeof v === "string") : DEFAULT_LAYOUT.panes,
      params: isParamMap(parsed.params) ? parsed.params : {},
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveChartLayout(layout: ChartLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* Quota or a disabled store. Losing a display preference is not worth
       interrupting a chart over. */
  }
}

/** Back to the shipped defaults. */
export function resetChartLayout(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* as above */
  }
}

function isParamMap(v: unknown): v is Record<string, number[]> {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).every(
    (arr) => Array.isArray(arr) && arr.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}
