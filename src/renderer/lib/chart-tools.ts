/**
 * Custom KLineChart indicators and overlays for the Research surface.
 *
 * KLineChart ships candles, ~25 indicators and a full drawing-overlay set
 * (trendlines, channels, fib, Elliott wave counts, gann). What it does not
 * ship — and what a discretionary trader actually needs — is VWAP, anchored
 * VWAP, a position/risk tool, and a measure tool. Those are registered here.
 *
 * Everything in this file is display-only. Nothing registered here can place,
 * size, or price an order; the position tool computes a *suggested* size from
 * the session's paper balance and hands it to you, not to the engine.
 */
import {
  registerIndicator,
  registerOverlay,
  type IndicatorTemplate,
  type KLineData,
  type OverlayTemplate,
} from "klinecharts";

/* ── Colour tokens (kept in sync with index.css) ─────────────────────── */
const C = {
  up: "#2FCC8B",
  down: "#F2566A",
  accent: "#22D3EE",
  caution: "#FF8A3D",
  ai: "#8B5CF6",
  aiBright: "#a78bfa",
  text: "#E8EDF4",
  dim: "#9AA7B8",
  faint: "#667284",
  grid: "#202834",
  panel: "#0C1016",
};

const typical = (k: KLineData) => (k.high + k.low + k.close) / 3;

/* ── VWAP (session-anchored, resets each UTC day) ────────────────────── */

const vwap: IndicatorTemplate<{ vwap?: number }> = {
  name: "VWAP",
  shortName: "VWAP",
  precision: 6,
  shouldOhlc: true,
  figures: [{ key: "vwap", title: "VWAP: ", type: "line" }],
  calc: (dataList) => {
    let cumPV = 0;
    let cumV = 0;
    let day = -1;

    return dataList.map((k) => {
      // Reset at each UTC day boundary — an intraday VWAP that never resets
      // is just a slow moving average and stops meaning anything.
      const d = Math.floor(k.timestamp / 86_400_000);
      if (d !== day) {
        day = d;
        cumPV = 0;
        cumV = 0;
      }
      const vol = k.volume ?? 0;
      cumPV += typical(k) * vol;
      cumV += vol;
      return { vwap: cumV > 0 ? cumPV / cumV : undefined };
    });
  },
};

/* ── Anchored / fixed-range VWAP ─────────────────────────────────────── */

/**
 * calcParams: [anchorTimestamp, endTimestamp]
 *   - anchor only  → anchored VWAP, runs to the live bar
 *   - anchor + end → fixed-range VWAP, frozen after `end`
 *
 * Anchor to a swing high, a news candle, or a range's start; the line is the
 * average price everyone in that window actually paid, which is what makes it
 * a support/resistance level rather than a smoothing.
 */
const avwap: IndicatorTemplate<{ avwap?: number }> = {
  name: "AVWAP",
  shortName: "AVWAP",
  precision: 6,
  shouldOhlc: true,
  calcParams: [0, 0],
  figures: [{ key: "avwap", title: "AVWAP: ", type: "line" }],
  calc: (dataList, indicator) => {
    const [anchor = 0, end = 0] = (indicator.calcParams ?? []) as number[];
    let cumPV = 0;
    let cumV = 0;
    let frozen: number | undefined;

    return dataList.map((k) => {
      if (!anchor || k.timestamp < anchor) return {};
      if (end && k.timestamp > end) return { avwap: frozen };

      const vol = k.volume ?? 0;
      cumPV += typical(k) * vol;
      cumV += vol;
      frozen = cumV > 0 ? cumPV / cumV : undefined;
      return { avwap: frozen };
    });
  },
};

/* ── Position tool ───────────────────────────────────────────────────── */

/** Set by the Research page so the tool can size against real paper cash. */
let accountEquity = 0;
/** Risk budget per trade, as a fraction of equity. */
let riskFraction = 0.01;

export function setPositionToolContext(equity: number, riskPct: number): void {
  accountEquity = equity;
  riskFraction = Math.max(0, riskPct) / 100;
}

/**
 * Three clicks: entry, stop, target. Draws the risk box below/above the entry
 * and the reward box opposite it, then labels R:R and a suggested size.
 *
 * The size is deliberately advisory. It is computed from the session's paper
 * balance and the distance to your stop; nothing downstream reads it, and the
 * execution path (when it exists) will size from the compiled spec, not from
 * a drawing on a chart.
 */
const positionTool: OverlayTemplate = {
  name: "positionTool",
  totalStep: 4,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, overlay, precision }) => {
    if (coordinates.length < 2) return [];

    const pts = overlay.points ?? [];
    const entry = pts[0]?.value ?? 0;
    const stop = pts[1]?.value ?? 0;
    const target = pts[2]?.value ?? stop;

    const [pEntry, pStop, pTarget] = coordinates;
    if (!pEntry || !pStop) return [];

    const isLong = stop < entry;
    const risk = Math.abs(entry - stop);
    const reward = pTarget ? Math.abs(target - entry) : 0;
    const rr = risk > 0 ? reward / risk : 0;

    // Size so that a stop-out costs exactly the risk budget.
    const riskCash = accountEquity * riskFraction;
    const qty = risk > 0 ? riskCash / risk : 0;
    const notional = qty * entry;

    const left = Math.min(pEntry.x, (pTarget ?? pStop).x);
    const right = Math.max(pEntry.x, (pTarget ?? pStop).x);
    const width = Math.max(40, right - left);

    const figures: any[] = [
      // risk box (entry → stop)
      {
        type: "rect",
        attrs: { x: left, y: Math.min(pEntry.y, pStop.y), width, height: Math.abs(pStop.y - pEntry.y) },
        styles: { style: "stroke_fill", color: "rgba(242,86,106,0.12)", borderColor: C.down, borderSize: 1 },
      },
      {
        type: "text",
        attrs: {
          x: left + 6,
          y: (pEntry.y + pStop.y) / 2 - 7,
          text: `risk ${risk.toFixed(precision.price)} · ${((risk / entry) * 100).toFixed(2)}%`,
          baseline: "middle",
        },
        styles: { color: C.down, size: 11, family: "IBM Plex Mono, monospace" },
      },
      // entry line
      {
        type: "line",
        attrs: { coordinates: [{ x: left, y: pEntry.y }, { x: left + width, y: pEntry.y }] },
        styles: { color: C.accent, size: 1 },
      },
      {
        type: "text",
        attrs: {
          x: left + 6,
          y: pEntry.y - 9,
          text: `${isLong ? "LONG" : "SHORT"} entry ${entry.toFixed(precision.price)}`,
          baseline: "bottom",
        },
        styles: { color: C.accent, size: 11, family: "IBM Plex Mono, monospace" },
      },
    ];

    if (pTarget) {
      figures.push(
        {
          type: "rect",
          attrs: { x: left, y: Math.min(pEntry.y, pTarget.y), width, height: Math.abs(pTarget.y - pEntry.y) },
          styles: { style: "stroke_fill", color: "rgba(47,204,139,0.12)", borderColor: C.up, borderSize: 1 },
        },
        {
          type: "text",
          attrs: {
            x: left + 6,
            y: (pEntry.y + pTarget.y) / 2 - 7,
            text: `reward ${reward.toFixed(precision.price)} · R ${rr.toFixed(2)}`,
            baseline: "middle",
          },
          styles: { color: C.up, size: 11, family: "IBM Plex Mono, monospace" },
        },
        {
          type: "text",
          attrs: {
            x: left + 6,
            y: Math.max(pEntry.y, pStop.y, pTarget.y) + 6,
            text:
              accountEquity > 0
                ? `size ≈ ${qty.toPrecision(4)} (${notional.toFixed(2)} notional, risking ${riskCash.toFixed(2)}) · advisory only`
                : "no paper balance loaded — size unavailable",
            baseline: "top",
          },
          styles: { color: C.dim, size: 10.5, family: "IBM Plex Mono, monospace" },
        }
      );
    }

    return figures;
  },
};

/* ── Measure tool ────────────────────────────────────────────────────── */

/** Two clicks: shows price delta, percentage, and bar count between them. */
const measureTool: OverlayTemplate = {
  name: "measureTool",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, overlay, precision, barSpace }) => {
    if (coordinates.length < 2) return [];
    const a = overlay.points?.[0];
    const b = overlay.points?.[1];
    const [pa, pb] = coordinates;
    if (!a || !b || !pa || !pb) return [];

    const delta = (b.value ?? 0) - (a.value ?? 0);
    const pct = a.value ? (delta / a.value) * 100 : 0;
    const bars = barSpace?.bar ? Math.round(Math.abs(pb.x - pa.x) / barSpace.bar) : 0;
    const up = delta >= 0;

    return [
      {
        type: "rect",
        attrs: {
          x: Math.min(pa.x, pb.x),
          y: Math.min(pa.y, pb.y),
          width: Math.abs(pb.x - pa.x),
          height: Math.abs(pb.y - pa.y),
        },
        styles: {
          style: "stroke_fill",
          color: up ? "rgba(47,204,139,0.10)" : "rgba(242,86,106,0.10)",
          borderColor: up ? C.up : C.down,
          borderSize: 1,
          borderStyle: "dashed",
        },
      },
      {
        type: "text",
        attrs: {
          x: (pa.x + pb.x) / 2,
          y: Math.min(pa.y, pb.y) - 6,
          text: `${up ? "+" : ""}${delta.toFixed(precision.price)}  ${pct.toFixed(2)}%  ${bars} bars`,
          align: "center",
          baseline: "bottom",
        },
        styles: { color: up ? C.up : C.down, size: 11, family: "IBM Plex Mono, monospace" },
      },
    ];
  },
};

/* ── Wave counts (Elliott) ───────────────────────────────────────────── */

/**
 * KLineChart v9 ships 15 overlays — lines, channels, one fib tool and two
 * annotations. Wave counts, harmonics and shapes are NOT among them (they
 * arrive in v10 / Pro), so they're built here.
 *
 * A wave count is a polyline through n points with each pivot labelled. The
 * labels are the whole point: an unlabelled zigzag tells you nothing about
 * which degree you think you're counting.
 */
function waveOverlay(name: string, labels: string[]): OverlayTemplate {
  return {
    name,
    totalStep: labels.length + 1,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates }) => {
      if (coordinates.length < 2) return [];

      const figures: any[] = [
        {
          type: "line",
          attrs: { coordinates },
          styles: { color: C.ai, size: 1 },
        },
      ];

      // Label every pivot after the origin: 1,2,3… or A,B,C…
      coordinates.forEach((c, i) => {
        if (i === 0) return;
        const label = labels[i - 1] ?? String(i);
        const prev = coordinates[i - 1]!;
        const goingUp = c.y < prev.y;
        figures.push({
          type: "text",
          attrs: {
            x: c.x,
            y: goingUp ? c.y - 6 : c.y + 6,
            text: label,
            align: "center",
            baseline: goingUp ? "bottom" : "top",
          },
          styles: { color: C.aiBright, size: 12, weight: "bold", family: "IBM Plex Mono, monospace" },
        });
      });

      return figures;
    },
  };
}

/* ── Shapes ──────────────────────────────────────────────────────────── */

const rectOverlay: OverlayTemplate = {
  name: "rect",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    if (!a || !b) return [];
    return [
      {
        type: "rect",
        attrs: {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x),
          height: Math.abs(b.y - a.y),
        },
        styles: { style: "stroke_fill", color: "rgba(34,211,238,0.08)", borderColor: C.accent, borderSize: 1 },
      },
    ];
  },
};

const circleOverlay: OverlayTemplate = {
  name: "circle",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    return [
      {
        type: "circle",
        attrs: { x: a.x, y: a.y, r },
        styles: { style: "stroke_fill", color: "rgba(34,211,238,0.06)", borderColor: C.accent, borderSize: 1 },
      },
    ];
  },
};

const triangleOverlay: OverlayTemplate = {
  name: "triangle",
  totalStep: 4,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    return [
      {
        type: "polygon",
        attrs: { coordinates },
        styles: { style: "stroke_fill", color: "rgba(34,211,238,0.07)", borderColor: C.accent, borderSize: 1 },
      },
    ];
  },
};

/* ── Fibonacci extension ─────────────────────────────────────────────── */

const FIB_EXT_LEVELS = [0, 0.618, 1, 1.618, 2.618, 4.236];

/** Three clicks (A, B, C): projects B−A from C. */
const fibExtension: OverlayTemplate = {
  name: "fibonacciExtension",
  totalStep: 4,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, overlay, precision, bounding }) => {
    if (coordinates.length < 3) return [];
    const pts = overlay.points ?? [];
    const a = pts[0]?.value ?? 0;
    const b = pts[1]?.value ?? 0;
    const c = pts[2]?.value ?? 0;
    const [pa, , pc] = coordinates;
    if (!pa || !pc) return [];

    const move = b - a;
    const width = bounding?.width ?? 0;

    return FIB_EXT_LEVELS.flatMap((lvl) => {
      const price = c + move * lvl;
      // Map price back to a y coordinate by interpolating the known anchors.
      const priceRange = (pts[1]?.value ?? 0) - (pts[0]?.value ?? 0);
      const pxRange = (coordinates[1]?.y ?? 0) - pa.y;
      if (priceRange === 0) return [];
      const y = pa.y + ((price - a) / priceRange) * pxRange;

      return [
        {
          type: "line",
          attrs: { coordinates: [{ x: pc.x, y }, { x: width, y }] },
          styles: { color: lvl === 1 ? C.caution : C.dim, size: 1, style: "dashed" },
        },
        {
          type: "text",
          attrs: { x: pc.x + 4, y: y - 2, text: `${lvl} · ${price.toFixed(precision.price)}`, baseline: "bottom" },
          styles: { color: lvl === 1 ? C.caution : C.faint, size: 10, family: "IBM Plex Mono, monospace" },
        },
      ];
    });
  },
};

/* ── Arrow ───────────────────────────────────────────────────────────── */

const arrowOverlay: OverlayTemplate = {
  name: "arrow",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    if (!a || !b) return [];

    // Arrowhead: two short lines back from the tip at ±30° to the shaft.
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = 10;
    const wing = (offset: number) => ({
      x: b.x - head * Math.cos(angle - offset),
      y: b.y - head * Math.sin(angle - offset),
    });

    return [
      { type: "line", attrs: { coordinates: [a, b] }, styles: { color: C.accent, size: 2 } },
      {
        type: "line",
        attrs: { coordinates: [wing(Math.PI / 6), b, wing(-Math.PI / 6)] },
        styles: { color: C.accent, size: 2 },
      },
    ];
  },
};

/* ── Free-form wave count ────────────────────────────────────────────── */

/** Up to 12 pivots, numbered as you place them — for counts that don't fit
 *  the standard 3/5/8 shapes (diagonals, complex corrections, WXY). */
const anyWaves: OverlayTemplate = {
  name: "anyWaves",
  totalStep: 13,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    const figures: any[] = [
      { type: "line", attrs: { coordinates }, styles: { color: C.ai, size: 1 } },
    ];
    coordinates.forEach((c, i) => {
      if (i === 0) return;
      const prev = coordinates[i - 1]!;
      const up = c.y < prev.y;
      figures.push({
        type: "text",
        attrs: { x: c.x, y: up ? c.y - 6 : c.y + 6, text: String(i), align: "center", baseline: up ? "bottom" : "top" },
        styles: { color: C.aiBright, size: 12, weight: "bold", family: "IBM Plex Mono, monospace" },
      });
    });
    return figures;
  },
};

/* ── Gann box ────────────────────────────────────────────────────────── */

const GANN_RATIOS = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];

/** Two clicks define the box; price and time are divided by the same ratios,
 *  which is the point of Gann — squaring one against the other. */
const gannBox: OverlayTemplate = {
  name: "gannBox",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);

    const figures: any[] = [];
    for (const r of GANN_RATIOS) {
      const y = y0 + (y1 - y0) * r;
      const x = x0 + (x1 - x0) * r;
      const emphasis = r === 0.5 ? C.caution : C.dim;
      figures.push(
        {
          type: "line",
          attrs: { coordinates: [{ x: x0, y }, { x: x1, y }] },
          styles: { color: emphasis, size: 1, style: "dashed" },
        },
        {
          type: "line",
          attrs: { coordinates: [{ x, y: y0 }, { x, y: y1 }] },
          styles: { color: emphasis, size: 1, style: "dashed" },
        }
      );
    }
    // The 1×1 diagonal — Gann's "angle of time and price in balance".
    figures.push({
      type: "line",
      attrs: { coordinates: [a, b] },
      styles: { color: C.accent, size: 1 },
    });
    return figures;
  },
};

/* ── Fibonacci circle ────────────────────────────────────────────────── */

const FIB_CIRCLE_LEVELS = [0.382, 0.5, 0.618, 1, 1.618];

const fibCircle: OverlayTemplate = {
  name: "fibonacciCircle",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const base = Math.hypot(b.x - a.x, b.y - a.y);
    return FIB_CIRCLE_LEVELS.map((lvl) => ({
      type: "circle",
      attrs: { x: a.x, y: a.y, r: base * lvl },
      styles: {
        style: "stroke",
        borderColor: lvl === 1 ? C.caution : C.dim,
        borderSize: 1,
        borderStyle: "dashed",
      },
    }));
  },
};

/* ── Registration ────────────────────────────────────────────────────── */

/* ── CVD: main computes, the chart renders ───────────────────────────── */

/**
 * Values supplied by main, keyed by bar timestamp.
 *
 * **This indicator does not compute CVD, and must not.** The previous version
 * did: `delta = close >= open ? +volume : −volume` — "the bar closed green, so
 * call all of it buying". That is not volume delta. It has nothing to do with
 * which side was the aggressor, it was available for every bar (so it never
 * looked absent), and a trader would read divergences off a line that was
 * measuring candle colour. Real delta needs `taker_buy_volume`, which only
 * main has, and which is genuinely **unknown** for bars cached before schema
 * v11 — an honest CVD has gaps, and this one shows them.
 */
const cvdValues = new Map<number, number | null>();
let cvdVersion = 0;

/** Feed the chart main's CVD. Returns the version to pass as `calcParams`, so
 *  `overrideIndicator` actually forces a recalculation — KLineChart caches on
 *  params, and identical params mean the stale series stays on screen. */
export function setCvdSeries(points: { timestamp: number; cvd: number | null }[]): number {
  cvdValues.clear();
  for (const p of points) cvdValues.set(p.timestamp, p.cvd);
  return ++cvdVersion;
}

export function clearCvdSeries(): void {
  cvdValues.clear();
  cvdVersion++;
}

const cvdIndicator: IndicatorTemplate<{ cvd?: number }> = {
  name: "CVD",
  shortName: "CVD",
  precision: 2,
  calcParams: [0],
  figures: [{ key: "cvd", title: "CVD: ", type: "line" }],
  /* A join, not a computation. A bar main could not compute yields an empty
     object rather than a number, so the line breaks where the aggressor split
     is unknown instead of drawing through the gap. */
  calc: (dataList) =>
    dataList.map((k) => {
      const v = cvdValues.get(k.timestamp);
      return v === null || v === undefined ? {} : { cvd: v };
    }),
};

let registered = false;

/** Idempotent: KLineChart registries are global, React StrictMode is not. */
export function registerChartTools(): void {
  if (registered) return;
  registered = true;

  registerIndicator(vwap);
  registerIndicator(avwap);
  registerIndicator(cvdIndicator);

  registerOverlay(positionTool);
  registerOverlay(measureTool);

  // Shapes and Fib extension — not in v9 core.
  registerOverlay(rectOverlay);
  registerOverlay(circleOverlay);
  registerOverlay(triangleOverlay);
  registerOverlay(arrowOverlay);
  registerOverlay(fibExtension);
  registerOverlay(fibCircle);
  registerOverlay(gannBox);
  registerOverlay(anyWaves);

  // Elliott wave counts, impulse and corrective.
  registerOverlay(waveOverlay("threeWaves", ["A", "B", "C"]));
  registerOverlay(waveOverlay("fiveWaves", ["1", "2", "3", "4", "5"]));
  registerOverlay(waveOverlay("eightWaves", ["1", "2", "3", "4", "5", "A", "B", "C"]));
  registerOverlay(waveOverlay("abcd", ["A", "B", "C", "D"]));
  registerOverlay(waveOverlay("xabcd", ["X", "A", "B", "C", "D"]));
}

/* ── Tool catalogue (drives the toolbar) ─────────────────────────────── */

export interface ToolDef {
  id: string;
  label: string;
  /** KLineChart overlay name. */
  overlay: string;
  group: "line" | "channel" | "fib" | "wave" | "shape" | "tool";
}

/**
 * Every tool here is verified to exist — either shipped by KLineChart v9 or
 * registered above. An earlier version of this list named overlays from the
 * library's docs that v9 does not actually ship (Gann, fib circle/spiral,
 * waves), so those buttons silently did nothing when clicked.
 */
export const TOOLS: ToolDef[] = [
  // Built in to v9
  { id: "trend", label: "Trend line", overlay: "segment", group: "line" },
  { id: "ray", label: "Ray", overlay: "rayLine", group: "line" },
  { id: "extended", label: "Extended line", overlay: "straightLine", group: "line" },
  { id: "hline", label: "Horizontal line", overlay: "horizontalStraightLine", group: "line" },
  { id: "hray", label: "Horizontal ray", overlay: "horizontalRayLine", group: "line" },
  { id: "hseg", label: "Horizontal segment", overlay: "horizontalSegment", group: "line" },
  { id: "vline", label: "Vertical line", overlay: "verticalStraightLine", group: "line" },
  { id: "vray", label: "Vertical ray", overlay: "verticalRayLine", group: "line" },
  { id: "price", label: "Price line", overlay: "priceLine", group: "line" },

  { id: "parallel", label: "Parallel channel", overlay: "parallelStraightLine", group: "channel" },
  { id: "channel", label: "Price channel", overlay: "priceChannelLine", group: "channel" },

  { id: "fib", label: "Fib retracement", overlay: "fibonacciLine", group: "fib" },
  // Registered here (see fibExtension above)
  { id: "fibext", label: "Fib extension", overlay: "fibonacciExtension", group: "fib" },
  { id: "fibcircle", label: "Fib circle", overlay: "fibonacciCircle", group: "fib" },
  { id: "gann", label: "Gann box", overlay: "gannBox", group: "fib" },

  // Registered here — wave counts with labelled pivots
  { id: "wave5", label: "Five waves (impulse)", overlay: "fiveWaves", group: "wave" },
  { id: "wave3", label: "Three waves (A-B-C)", overlay: "threeWaves", group: "wave" },
  { id: "wave8", label: "Eight waves (full cycle)", overlay: "eightWaves", group: "wave" },
  { id: "abcd", label: "ABCD", overlay: "abcd", group: "wave" },
  { id: "xabcd", label: "XABCD", overlay: "xabcd", group: "wave" },
  { id: "waveany", label: "Free count (up to 12)", overlay: "anyWaves", group: "wave" },

  // Registered here
  { id: "rect", label: "Rectangle", overlay: "rect", group: "shape" },
  { id: "circle", label: "Circle", overlay: "circle", group: "shape" },
  { id: "triangle", label: "Triangle", overlay: "triangle", group: "shape" },
  { id: "arrow", label: "Arrow", overlay: "arrow", group: "shape" },
  { id: "note", label: "Note", overlay: "simpleAnnotation", group: "shape" },
  { id: "tag", label: "Price tag", overlay: "simpleTag", group: "shape" },

  { id: "position", label: "Position (long/short)", overlay: "positionTool", group: "tool" },
  { id: "measure", label: "Measure", overlay: "measureTool", group: "tool" },
];

/**
 * Indicators, with their editable parameters.
 *
 * `params` names each slot in KLineChart's `calcParams` array so the UI can
 * offer real inputs — an RSI you can't retune is barely an indicator. Defaults
 * match the library's own.
 */
export interface IndicatorDef {
  name: string;
  label: string;
  /** Labels for each calcParams slot, in order. Empty = no parameters. */
  params: string[];
  defaults: number[];
}

export const OVERLAY_INDICATORS: IndicatorDef[] = [
  { name: "MA", label: "Moving averages", params: ["Fast", "Mid", "Slow"], defaults: [5, 10, 30] },
  { name: "EMA", label: "EMA", params: ["Fast", "Mid", "Slow"], defaults: [6, 12, 20] },
  { name: "SMA", label: "SMA", params: ["Period", "Weight"], defaults: [12, 2] },
  { name: "BOLL", label: "Bollinger bands", params: ["Period", "Std dev"], defaults: [20, 2] },
  { name: "SAR", label: "Parabolic SAR", params: ["Start", "Step", "Max"], defaults: [2, 2, 20] },
  { name: "BBI", label: "BBI", params: ["P1", "P2", "P3", "P4"], defaults: [3, 6, 12, 24] },
  { name: "VWAP", label: "VWAP (daily reset)", params: [], defaults: [] },
];

export const PANE_INDICATORS: IndicatorDef[] = [
  { name: "VOL", label: "Volume", params: ["MA1", "MA2", "MA3"], defaults: [5, 10, 20] },
  { name: "RSI", label: "RSI", params: ["Fast", "Mid", "Slow"], defaults: [6, 12, 24] },
  { name: "MACD", label: "MACD", params: ["Fast", "Slow", "Signal"], defaults: [12, 26, 9] },
  { name: "KDJ", label: "Stochastic (KDJ)", params: ["K", "D", "J"], defaults: [9, 3, 3] },
  { name: "OBV", label: "OBV", params: ["MA period"], defaults: [30] },
  { name: "CCI", label: "CCI", params: ["Period"], defaults: [13] },
  { name: "DMI", label: "ADX / DMI", params: ["Period", "Smoothing"], defaults: [14, 6] },
  { name: "WR", label: "Williams %R", params: ["P1", "P2", "P3"], defaults: [6, 10, 14] },
  { name: "ROC", label: "Rate of change", params: ["Period", "MA"], defaults: [12, 6] },
  { name: "TRIX", label: "TRIX", params: ["Period", "MA"], defaults: [12, 20] },
  { name: "AO", label: "Awesome oscillator", params: ["Short", "Long"], defaults: [5, 34] },
  { name: "PSY", label: "Psychological line", params: ["Period", "MA"], defaults: [12, 6] },
  { name: "CVD", label: "Cumulative Volume Delta (CVD)", params: [], defaults: [] },
];

export const ALL_INDICATORS = [...OVERLAY_INDICATORS, ...PANE_INDICATORS];

export const CHART_THEME = C;
