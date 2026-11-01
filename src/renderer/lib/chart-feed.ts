import type { Chart, KLineData, Period } from "klinecharts";

/**
 * Push-style data for a KLineChart.
 *
 * KLineChart 10 only pulls: it asks a `DataLoader` for bars whenever the
 * symbol, period or loader changes, and hands the loader a callback for live
 * bars. Our data arrives the other way round — a fetched window, then ticks
 * from the stream — so this keeps the latest window and serves it on every
 * pull. Re-pulls are frequent (a precision change is a `setSymbol`, which
 * reloads), and each one must get the bars as they stand now, ticks included,
 * or a reload would rewind the chart to the last fetch.
 */
export interface ChartFeed {
  /** Replace the bars, and the series they belong to when it is given.
   *  Resets the viewport. */
  replace(bars: KLineData[], series?: { ticker: string; intervalMin: number; pricePrecision: number }): void;
  /** Patch the last bar or append a newer one. Keeps the viewport. */
  update(bar: KLineData): void;
}

/** The chart's period for an interval in minutes — it drives axis labels and
 *  where an overlay lands past the last bar, so it must be the real one. */
export function periodFor(intervalMin: number): Period {
  if (intervalMin % 1440 === 0) return { type: "day", span: intervalMin / 1440 };
  if (intervalMin % 60 === 0) return { type: "hour", span: intervalMin / 60 };
  return { type: "minute", span: intervalMin };
}

export function attachFeed(chart: Chart): ChartFeed {
  let bars: KLineData[] = [];
  let live: ((bar: KLineData) => void) | null = null;

  chart.setDataLoader({
    // A copy: the chart appends live bars to the array it is given, and so
    // does `update` below.
    getBars: ({ type, callback }) => callback(type === "init" ? bars.slice() : [], false),
    subscribeBar: ({ callback }) => {
      live = callback;
    },
    unsubscribeBar: () => {
      live = null;
    },
  });

  return {
    replace(next, series) {
      bars = next.slice();
      if (!series) {
        chart.resetData();
        return;
      }
      const { ticker, intervalMin, pricePrecision } = series;
      const symbol = chart.getSymbol();
      const period = chart.getPeriod();
      const nextPeriod = periodFor(intervalMin);
      const symbolChanged =
        symbol?.ticker !== ticker || symbol.pricePrecision !== pricePrecision || symbol.volumePrecision !== 2;
      const periodChanged = period?.type !== nextPeriod.type || period.span !== nextPeriod.span;
      // Each of these reloads from the loader on its own; with neither, ask.
      if (symbolChanged) chart.setSymbol({ ticker, pricePrecision, volumePrecision: 2 });
      if (periodChanged) chart.setPeriod(nextPeriod);
      if (!symbolChanged && !periodChanged) chart.resetData();
    },
    update(bar) {
      const last = bars[bars.length - 1];
      if (last && bar.timestamp === last.timestamp) bars[bars.length - 1] = bar;
      else if (!last || bar.timestamp > last.timestamp) bars.push(bar);
      else return;
      live?.(bar);
    },
  };
}
