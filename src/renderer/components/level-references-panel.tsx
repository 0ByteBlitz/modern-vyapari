/**
 * Plans and levels on Research (roadmap S2-2 + J-3).
 *
 * **Plans come first, because that is what the owner opens this panel looking
 * for.** It listed only references at first — the *authoring* layer, drawing →
 * meaning — and the owner's reaction was the right one: "shouldn't it list
 * active plans, and when I click, add drawings based on the plan?" Showing the
 * ingredients above the thing they were for is backwards.
 *
 * So: armed plans at the top, each toggling its levels onto the chart; the
 * reference list below, where promotion still happens.
 *
 * A drawing is geometry; a reference is what the trader meant. This panel is
 * where the second becomes real: it lists the drawings on the current symbol
 * that *can* become levels, promotes them, and shows the references that exist.
 *
 * **Refusals are rendered, never swallowed.** Most drawing kinds cannot become
 * a resolvable level, and a promote button that silently did nothing is how a
 * trader ends up believing in a level the engine cannot see. Every refusal
 * comes back with a reason, and the reason is shown.
 */
import { useCallback, useEffect, useState } from "react";
import { X, ArrowUpRight, Eye, EyeOff, Target } from "lucide-react";
import {
  api,
  isError,
  errorText,
  type ChartDrawing,
  type LevelReferenceView,
  type StoredPlanView,
} from "@/lib/api";
import { describeThreshold } from "@shared/levels";

interface Props {
  symbol: string;
  intervalMin: number;
  /** Drawings currently on this symbol, so promotable ones can be offered. */
  drawings: ChartDrawing[];
  /** Bumped by the parent when drawings change, to re-read references. */
  refreshKey?: number;
  onChanged?: () => void;
  /** Armed plans on this pair, for the top section. */
  plans?: StoredPlanView[];
  /** Which plan row ids are currently drawn on the chart. */
  shownPlanIds?: number[];
  onTogglePlan?: (plan: StoredPlanView) => void;
  onOpenPlan?: (plan: StoredPlanView) => void;
}

/** Kinds the main-process mapper accepts. Kept in sync with `isPromotable`. */
const PROMOTABLE = new Set([
  "horizontalStraightLine",
  "horizontalRayLine",
  "horizontalSegment",
  "priceLine",
  "simpleTag",
  "rect",
]);

export function LevelReferencesPanel({
  symbol,
  intervalMin,
  drawings,
  refreshKey = 0,
  onChanged,
  plans = [],
  shownPlanIds = [],
  onTogglePlan,
  onOpenPlan,
}: Props) {
  const [refs, setRefs] = useState<LevelReferenceView[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.listLevelReferences(symbol, intervalMin);
    if (isError(res)) {
      setRefusal(errorText(res));
      return;
    }
    setRefs(res);
  }, [symbol, intervalMin]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  /* Drawings not yet promoted. A drawing already backing a reference is not
     offered again — promoting twice would create two definitions of one level,
     which is the whole thing this feature exists to prevent. */
  const promoted = new Set(refs.map((r) => r.drawing_id).filter((v): v is number => v !== null));
  const candidates = drawings.filter((d) => PROMOTABLE.has(d.kind) && !promoted.has(d.id));

  async function promote(d: ChartDrawing) {
    setBusy(true);
    setRefusal(null);
    try {
      /* A rectangle means a fixed-range profile, which needs an explicit bin
         width — never automatic, because an automatic width changes as history
         grows and the level would move for a reason unrelated to the market.
         Asking here keeps that choice the trader's. */
      let binWidth: number | undefined;
      if (d.kind === "rect") {
        const entered = window.prompt("Bin width for this volume profile, in price units.");
        if (entered === null) return;
        binWidth = Number(entered);
        if (!Number.isFinite(binWidth) || binWidth <= 0) {
          setRefusal("Bin width must be a number greater than zero.");
          return;
        }
      }

      const res = await api.promoteDrawing(d.id, binWidth !== undefined ? { binWidth } : {});
      if (isError(res)) {
        setRefusal(errorText(res));
        return;
      }
      if (!res.ok) {
        setRefusal(res.reason);
        return;
      }
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    const res = await api.deleteLevelReference(id);
    if (isError(res)) {
      setRefusal(errorText(res));
      return;
    }
    await load();
    onChanged?.();
  }

  const shown = new Set(shownPlanIds);

  return (
    <div className="level-refs-panel">
      <div className="level-refs-head">
        <span>Plans &amp; levels</span>
      </div>

      <div className="level-refs-sub">Armed plans</div>
      {plans.length === 0 ? (
        <p className="level-refs-empty">No armed plans on {symbol}.</p>
      ) : (
        plans.map((p) => (
          <div key={p.rowId} className="level-refs-row">
            <button
              className="level-refs-plan"
              onClick={() => onOpenPlan?.(p)}
              title="Open this plan"
            >
              <Target size={11} />
              <span className="level-refs-plan-name">{p.slug}</span>
              <span className="level-refs-detail">{p.state}</span>
            </button>
            <button
              className={`level-refs-btn ${shown.has(p.rowId) ? "level-refs-btn-on" : ""}`}
              onClick={() => onTogglePlan?.(p)}
              title={shown.has(p.rowId) ? "Hide these levels" : "Show this plan's levels on the chart"}
            >
              {shown.has(p.rowId) ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
          </div>
        ))
      )}

      <div className="level-refs-sub">Reference levels</div>
      {refs.length === 0 && candidates.length === 0 && (
        <p className="level-refs-empty">
          Draw a horizontal level or a rectangle, then promote it here.
        </p>
      )}

      {refs.map((r) => (
        <div key={r.id} className="level-refs-row">
          <div className="level-refs-label">
            <span>{r.label}</span>
            <span className="level-refs-detail">{describeThreshold(r.level)}</span>
          </div>
          {/* A reference whose drawing was deleted is still valid — erasing the
              ink does not erase the meaning — but say so, because it will no
              longer move when the chart is edited. */}
          {r.drawing_id === null && <span className="level-refs-orphan">no drawing</span>}
          <button className="level-refs-btn" onClick={() => void remove(r.id)} title="Delete this reference">
            <X size={12} />
          </button>
        </div>
      ))}

      {candidates.length > 0 && (
        <>
          <div className="level-refs-sub">Promote a drawing</div>
          {candidates.map((d) => (
            <div key={d.id} className="level-refs-row">
              <div className="level-refs-label">
                <span>{d.kind === "rect" ? "Rectangle → fixed-range profile" : "Horizontal level"}</span>
              </div>
              <button
                className="level-refs-btn"
                disabled={busy}
                onClick={() => void promote(d)}
                title="Promote to a plan reference"
              >
                <ArrowUpRight size={12} />
              </button>
            </div>
          ))}
        </>
      )}

      {refusal && <p className="level-refs-refusal">{refusal}</p>}
    </div>
  );
}
