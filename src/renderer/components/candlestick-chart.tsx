import { useEffect, useRef } from "react";
import { init, dispose, type Chart, type KLineData } from "klinecharts";
import type { Candle } from "@/lib/api";
import { priceDecimals } from "@/lib/format";
import { CHART_THEME, registerChartTools } from "@/lib/chart-tools";

/**
 * The app's one chart component — KLineChart everywhere.
 *
 * Previously the dashboard and workbench used lightweight-charts while
 * Research used KLineChart. Two libraries meant two themes, two precision
 * rules (the axis once read 0.09100000 while the tables showed 0.091), two
 * data adapters, and every fix applied twice. The API here is unchanged, so
 * callers didn't have to move.
 *
 * For the full drawing workspace — tools, indicators, replay — see
 * `pages/research-page.tsx`; this is the compact read-only view.
 */

/** An entry/exit arrow drawn on the price series. */
export interface TradeMarker {
  /** Epoch ms of the fill. */
  timeMs: number;
  kind: "entry" | "exit";
  text?: string;
  color?: string;
}

/** A horizontal level (stop, target, entry) drawn across the chart. */
export interface PriceLevel {
  price: number;
  label: string;
  color: string;
  dashed?: boolean;
}

interface CandlestickChartProps {
  candles: Candle[];
  /** Fixed pixel height, or "fill" to track the parent element's height. */
  height?: number | "fill";
  markers?: TradeMarker[];
  levels?: PriceLevel[];
  /** Show the volume sub-panel. Off for very short charts. */
  volume?: boolean;
  /**
   * Identity of the series — symbol and interval, typically.
   *
   * **Required for the chart to notice a different series.** Without it the
   * component has to guess from the data, and every guess available is wrong:
   * see the note on the data effect below.
   */
  seriesKey?: string;
}

function toKLineData(candles: Candle[]): KLineData[] {
  return candles.map((c) => ({
    timestamp: c.start,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume),
  }));
}

export function CandlestickChart({
  candles,
  height = 400,
  markers,
  levels,
  volume = true,
  seriesKey,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  /** Overlay ids we created, so a re-render replaces rather than stacks. */
  const overlayIds = useRef<string[]>([]);

  /* Create once per mount.
   *
   * **KLineChart does NOT track its container's size.** It measures once at
   * `init` and again on window resize — so with `height="fill"` the canvas
   * takes whatever the parent happened to be at that instant. In a flex layout
   * that is usually before the panel has settled, which left the Markets chart
   * frozen at its `minHeight` of 240px with the rest of the panel empty below
   * it: a chart occupying a third of its space, on a screen whose whole job is
   * showing price.
   *
   * A previous comment here claimed the library owned its own sizing and no
   * observer was needed. It doesn't, and one is. */
  useEffect(() => {
    registerChartTools();
    const el = containerRef.current;
    if (!el) return;

    const chart = init(el, {
      styles: {
        grid: {
          horizontal: { color: CHART_THEME.grid },
          vertical: { show: false },
        },
        candle: {
          bar: {
            upColor: CHART_THEME.up,
            downColor: CHART_THEME.down,
            upBorderColor: CHART_THEME.up,
            downBorderColor: CHART_THEME.down,
            upWickColor: CHART_THEME.up,
            downWickColor: CHART_THEME.down,
          },
          tooltip: { text: { family: "IBM Plex Mono, monospace", size: 11 } },
        },
        xAxis: {
          axisLine: { color: CHART_THEME.grid },
          tickLine: { color: CHART_THEME.grid },
          tickText: { color: CHART_THEME.faint, family: "IBM Plex Mono, monospace", size: 10 },
        },
        yAxis: {
          axisLine: { color: CHART_THEME.grid },
          tickLine: { color: CHART_THEME.grid },
          tickText: { color: CHART_THEME.faint, family: "IBM Plex Mono, monospace", size: 10 },
        },
        crosshair: {
          horizontal: { line: { color: CHART_THEME.dim }, text: { family: "IBM Plex Mono, monospace" } },
          vertical: { line: { color: CHART_THEME.dim }, text: { family: "IBM Plex Mono, monospace" } },
        },
        indicator: { tooltip: { text: { family: "IBM Plex Mono, monospace", size: 10 } } },
      },
    });

    if (!chart) return;
    chartRef.current = chart;
    if (volume) chart.createIndicator("VOL", false, { id: "pane_vol" });

    /* Track the container, not the window. The panel changes height when the
       drawer opens, a sibling grows, or the layout settles after mount — none
       of which fire a window resize. */
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);

    return () => {
      observer.disconnect();
      chartRef.current = null;
      overlayIds.current = [];
      dispose(el);
    };
  }, [volume]);

  /**
   * Data.
   *
   * **This used to decide "is this the same series?" by comparing array
   * LENGTH**, and that was the bug behind three separate symptoms: changing
   * the interval did nothing, changing the pair did nothing, and the chart
   * quietly kept whatever series it loaded first. The loader always fetches a
   * fixed window (120 bars), so a completely different symbol arrives with
   * exactly the same length as the one before it — indistinguishable from a
   * live tick, and the code took the "just patch the last bar" branch.
   *
   * Length is not identity. The caller knows the identity, so it passes it:
   * `seriesKey` changing means a new series and a wholesale replace. Within
   * one series the previous last bar is located in the incoming data and only
   * the bars from there on are applied — which patches a tick, appends new
   * bars, and **preserves the viewport**, so the owner's zoom and pan survive
   * every refresh. If that bar is missing the data has jumped, and a full
   * replace is the only honest option.
   */
  const prevKey = useRef<string | undefined>(undefined);
  const prevLastTs = useRef<number | null>(null);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;

    const data = toKLineData(candles);
    // Precision follows the app-wide rule so the axis matches every table.
    chart.setPriceVolumePrecision(priceDecimals(candles[candles.length - 1]!.close), 2);

    const changedSeries = seriesKey !== prevKey.current;
    const resumeAt =
      changedSeries || prevLastTs.current === null
        ? -1
        : data.findIndex((d) => d.timestamp === prevLastTs.current);

    if (resumeAt === -1) {
      chart.applyNewData(data);
    } else {
      for (let i = resumeAt; i < data.length; i++) chart.updateData(data[i]!);
    }

    prevKey.current = seriesKey;
    prevLastTs.current = data[data.length - 1]!.timestamp;
  }, [candles, seriesKey]);

  /* Markers and levels are overlays. Rebuilt wholesale on change — there are
     at most a handful and they're cheap. */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const id of overlayIds.current) chart.removeOverlay(id);
    overlayIds.current = [];

    for (const m of markers ?? []) {
      const id = chart.createOverlay({
        name: "simpleAnnotation",
        points: [{ timestamp: m.timeMs }],
        extendData: m.text ?? (m.kind === "entry" ? "Buy" : "Sell"),
        styles: {
          text: {
            color: m.color ?? (m.kind === "entry" ? CHART_THEME.up : CHART_THEME.down),
            size: 10,
            family: "IBM Plex Mono, monospace",
          },
        },
      } as any);
      if (typeof id === "string") overlayIds.current.push(id);
    }

    for (const l of levels ?? []) {
      if (!Number.isFinite(l.price)) continue;
      const id = chart.createOverlay({
        name: "priceLine",
        points: [{ value: l.price }],
        lock: true,
        styles: {
          line: { color: l.color, style: l.dashed === false ? "solid" : "dashed", size: 1 },
          text: { color: l.color, size: 10, family: "IBM Plex Mono, monospace" },
        },
      } as any);
      if (typeof id === "string") overlayIds.current.push(id);
    }
  }, [markers, levels]);

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-md border border-border"
      style={height === "fill" ? { height: "100%", minHeight: 240 } : { height }}
    />
  );
}
