import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * The shell every detail view uses — plans, strategies, and whatever comes next.
 *
 * One shell rather than a modal per surface, because the thing that must stay
 * identical is the framing: what am I looking at, what kind of thing is it, and
 * how do I get out. The *content* differs per entity; the chrome must not.
 *
 * Closes on Escape and on backdrop click. Both matter for something opened by a
 * single click on a row — a dialog that traps you is worse than no dialog.
 */
export function DetailModal({
  title,
  kind,
  badge,
  onClose,
  children,
}: {
  title: string;
  /** "Plan" or "Strategy" — stated, never inferred from styling. The two are
   *  different objects with different rules, and a reader must not have to
   *  guess which one is open. */
  kind: string;
  badge?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="detail-backdrop" onClick={onClose}>
      <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head">
          <span className="detail-kind">{kind}</span>
          <span className="detail-title">{title}</span>
          {badge}
          <button className="detail-close ml-auto" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="detail-body vy-scroll">{children}</div>
      </div>
    </div>
  );
}

/** A titled block inside a detail view. */
export function DetailSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="detail-section">
      <div className="detail-section-head">
        <span className="label-micro">{title}</span>
        {note && <span className="detail-section-note">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * One level, labelled by the **role it plays**, not by what it is made of.
 *
 * This is the distinction the owner asked for: a price on its own says nothing
 * about whether crossing it opens a trade, closes one for a loss, takes profit,
 * or kills the thesis. Those four have opposite meanings and identical
 * formatting, so the role carries the colour and the label, and the source
 * ("POC (developing)") is secondary detail underneath.
 */
export function LevelRow({
  role,
  value,
  source,
  atArm,
  gapPct,
  tone,
}: {
  role: string;
  value: string;
  /** What the level is derived from, when it isn't a typed price. */
  source?: string | null;
  /** True when `value` is the value at arming rather than now. */
  atArm?: boolean;
  gapPct?: number | null;
  tone?: "up" | "down" | "caution" | "accent";
}) {
  return (
    <div className="detail-level">
      <span className={`detail-level-role ${tone ? `detail-level-${tone}` : ""}`}>{role}</span>
      <span className="mono detail-level-value">{value}</span>
      {gapPct !== null && gapPct !== undefined && (
        <span className={`mono detail-level-gap ${Math.abs(gapPct) < 1 ? "detail-level-near" : ""}`}>
          {gapPct > 0 ? "+" : ""}
          {gapPct.toFixed(1)}%
        </span>
      )}
      {source && (
        <span className="detail-level-source ml-auto">
          {source}
          {atArm ? " · at arm" : ""}
        </span>
      )}
    </div>
  );
}
