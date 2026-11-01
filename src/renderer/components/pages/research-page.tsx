import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { init, dispose, ActionType, type Chart, type KLineData } from "klinecharts";
import {
  BarChart3,
  Bookmark,
  Bell,
  BellOff,
  Crosshair,
  Eraser,
  Layers,
  Lock,
  Magnet,
  Maximize2,
  MousePointer2,
  Play,
  Pause,
  Settings,
  SkipForward,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import { api, isError, type Session, type ChartDrawing, type AlertRecord, errorText } from "@/lib/api";
import {
  registerChartTools,
  setPositionToolContext,
  TOOLS,
  OVERLAY_INDICATORS,
  PANE_INDICATORS,
  ALL_INDICATORS,
  CHART_THEME,
  setCvdSeries,
  clearCvdSeries,
  type IndicatorDef,
} from "@/lib/chart-tools";
import { VolumeProfileOverlay } from "@/components/volume-profile-overlay";
import { LevelReferencesPanel } from "@/components/level-references-panel";
import { PlanDetail } from "@/components/plan-detail";
import { drawPlan, erasePlan, type PlanOverlayHandle } from "@/lib/plan-overlay";
import type { StoredPlanView } from "@/lib/api";
import { loadChartLayout, saveChartLayout, resetChartLayout, DEFAULT_LAYOUT } from "@/lib/chart-layout";
import { priceDecimals } from "@/lib/format";
import { describeThreshold } from "@shared/levels";

/**
 * Research — the surface for actually looking at a market.
 *
 * Built on KLineChart rather than the app's lightweight-charts because
 * discretionary research needs a drawing layer (trendlines, fib, Elliott
 * counts, position sizing), and lightweight-charts deliberately ships none.
 * Every chart in the app now uses KLineChart — one theme, one precision
 * rule, one data adapter.
 *
 * Data is the Binance analysis feed — the same cached history the indicators,
 * backtester and paper engine use, so what you draw on is what the engine
 * decided from.
 */
const INTERVALS: { label: string; min: number }[] = [
  { label: "1m", min: 1 },
  { label: "5m", min: 5 },
  { label: "15m", min: 15 },
  { label: "30m", min: 30 },
  { label: "1H", min: 60 },
  { label: "4H", min: 240 },
  { label: "1D", min: 1440 },
];

const TOOL_GROUPS: { id: string; label: string }[] = [
  { id: "line", label: "Lines" },
  { id: "channel", label: "Channels" },
  { id: "fib", label: "Fib & Gann" },
  { id: "wave", label: "Waves" },
  { id: "shape", label: "Shapes" },
  { id: "tool", label: "Tools" },
];

/**
 * One indicator row: a toggle, plus number inputs for its parameters.
 *
 * An indicator you can't retune isn't much use — RSI(14) and RSI(7) say
 * different things. Editing a value recomputes in place if the indicator is
 * already on the chart.
 */
function IndicatorSettingsModal({
  def,
  params,
  onParamChange,
  onClose,
  onReset,
}: {
  def: IndicatorDef;
  params: number[];
  onParamChange: (idx: number, val: string) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(4px)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 320,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 16,
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: "var(--text-base)" }}>
            <Settings size={16} style={{ color: "var(--accent)" }} />
            <span>{def.label} Settings</span>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-faint)", cursor: "pointer", padding: 4 }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {def.params.map((label, idx) => (
            <div
              key={label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: "var(--text-xs)",
              }}
            >
              <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>{label}</span>
              <input
                type="number"
                min={1}
                value={params[idx] ?? def.defaults[idx] ?? 0}
                onChange={(e) => onParamChange(idx, e.target.value)}
                style={{
                  width: 90,
                  background: "var(--surface-3)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--foreground)",
                  padding: "4px 8px",
                  fontSize: "var(--text-xs)",
                  fontFamily: "var(--font-mono)",
                }}
              />
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <button className="btn btn-secondary" style={{ fontSize: "var(--text-xs)" }} onClick={onReset}>
            Reset Defaults
          </button>
          <button className="btn btn-primary" style={{ fontSize: "var(--text-xs)" }} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function IndicatorRow({
  def,
  active,
  onToggle,
  onOpenSettings,
}: {
  def: IndicatorDef;
  active: boolean;
  onToggle: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div
      className={`ind-row ${active ? "ind-row-on" : ""}`}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: 6 }}
    >
      <button className="ind-row-toggle" onClick={onToggle} style={{ flex: 1, textAlign: "left" }}>
        {def.label}
        {active && <span className="ind-row-tick">✓</span>}
      </button>
      {active && def.params.length > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenSettings();
          }}
          style={{
            background: "none",
            border: "none",
            color: "var(--accent)",
            cursor: "pointer",
            padding: "4px 6px",
            display: "flex",
            alignItems: "center",
          }}
          title="Configure indicator parameters (TradingView pop-up)"
        >
          <Settings size={13} />
        </button>
      )}
    </div>
  );
}

export function ResearchPage({ activeSession }: { activeSession: Session | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  /** overlayId → drawings row id, so an edit updates rather than duplicates. */
  const overlayDb = useRef<Map<string, number>>(new Map());
  const symbolRef = useRef<string>("BTC-USD");
  const intervalRef = useRef<number>(60);
  /** Timestamp of the bar under the crosshair — the VWAP anchor. */
  const crosshairTs = useRef<number | null>(null);

  const [symbol, setSymbol] = useState(activeSession?.pair ?? "BTC-USD");
  const [intervalMin, setIntervalMin] = useState(60);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [magnet, setMagnet] = useState(true);
  const [locked, setLocked] = useState(false);
  /* Restored from the saved layout, not hardcoded — tuning an indicator and
     reopening the app used to put it back to defaults with nothing said. */
  const [panes, setPanes] = useState<string[]>(() => loadChartLayout().panes);
  const [overlays, setOverlays] = useState<string[]>(() => loadChartLayout().overlays);
  const [indicatorMenu, setIndicatorMenu] = useState(false);
  const [editingIndicator, setEditingIndicator] = useState<IndicatorDef | null>(null);
  /** Edited indicator parameters, keyed by indicator name. */
  const [indicatorParams, setIndicatorParams] = useState<Record<string, number[]>>(
    () => loadChartLayout().params
  );
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [alertsMenu, setAlertsMenu] = useState(false);
  const [replayIdx, setReplayIdx] = useState<number | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [status, setStatus] = useState("");
  /** Coverage of the CVD series currently on the chart, so a gap in the
   *  aggressor split is stated rather than silently drawn through. */
  const [cvdInfo, setCvdInfo] = useState<{ coverage: number; suggestedAnchor: number | null } | null>(null);
  /** Volume profile visibility. Off by default — it occupies the right of the
   *  price pane, and a tool that is always on stops being a decision. */
  const [showProfile, setShowProfile] = useState(false);
  /* Plan references (S2-2). Kept beside the drawings they were promoted from so
     the panel can offer only drawings that are not already a reference. */
  const [showRefs, setShowRefs] = useState(false);
  const [drawingList, setDrawingList] = useState<ChartDrawing[]>([]);
  const [refsKey, setRefsKey] = useState(0);
  const allDataRef = useRef<KLineData[]>([]);

  symbolRef.current = symbol;
  intervalRef.current = intervalMin;

  useEffect(() => {
    if (activeSession) setSymbol(activeSession.pair);
  }, [activeSession?.pair]);

  const alertOverlayIds = useRef<string[]>([]);

  const loadAlerts = useCallback(async () => {
    if (!activeSession) return;
    const res = await api.listAlerts(activeSession.id);
    if (!isError(res)) setAlerts(res);
  }, [activeSession?.id]);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  useEffect(() => {
    return api.onDataUpdated((data) => {
      if (data.kind === "alert") void loadAlerts();
    });
  }, [loadAlerts]);

  /* ── Render Alert Price Lines on Chart ────────────────────────────── */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const id of alertOverlayIds.current) {
      chart.removeOverlay(id);
    }
    alertOverlayIds.current = [];

    const activeAlerts = alerts.filter(
      (a) => a.symbol === symbol && (a.status === "active" || a.status === "triggered")
    );

    for (const a of activeAlerts) {
      let cond: any = a.condition;
      if (typeof cond === "string") {
        try {
          cond = JSON.parse(cond);
        } catch {
          /* malformed JSON condition */
        }
      }
      const val = typeof cond === "number" ? cond : (cond?.value ?? cond?.target);
      const targetPrice = Number(val);
      if (!Number.isFinite(targetPrice)) continue;

      const isTriggered = a.status === "triggered";
      const color = isTriggered ? "#f2566a" : "#f59e0b";

      const id = chart.createOverlay({
        name: "priceLine",
        points: [{ value: targetPrice }],
        lock: true,
        styles: {
          line: { color, style: isTriggered ? "solid" : "dashed", size: 1 },
          text: { color, size: 10, family: "IBM Plex Mono, monospace" },
        },
        extendData: `🔔 ${a.label} ($${targetPrice})`,
      } as any);

      if (typeof id === "string") alertOverlayIds.current.push(id);
    }
  }, [alerts, symbol]);

  /* Draw plan references as locked price lines.
   *
   * These are the levels the ENGINE resolves, so they must appear on the chart
   * the trader reads — one definition, two consumers. Only static levels can be
   * drawn as a fixed line; a derived level's value depends on a window the
   * resolver owns, and inventing a line for it here would be the chart
   * computing its own answer, which is the exact failure the fake CVD indicator
   * already cost this project once. Those are listed in the panel instead. */
  /* Armed plans on this pair, and which ones are currently drawn.
     `planOverlays` holds what each drawn plan created so hiding removes exactly
     that — including any indicator it switched on, but never one the trader had
     already enabled themselves. */
  const [plans, setPlans] = useState<StoredPlanView[]>([]);
  const [shownPlans, setShownPlans] = useState<number[]>([]);
  const [planDetail, setPlanDetail] = useState<StoredPlanView | null>(null);
  const planOverlays = useRef<Map<number, PlanOverlayHandle>>(new Map());

  /* Persist the layout on every change. Cheap, and it means the app never has
     a window where what is on screen and what would be restored disagree. */
  useEffect(() => {
    saveChartLayout({ overlays, panes, params: indicatorParams });
  }, [overlays, panes, indicatorParams]);

  /* Armed plans for this pair. Read from the session, since plans are
     session-scoped; Research can show any symbol, so a plan only appears when
     the symbol on screen is the session's pair. */
  useEffect(() => {
    if (!activeSession || activeSession.pair !== symbol) {
      setPlans([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await api.listPlans(activeSession.id, ["planned", "triggered"]);
      if (!cancelled && !isError(res)) setPlans(res);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSession?.id, activeSession?.pair, symbol, refsKey]);

  const refOverlayIds = useRef<string[]>([]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const id of refOverlayIds.current) chart.removeOverlay({ id } as any);
    refOverlayIds.current = [];

    let cancelled = false;
    void (async () => {
      const res = await api.listLevelReferences(symbol, intervalMin);
      if (cancelled || isError(res)) return;
      const c = chartRef.current;
      if (!c) return;

      for (const r of res) {
        const level = r.level as { kind?: string; price?: number } | null;
        if (!level || level.kind !== "static" || !Number.isFinite(level.price)) continue;
        const id = c.createOverlay({
          name: "priceLine",
          points: [{ value: level.price }],
          lock: true,
          styles: {
            line: { color: "#22d3ee", style: "solid", size: 1 },
            text: { color: "#22d3ee", size: 10, family: "IBM Plex Mono, monospace" },
          },
          extendData: `${r.label}`,
        } as any);
        if (typeof id === "string") refOverlayIds.current.push(id);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol, intervalMin, refsKey]);

  /* Tell the main process what this chart is showing, so the agent's
     `read_research_chart` and `screenshot_research` tools read the same view
     the user sees — the right symbol, the right timeframe, and a screenshot
     cropped to the chart rather than the whole window. Re-reported on
     symbol/interval change and on resize. */
  useEffect(() => {
    const report = () => {
      const el = containerRef.current;
      const r = el?.getBoundingClientRect();
      api.reportResearchView({
        symbol,
        intervalMin,
        bounds: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
      });
    };

    report();
    const ro = new ResizeObserver(report);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("resize", report);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
      // Leaving Research means "what's on screen" is no longer a chart.
      api.reportResearchClosed();
    };
  }, [symbol, intervalMin]);

  /* Position tool sizes against the session's real paper cash. */
  useEffect(() => {
    if (!activeSession) {
      setPositionToolContext(0, 1);
      return;
    }
    void (async () => {
      const res = await api.getPaperStats(activeSession.id);
      if (!isError(res)) setPositionToolContext(res.cashBalance, 1);
    })();
  }, [activeSession?.id]);

  /* ── Chart lifecycle ─────────────────────────────────────────── */
  useEffect(() => {
    registerChartTools();
    const el = containerRef.current;
    if (!el) return;

    const chart = init(el, {
      styles: {
        grid: {
          horizontal: { color: CHART_THEME.grid },
          vertical: { color: CHART_THEME.grid },
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
          priceMark: {
            last: { text: { family: "IBM Plex Mono, monospace" } },
          },
          tooltip: { text: { family: "IBM Plex Mono, monospace", size: 11 } },
        },
        xAxis: { axisLine: { color: CHART_THEME.grid }, tickLine: { color: CHART_THEME.grid }, tickText: { color: CHART_THEME.faint, family: "IBM Plex Mono, monospace" } },
        yAxis: { axisLine: { color: CHART_THEME.grid }, tickLine: { color: CHART_THEME.grid }, tickText: { color: CHART_THEME.faint, family: "IBM Plex Mono, monospace" } },
        crosshair: {
          horizontal: { line: { color: CHART_THEME.dim }, text: { family: "IBM Plex Mono, monospace" } },
          vertical: { line: { color: CHART_THEME.dim }, text: { family: "IBM Plex Mono, monospace" } },
        },
        indicator: { tooltip: { text: { family: "IBM Plex Mono, monospace", size: 11 } } },
      },
    });

    if (!chart) return;
    chartRef.current = chart;

    /* Rebuild the saved layout rather than the shipped defaults. Read straight
       from storage instead of the state above: this effect runs once on mount
       with an empty dependency list, so closing over state would pin it to the
       first render's value. */
    const layout = loadChartLayout();
    for (const name of layout.panes) {
      chart.createIndicator({ name, calcParams: layout.params[name] } as any, false, {
        id: `pane_${name.toLowerCase()}`,
      });
    }
    for (const name of layout.overlays) {
      chart.createIndicator({ name, calcParams: layout.params[name] } as any, true, { id: "candle_pane" });
    }

    // Bar under the crosshair — the anchor for anchored/fixed-range VWAP.
    chart.subscribeAction(ActionType.OnCrosshairChange, (data: any) => {
      if (typeof data?.kLineData?.timestamp === "number") crosshairTs.current = data.kLineData.timestamp;
    });

    return () => {
      chartRef.current = null;
      dispose(el);
    };
  }, []);

  /* Persist a drawing on create, on move, and on delete. In KLineChart these
     are per-overlay callbacks passed at creation time, so every code path
     that makes an overlay must go through `overlayOptions`. The runtime
     overlay id is mapped to our DB row id, so dragging updates rather than
     inserting a duplicate. */
  const persist = useCallback(async (overlay: any) => {
    if (!overlay?.points?.length) return;
    const key = String(overlay.id);
    const res = await api.saveDrawing({
      id: overlayDb.current.get(key),
      symbol: symbolRef.current,
      // Horizontal/price levels hold on every timeframe; everything else is
      // anchored to the bars it was drawn on.
      intervalMin:
        String(overlay.name).startsWith("horizontal") || overlay.name === "priceLine" ? null : intervalRef.current,
      kind: overlay.name,
      points: overlay.points,
      extend: {},
      locked: Boolean(overlay.lock),
    });
    if (!isError(res)) overlayDb.current.set(key, res.id);
  }, []);

  const overlayOptions = useCallback(
    (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      lock: locked,
      // Magnet snaps anchors to OHLC — a level drawn two ticks off a wick is
      // a guess, not a level.
      mode: magnet ? "weak_magnet" : "normal",
      onDrawEnd: ({ overlay }: any) => {
        void persist(overlay);
        setActiveTool(null);
        return false;
      },
      onPressedMoveEnd: ({ overlay }: any) => {
        void persist(overlay);
        return false;
      },
      onRemoved: ({ overlay }: any) => {
        const key = String(overlay.id);
        const rowId = overlayDb.current.get(key);
        if (rowId) void api.deleteDrawing(rowId);
        overlayDb.current.delete(key);
        return false;
      },
      ...extra,
    }),
    [locked, magnet, persist]
  );

  /* ── Data loading (+ live updates) ───────────────────────────── */
  const loadData = useCallback(async () => {
    const chart = chartRef.current;
    if (!chart) return;
    setStatus("loading…");

    const res = await api.getAnalysisCandles(symbol, intervalMin, 1000);
    if (isError(res)) {
      setStatus(errorText(res));
      chart.applyNewData([]);
      return;
    }

    const data: KLineData[] = res.map((c) => ({
      timestamp: c.start,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
    }));

    allDataRef.current = data;
    setReplayIdx(null);
    setReplaying(false);

    // Same precision rule as every other price in the app — KLineChart
    // otherwise picks its own and the axis disagrees with the tables.
    const last = data[data.length - 1];
    chart.setPriceVolumePrecision(priceDecimals(last?.close ?? 0), 2);

    chart.applyNewData(data);

    // Flag a stale window rather than drawing old bars as if they were live.
    const barMs = intervalMin * 60_000;
    const behind = last ? Math.floor((Date.now() - last.timestamp) / barMs) : 0;
    setStatus(behind > 2 ? `${data.length} bars · STALE (${behind} bars behind)` : `${data.length} bars`);
  }, [symbol, intervalMin]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  /* The drawings effect calls `chart.removeOverlay()` with no argument on a
     symbol or interval change, which clears EVERY overlay — plan lines
     included. Without this the panel would keep showing them as visible while
     the chart had none, and hiding would try to remove ids that no longer
     exist. */
  useEffect(() => {
    planOverlays.current.clear();
    setShownPlans([]);
  }, [symbol, intervalMin]);

  useEffect(() => {
    api.subscribeBinanceCandles(symbol, intervalMin);
    const off = api.onCandleUpdate(({ symbol: s, intervalMin: iv, candle }) => {
      if (s !== symbol || iv !== intervalMin) return;
      // Replay is a frozen view of history; a live tick must not jump it.
      if (replayIdx !== null) return;
      chartRef.current?.updateData({
        timestamp: candle.start,
        open: parseFloat(candle.open),
        high: parseFloat(candle.high),
        low: parseFloat(candle.low),
        close: parseFloat(candle.close),
        volume: parseFloat(candle.volume),
      });
    });
    return () => {
      off();
      api.unsubscribeBinanceCandles(symbol, intervalMin);
    };
  }, [symbol, intervalMin, replayIdx]);

  /* ── Restore saved drawings ──────────────────────────────────── */
  const restoreDrawings = useCallback(async () => {
    const chart = chartRef.current;
    if (!chart) return;
    // Forget the row mapping BEFORE removing: a no-filter `removeOverlay()`
    // fires every overlay's `onRemoved`, which deletes the row it maps to. A
    // view reset must find nothing to delete; only a user's delete may.
    overlayDb.current.clear();
    chart.removeOverlay();

    const res = await api.listDrawings(symbol, intervalMin);
    if (isError(res)) return;
    setDrawingList(res as ChartDrawing[]);

    for (const d of res as ChartDrawing[]) {
      try {
        const id = chart.createOverlay({
          ...overlayOptions(d.kind),
          points: JSON.parse(d.points),
          lock: d.locked === 1,
        } as any);
        if (typeof id === "string") overlayDb.current.set(id, d.id);
      } catch {
        // A drawing whose overlay type no longer exists is skipped rather
        // than taking the whole chart down.
      }
    }
  }, [symbol, intervalMin, overlayOptions]);

  useEffect(() => {
    void restoreDrawings();
  }, [restoreDrawings]);

  /* ── Toolbar actions ─────────────────────────────────────────── */
  const pickTool = (toolId: string, overlayName: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    setActiveTool(toolId);
    setOpenGroup(null);
    chart.createOverlay(overlayOptions(overlayName) as any);
  };

  /**
   * Show or hide one plan's levels.
   *
   * Nothing here is persisted: these lines are a *view* of the plan, not ink.
   * That is why hiding them leaves no trace to reset — writing them to
   * `chart_drawings` would create a second definition of a level the plan
   * already owns, which would go stale the moment the plan changed and outlive
   * the plan if it were deleted.
   */
  const togglePlan = (plan: StoredPlanView) => {
    const chart = chartRef.current;
    if (!chart) return;

    const existing = planOverlays.current.get(plan.rowId);
    if (existing) {
      erasePlan(chart, existing, removeIndicatorByName);
      planOverlays.current.delete(plan.rowId);
      setShownPlans((v) => v.filter((id) => id !== plan.rowId));
      return;
    }

    const handle = drawPlan(chart, plan, addIndicatorByName);
    planOverlays.current.set(plan.rowId, handle);
    setShownPlans((v) => [...v, plan.rowId]);
  };

  /** Switch an indicator on. Returns false when it was already on, so the plan
   *  overlay knows not to claim it — and therefore not to remove it later. */
  const addIndicatorByName = (name: string): boolean => {
    const chart = chartRef.current;
    if (!chart) return false;
    const isOverlay = OVERLAY_INDICATORS.some((d) => d.name === name);
    if (isOverlay ? overlays.includes(name) : panes.includes(name)) return false;
    toggleIndicator(name, isOverlay);
    return true;
  };

  const removeIndicatorByName = (name: string) => {
    const isOverlay = OVERLAY_INDICATORS.some((d) => d.name === name);
    if (isOverlay ? overlays.includes(name) : panes.includes(name)) toggleIndicator(name, isOverlay);
  };

  const toggleIndicator = (name: string, isOverlay: boolean) => {
    const chart = chartRef.current;
    if (!chart) return;

    if (isOverlay) {
      if (overlays.includes(name)) {
        chart.removeIndicator("candle_pane", name);
        setOverlays((v) => v.filter((n) => n !== name));
      } else {
        chart.createIndicator({ name, calcParams: paramsFor(name) } as any, true, { id: "candle_pane" });
        setOverlays((v) => [...v, name]);
      }
      return;
    }

    if (panes.includes(name)) {
      chart.removeIndicator(`pane_${name.toLowerCase()}`, name);
      setPanes((v) => v.filter((n) => n !== name));
    } else {
      chart.createIndicator({ name, calcParams: paramsFor(name) } as any, false, {
        id: `pane_${name.toLowerCase()}`,
      });
      setPanes((v) => [...v, name]);
    }
  };

  /**
   * Pull CVD from main and hand it to the chart.
   *
   * The indicator is a lookup, not a calculation (see `chart-tools.ts`): main
   * owns the one implementation, so the line drawn here is the same series a
   * strategy condition would resolve against. `calcParams` carries a version
   * counter purely to defeat KLineChart's params-keyed cache — without it the
   * previous symbol's series stays on screen after a switch.
   */
  const refreshCvd = useCallback(async () => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!panes.includes("CVD")) {
      clearCvdSeries();
      setCvdInfo(null);
      return;
    }

    const res = await api.getCvdSeries(symbol, intervalMin, { limit: 1000 });
    if (isError(res)) {
      setStatus(errorText(res));
      setCvdInfo(null);
      return;
    }

    const version = setCvdSeries(res.points);
    setCvdInfo({ coverage: res.coverage, suggestedAnchor: res.suggestedAnchor });
    chart.overrideIndicator({ name: "CVD", calcParams: [version] } as any, "pane_cvd");
  }, [symbol, intervalMin, panes]);

  useEffect(() => {
    void refreshCvd();
  }, [refreshCvd]);

  /** Current parameters for an indicator — edited values, or its defaults. */
  const paramsFor = (name: string): number[] => {
    const def = ALL_INDICATORS.find((i) => i.name === name);
    return indicatorParams[name] ?? def?.defaults ?? [];
  };

  /** Apply an edited parameter and recompute the indicator in place. */
  const setParam = (name: string, idx: number, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return;

    const next = [...paramsFor(name)];
    next[idx] = value;
    setIndicatorParams((prev) => ({ ...prev, [name]: next }));

    const chart = chartRef.current;
    if (!chart) return;
    const isOverlay = OVERLAY_INDICATORS.some((i) => i.name === name);
    const paneId = isOverlay ? "candle_pane" : `pane_${name.toLowerCase()}`;
    // Only touch it if it's actually on the chart.
    if ((isOverlay ? overlays : panes).includes(name)) {
      chart.overrideIndicator({ name, calcParams: next } as any, paneId);
    }
  };

  /**
   * Anchored VWAP from the bar under the crosshair — hover the swing/news bar
   * you want to anchor to, then add it. Adding a second one while holding a
   * later bar gives you the fixed-range version (anchor → that bar).
   */
  const addAnchoredVwap = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const data = allDataRef.current;
    if (!data.length) return;

    const anchorTs = crosshairTs.current ?? data[Math.max(0, data.length - 100)]?.timestamp ?? data[0]!.timestamp;

    chart.createIndicator({ name: "AVWAP", calcParams: [anchorTs, 0] } as any, true, { id: "candle_pane" });
    setIndicatorMenu(false);
    setStatus(`anchored VWAP from ${new Date(anchorTs).toLocaleString()}`);
  };

  const clearDrawings = async () => {
    // Remove while the row mapping is still live: each `onRemoved` goes through
    // `drawings:delete`, which detaches promoted references before the bulk clear.
    chartRef.current?.removeOverlay();
    overlayDb.current.clear();
    await api.clearDrawings(symbol);
    setStatus("drawings cleared");
  };

  /* ── Replay ──────────────────────────────────────────────────── */
  const startReplay = () => {
    const data = allDataRef.current;
    if (!data.length) return;
    const start = Math.max(20, Math.floor(data.length * 0.7));
    setReplayIdx(start);
    chartRef.current?.applyNewData(data.slice(0, start));
  };

  const stepReplay = useCallback(() => {
    setReplayIdx((idx) => {
      const data = allDataRef.current;
      if (idx === null || idx >= data.length) return idx;
      const next = idx + 1;
      const bar = data[idx];
      if (bar) chartRef.current?.updateData(bar);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!replaying || replayIdx === null) return;
    const id = setInterval(stepReplay, 600);
    return () => clearInterval(id);
  }, [replaying, replayIdx, stepReplay]);

  const exitReplay = () => {
    setReplaying(false);
    setReplayIdx(null);
    chartRef.current?.applyNewData(allDataRef.current);
  };

  const grouped = useMemo(
    () => TOOL_GROUPS.map((g) => ({ ...g, tools: TOOLS.filter((t) => t.group === g.id) })),
    []
  );

  return (
    <div className="research">
      {/* ── left tool rail ── */}
      <div className="research-tools">
        <button
          className={`research-tool ${activeTool === null ? "research-tool-active" : ""}`}
          onClick={() => {
            setActiveTool(null);
            setOpenGroup(null);
          }}
          title="Cursor"
        >
          <MousePointer2 size={15} />
        </button>

        {grouped.map((g) => (
          <div key={g.id} className="research-tool-wrap">
            <button
              className={`research-tool ${openGroup === g.id ? "research-tool-open" : ""}`}
              onClick={() => setOpenGroup((v) => (v === g.id ? null : g.id))}
              title={g.label}
            >
              {g.id === "line" && <TrendingUp size={15} />}
              {g.id === "channel" && <Layers size={15} />}
              {g.id === "fib" && <span className="research-tool-glyph">fib</span>}
              {g.id === "wave" && <span className="research-tool-glyph">5</span>}
              {g.id === "shape" && <span className="research-tool-glyph">▭</span>}
              {g.id === "tool" && <Crosshair size={15} />}
            </button>
            {openGroup === g.id && (
              <div className="research-tool-menu">
                <div className="research-tool-menu-head label-micro">{g.label}</div>
                {g.tools.map((t) => (
                  <button key={t.id} className="research-tool-menu-item" onClick={() => pickTool(t.id, t.overlay)}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        <div className="research-tool-sep" />

        <button
          className={`research-tool ${magnet ? "research-tool-active" : ""}`}
          onClick={() => setMagnet((v) => !v)}
          title={magnet ? "Magnet on — anchors snap to OHLC" : "Magnet off"}
        >
          <Magnet size={15} />
        </button>
        <button
          className={`research-tool ${locked ? "research-tool-active" : ""}`}
          onClick={() => setLocked((v) => !v)}
          title={locked ? "New drawings are locked" : "New drawings are editable"}
        >
          <Lock size={15} />
        </button>
        <button
          className={`research-tool ${showProfile ? "research-tool-active" : ""}`}
          onClick={() => setShowProfile((v) => !v)}
          title={
            showProfile
              ? "Hide volume profile"
              : "Show volume profile"
          }
        >
          <BarChart3 size={15} />
        </button>
        <button
          className={`research-tool ${showRefs ? "research-tool-active" : ""}`}
          onClick={() => setShowRefs((v) => !v)}
          title="Plan references — levels the engine can act on"
        >
          <Bookmark size={15} />
        </button>
        <button className="research-tool" onClick={() => void clearDrawings()} title="Clear all drawings on this symbol">
          <Trash2 size={15} />
        </button>
      </div>

      {/* ── chart column ── */}
      <div className="research-main">
        <div className="research-bar">
          <span className="research-symbol">{symbol}</span>

          <div className="research-intervals">
            {INTERVALS.map((i) => (
              <button
                key={i.min}
                className={`research-interval ${intervalMin === i.min ? "research-interval-active" : ""}`}
                onClick={() => setIntervalMin(i.min)}
              >
                {i.label}
              </button>
            ))}
          </div>

          <div className="research-bar-sep" />

          <div style={{ position: "relative" }}>
            <button className="btn" onClick={() => setIndicatorMenu((v) => !v)}>
              <Layers size={13} /> Indicators
            </button>
            {indicatorMenu && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={() => setIndicatorMenu(false)} />
                <div className="research-menu vy-scroll">
                  <div className="research-menu-head label-micro">On price</div>
                  {OVERLAY_INDICATORS.map((i) => (
                    <IndicatorRow
                      key={i.name}
                      def={i}
                      active={overlays.includes(i.name)}
                      onToggle={() => toggleIndicator(i.name, true)}
                      onOpenSettings={() => setEditingIndicator(i)}
                    />
                  ))}
                  <button className="research-menu-item" onClick={addAnchoredVwap}>
                    Anchored / fixed-range VWAP
                  </button>
                  <div className="research-menu-head label-micro">Sub-panels</div>
                  {PANE_INDICATORS.map((i) => (
                    <IndicatorRow
                      key={i.name}
                      def={i}
                      active={panes.includes(i.name)}
                      onToggle={() => toggleIndicator(i.name, false)}
                      onOpenSettings={() => setEditingIndicator(i)}
                    />
                  ))}

                  {/* The layout is saved as you change it, so this is the way
                      back — otherwise a tuned indicator is permanent by
                      accident. */}
                  <div className="research-menu-head label-micro">Layout</div>
                  <div className="research-menu-note">Your indicators and their settings are kept.</div>
                  <button
                    className="research-menu-item"
                    onClick={() => {
                      resetChartLayout();
                      setOverlays(DEFAULT_LAYOUT.overlays);
                      setPanes(DEFAULT_LAYOUT.panes);
                      setIndicatorParams({});
                      setIndicatorMenu(false);
                      /* Rebuilding panes and overlays in place is fiddly and
                         easy to get half-right; a reload restores from the
                         saved layout through the one path that already works. */
                      window.location.reload();
                    }}
                  >
                    Reset to defaults
                  </button>
                </div>
              </>
            )}
          </div>

          <div style={{ position: "relative" }}>
            <button
              className={`btn ${alerts.length > 0 ? "btn-active" : ""}`}
              onClick={() => setAlertsMenu((v) => !v)}
              title="View active alerts for this session"
            >
              <Bell size={13} style={{ color: alerts.length > 0 ? "var(--caution)" : "inherit" }} />
              <span>Alerts</span>
              {alerts.length > 0 && (
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-2xs)",
                    background: "rgba(245, 158, 11, 0.2)",
                    color: "#f59e0b",
                    padding: "1px 5px",
                    borderRadius: "999px",
                    fontWeight: 700,
                  }}
                >
                  {alerts.length}
                </span>
              )}
            </button>
            {alertsMenu && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={() => setAlertsMenu(false)} />
                <div className="research-menu vy-scroll" style={{ width: 280, padding: 10 }}>
                  <div className="research-menu-head label-micro" style={{ marginBottom: 6 }}>
                    Active Alerts ({alerts.length})
                  </div>
                  {alerts.length === 0 ? (
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)", padding: "6px 0" }}>
                      No alerts set for this session yet.
                    </div>
                  ) : (
                    alerts.map((a) => (
                      <div
                        key={a.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "6px 8px",
                          borderRadius: "var(--radius-sm)",
                          background: "var(--surface-3)",
                          marginBottom: 6,
                          fontSize: "var(--text-xs)",
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontWeight: 600, color: "var(--foreground)" }}>{a.label}</span>
                          <span className="mono" style={{ color: "var(--text-faint)", fontSize: "var(--text-2xs)" }}>
                            {a.symbol} · {a.condition?.indicator} {(a.condition?.operator || "").replace(/_/g, " ")}{" "}
                            {describeThreshold(a.condition?.value)}
                          </span>
                        </div>
                        <button
                          onClick={async () => {
                            await api.removeAlert(a.id);
                            void loadAlerts();
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--text-faint)",
                            cursor: "pointer",
                            padding: 4,
                          }}
                          title="Delete alert"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          {replayIdx === null ? (
            <button className="btn" onClick={startReplay} title="Replay bar by bar">
              <Play size={13} /> Replay
            </button>
          ) : (
            <div className="research-replay">
              <button className="btn" onClick={() => setReplaying((v) => !v)}>
                {replaying ? <Pause size={13} /> : <Play size={13} />}
                {replaying ? "Pause" : "Play"}
              </button>
              <button className="btn" onClick={stepReplay} title="Step one bar">
                <SkipForward size={13} />
              </button>
              <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
                bar {replayIdx} / {allDataRef.current.length}
              </span>
              <button className="btn" onClick={exitReplay}>
                <Eraser size={13} /> Exit
              </button>
            </div>
          )}

          {/* A CVD line with holes in it is telling you the aggressor split is
              unknown for those bars, not that aggression went flat. Say which,
              and point at the fix — otherwise the gap reads as data. */}
          {cvdInfo && cvdInfo.coverage < 0.999 && (
            <span
              className="mono ml-auto"
              style={{ fontSize: "var(--text-xs)", color: "var(--caution)" }}
              title="Some bars are missing buy/sell data, so the CVD line breaks there. Repair the history in Settings › Data & feeds."
            >
              CVD {(cvdInfo.coverage * 100).toFixed(0)}% covered
              {cvdInfo.suggestedAnchor
                ? ` · unbroken from ${new Date(cvdInfo.suggestedAnchor).toLocaleDateString()}`
                : ""}
            </span>
          )}

          <span
            className="mono"
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-faint)",
              marginLeft: cvdInfo && cvdInfo.coverage < 0.999 ? 12 : "auto",
            }}
          >
            Binance analysis feed · {status}
          </span>
        </div>

        <div style={{ position: "relative", flex: 1, width: "100%", height: "100%" }}>
          <div ref={containerRef} className="research-canvas" style={{ width: "100%", height: "100%" }} />

          {showRefs && (
            <LevelReferencesPanel
              symbol={symbol}
              intervalMin={intervalMin}
              drawings={drawingList}
              refreshKey={refsKey}
              onChanged={() => setRefsKey((k) => k + 1)}
              plans={plans}
              shownPlanIds={shownPlans}
              onTogglePlan={togglePlan}
              onOpenPlan={setPlanDetail}
            />
          )}

          {/* Rendering only: bins, POC, VAH and VAL all come from main, so the
              profile drawn on is the profile the engine would resolve against. */}
          {showProfile && (
            <VolumeProfileOverlay
              chart={chartRef.current}
              symbol={symbol}
              intervalMin={intervalMin}
              fromMs={null}
              toMs={null}
              onError={setStatus}
            />
          )}

          {/* TradingView-style Floating AUTO Adjust Chart Display Button */}
          <button
            onClick={() => {
              if (chartRef.current) {
                if (typeof (chartRef.current as any).scrollToRealTime === "function") {
                  (chartRef.current as any).scrollToRealTime();
                } else if (allDataRef.current.length > 0) {
                  chartRef.current.scrollToDataIndex(allDataRef.current.length - 1);
                }
              }
            }}
            style={{
              position: "absolute",
              bottom: 16,
              right: 16,
              zIndex: 10,
              background: "rgba(18, 24, 34, 0.85)",
              backdropFilter: "blur(4px)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              color: "var(--accent)",
              fontSize: "var(--text-2xs)",
              fontWeight: 700,
              padding: "5px 10px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 5,
              boxShadow: "0 4px 10px rgba(0,0,0,0.4)",
            }}
            title="Follow the latest bar"
          >
            <Maximize2 size={12} />
            <span>AUTO</span>
          </button>
        </div>

        {editingIndicator && (
          <IndicatorSettingsModal
            def={editingIndicator}
            params={paramsFor(editingIndicator.name)}
            onParamChange={(idx, v) => setParam(editingIndicator.name, idx, v)}
            onClose={() => setEditingIndicator(null)}
            onReset={() => {
              setIndicatorParams((prev) => {
                const next = { ...prev };
                delete next[editingIndicator.name];
                return next;
              });
            }}
          />
        )}

        {planDetail && (
          <PlanDetail
            plan={planDetail}
            price={null}
            monitored={activeSession?.status === "active"}
            onClose={() => setPlanDetail(null)}
          />
        )}
      </div>
    </div>
  );
}
