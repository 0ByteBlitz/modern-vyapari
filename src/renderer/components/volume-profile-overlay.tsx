/**
 * Volume profile drawn over the price pane (roadmap S1-4).
 *
 * **Rendering only.** Every number — bins, POC, VAH, VAL — is computed in main
 * (`insights/orderflow-service.ts`) and arrives over IPC. This component maps
 * prices to pixels and draws; it never bins volume itself. Two implementations
 * of VAH is the bug class this project has already paid for three times, and a
 * profile the trader draws on must be the profile the engine resolves against.
 *
 * It is an SVG layer rather than a KLineChart overlay because KLineChart v9
 * has no profile primitive and its overlays are anchored to *drawn points*; a
 * profile is anchored to a price axis and a window. Price→pixel goes through
 * the chart's own `convertToPixel`, so the histogram stays registered to the
 * candles through every zoom and scroll.
 *
 * The label always says the profile is candle-derived. A profile from OHLCV
 * spreads each bar's volume across its range by a rule instead of placing it
 * where it actually traded, and the rule materially moves the POC — a trader
 * who thinks they are looking at a real profile will size differently from one
 * who knows it is an estimate.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionType, type Chart } from "klinecharts";
import { api, isError, errorText } from "@/lib/api";
import type { VolumeProfileView } from "@/lib/api";

interface Props {
  chart: Chart | null;
  symbol: string;
  intervalMin: number;
  /** Window start. Null = the whole cached range the chart is showing. */
  fromMs: number | null;
  toMs: number | null;
  /** Bumped by the parent to force a refetch (e.g. after new candles land). */
  refreshKey?: number;
  onError?: (message: string) => void;
}

/** Width of the histogram as a share of the pane, measured from the right. */
const PANE_SHARE = 0.22;

export function VolumeProfileOverlay({
  chart,
  symbol,
  intervalMin,
  fromMs,
  toMs,
  refreshKey = 0,
  onError,
}: Props) {
  const [profile, setProfile] = useState<VolumeProfileView | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** Incremented on zoom/scroll purely to force a re-render, since the pixel
   *  positions come from the chart rather than from React state. */
  const [, setTick] = useState(0);

  /* ── Data ─────────────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const res = await api.getVolumeProfile({
        symbol,
        intervalMin,
        ...(fromMs !== null ? { fromMs } : {}),
        ...(toMs !== null ? { toMs } : {}),
      });
      if (cancelled) return;
      if (isError(res)) {
        setProfile(null);
        onError?.(errorText(res));
        return;
      }
      setProfile(res);
    })();

    return () => {
      cancelled = true;
    };
    // `onError` is intentionally excluded: a parent that recreates the callback
    // each render would otherwise refetch the profile on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, intervalMin, fromMs, toMs, refreshKey]);

  /* ── Redraw triggers ──────────────────────────────────────────────── */

  useEffect(() => {
    if (!chart) return;
    const bump = () => setTick((t) => t + 1);
    chart.subscribeAction(ActionType.OnZoom, bump);
    chart.subscribeAction(ActionType.OnScroll, bump);
    return () => {
      chart.unsubscribeAction(ActionType.OnZoom, bump);
      chart.unsubscribeAction(ActionType.OnScroll, bump);
    };
  }, [chart]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      setSize({ width: r.width, height: r.height });
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  /** Price → y within the price pane, via the chart's own scale. */
  const yOf = useCallback(
    (price: number): number | null => {
      if (!chart) return null;
      try {
        const p = (chart as unknown as {
          convertToPixel: (v: unknown, f: unknown) => { y?: number } | Array<{ y?: number }>;
        }).convertToPixel({ value: price }, { paneId: "candle_pane" });
        const point = Array.isArray(p) ? p[0] : p;
        const y = point?.y;
        return typeof y === "number" && Number.isFinite(y) ? y : null;
      } catch {
        return null;
      }
    },
    [chart]
  );

  if (!profile || size.width === 0) {
    return <div ref={hostRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />;
  }

  const maxVol = profile.bins.reduce((m, b) => (b.volume > m ? b.volume : m), 0);
  const histWidth = size.width * PANE_SHARE;
  const right = size.width;

  const pocY = yOf(profile.poc);
  const vahY = yOf(profile.vah);
  const valY = yOf(profile.val);

  return (
    <div ref={hostRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <svg width={size.width} height={size.height} style={{ display: "block" }}>
        {profile.bins.map((bin, i) => {
          const top = yOf(bin.high);
          const bottom = yOf(bin.low);
          if (top === null || bottom === null) return null;

          const h = Math.max(1, Math.abs(bottom - top) - 0.5);
          const y = Math.min(top, bottom);
          if (y + h < 0 || y > size.height) return null; // scrolled out of view

          const w = maxVol > 0 ? (bin.volume / maxVol) * histWidth : 0;
          const inValueArea = bin.low >= profile.val - 1e-9 && bin.high <= profile.vah + 1e-9;

          /* Buy/sell split is drawn only when EVERY contributing bar had a
             known aggressor split. A partial split rendered as a proportion
             would look precise and be wrong by exactly the bars that couldn't
             be read, so it degrades to one neutral bar instead. */
          const buyW =
            bin.buyVolume !== null && bin.volume > 0 ? (bin.buyVolume / bin.volume) * w : null;

          return (
            <g key={i}>
              <rect
                x={right - w}
                y={y}
                width={w}
                height={h}
                fill={
                  i === profile.pocBinIndex
                    ? "var(--accent)"
                    : inValueArea
                      ? "var(--muted-foreground)"
                      : "var(--text-ghost)"
                }
                opacity={i === profile.pocBinIndex ? 0.55 : inValueArea ? 0.34 : 0.22}
              />
              {buyW !== null && (
                <rect x={right - buyW} y={y} width={buyW} height={h} fill="var(--up)" opacity={0.28} />
              )}
            </g>
          );
        })}

        {[
          { y: pocY, colour: "var(--accent)", label: "POC" },
          { y: vahY, colour: "var(--muted-foreground)", label: "VAH" },
          { y: valY, colour: "var(--muted-foreground)", label: "VAL" },
        ].map(
          ({ y, colour, label }) =>
            y !== null && (
              <g key={label}>
                <line
                  x1={right - histWidth}
                  x2={right}
                  y1={y}
                  y2={y}
                  stroke={colour}
                  strokeWidth={1}
                  strokeDasharray={label === "POC" ? undefined : "3 3"}
                  opacity={0.85}
                />
                <text
                  x={right - histWidth - 4}
                  y={y + 3}
                  textAnchor="end"
                  fill={colour}
                  style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9 }}
                >
                  {label}
                </text>
              </g>
            )
        )}

        <text
          x={right - histWidth}
          y={12}
          fill="var(--text-faint)"
          style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9 }}
        >
          profile · candle-derived · {profile.binWidth}
          {profile.deltaKnown ? "" : " · split unknown"}
        </text>
      </svg>
    </div>
  );
}
