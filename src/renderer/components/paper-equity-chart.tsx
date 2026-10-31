import { type PaperEquityPoint } from "@/lib/api";
import { formatUsd } from "@/lib/format";

export function PaperEquityChart({ points }: { points: PaperEquityPoint[] }) {
  if (!points || points.length <= 1) {
    return (
      <div style={{ padding: "16px 12px", fontSize: "var(--text-xs)", color: "var(--text-faint)", textAlign: "center" }}>
        Nothing traded yet on this pair.
      </div>
    );
  }

  /* P&L, not cash. The line used to step only when a position CLOSED, so an
     open position that had doubled looked the same as no position at all. */
  const values = points.map((p) => p.pnl);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = Math.max(1, maxVal - minVal);

  const width = 400;
  const height = 120;
  const padding = 12;

  const svgPoints = points
    .map((p, i) => {
      const x = padding + (i / (points.length - 1)) * (width - padding * 2);
      const y = height - padding - ((p.pnl - minVal) / range) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const latest = points[points.length - 1]!;
  const first = points[0]!;
  const isUp = latest.pnl >= 0;
  const strokeColor = isUp ? "var(--up)" : "var(--down)";

  return (
    <div className="panel" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span className="label-micro">P&amp;L on this pair</span>
        <span className="mono" style={{ fontSize: "var(--text-xs)", color: strokeColor, fontWeight: 700 }}>
          {formatUsd(latest.pnl, { sign: true })}
          {latest.unrealisedPnl !== 0 && (
            /* Split, because they are different promises: one is banked, the
               other is a mark that can still go away. */
            <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
              {" "}
              ({formatUsd(latest.realizedPnl, { sign: true })} realised,{" "}
              {formatUsd(latest.unrealisedPnl, { sign: true })} open)
            </span>
          )}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: 100, overflow: "visible" }}>
        <polyline
          fill="none"
          stroke={strokeColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={svgPoints}
        />
      </svg>
    </div>
  );
}
