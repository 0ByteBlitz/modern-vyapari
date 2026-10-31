import { Target, Clock, AlertTriangle } from "lucide-react";
import { formatLevel } from "@shared/levels";
import type { PriceLevel } from "@shared/levels";
import type { StoredPlanView, PlanBranchView, LevelDraftView } from "@/lib/api";
import { formatPrice } from "@/lib/format";

/**
 * Armed plans, as distances.
 *
 * **This replaced the session dashboard's candle chart** (owner decision,
 * 2026-08-01). That chart was Phase 0 furniture from when the dashboard was the
 * app's main surface and the question was "what is this pair doing" — a question
 * Home now answers before you ask it, and Research answers properly. What it
 * left behind was a chart you could not draw on, anchor from, or promote a level
 * out of: a worse Research embedded in a page of status panels, and the source
 * of both §0.4 findings in the first UI test run.
 *
 * What belongs here instead is the **spine journey's at-a-glance view** (J3):
 * how far is price from the things an armed plan cares about. A list of
 * distances answers that better than candles do — "trigger 1.4% away, expires in
 * 9 days" is a sentence you can act on, where a chart makes you eyeball it.
 *
 * **Two rules this panel obeys, both of which cost it features:**
 *
 * 1. **It never resolves a level.** A derived level's value comes from a window
 *    the resolver owns in main. The renderer computing its own would repeat the
 *    fake-CVD mistake exactly — a number that looks precise and is measuring
 *    something else. So a derived level shows `resolvedAtArm` — main's number,
 *    from arming — and is **labelled as at-arm**, because by now it has moved.
 *    Live derived values arrive with J-3's resolver read; until then the label
 *    is the honest part.
 * 2. **Distance is measured against the analysis feed's price**, never the
 *    venue's. The levels were resolved from Binance history; measuring the gap
 *    with a Revolut X quote would mix two sources inside one number, which is
 *    the rule the whole feed-role split exists to enforce.
 */

/** Armed and still watched. `triggered` stays here on purpose — a thesis can be
 *  disproved while its position is green, so a triggered plan is not finished. */
const WATCHED: string[] = ["planned", "triggered"];

const DAY = 86_400_000;

interface LevelReading {
  /** The number, or null when there isn't one to show honestly. */
  value: number | null;
  /** True when this is the value at arm rather than now — always for derived. */
  atArm: boolean;
  /** What the level *is*, for a derived level: "POC (developing)". */
  name: string | null;
}

/**
 * A stored level → something displayable.
 *
 * A derived level with no `resolvedAtArm` yields `value: null` rather than 0.
 * That case means the plan is still a draft, and a fabricated zero here would
 * render as a real price sitting 100% away from the market.
 */
function read(level: LevelDraftView | undefined): LevelReading {
  if (!level || typeof level !== "object") return { value: null, atArm: false, name: null };
  const l = level as Record<string, unknown>;
  if (l.kind === "static" && typeof l.price === "number") {
    return { value: l.price, atArm: false, name: null };
  }
  const armed = typeof l.resolvedAtArm === "number" ? l.resolvedAtArm : null;
  let name: string | null = null;
  try {
    name = formatLevel(level as PriceLevel);
  } catch {
    /* An unrecognised level shape shows its value without a name rather than
       taking the panel down. */
  }
  return { value: armed, atArm: armed !== null, name };
}

/** Signed distance from price to a level, in percent. */
function gapPct(price: number | null, level: number | null): number | null {
  if (price === null || level === null || price === 0) return null;
  return ((level - price) / price) * 100;
}

function Gap({ price, level }: { price: number | null; level: number | null }) {
  const g = gapPct(price, level);
  if (g === null) return <span className="plan-watch-gap v-flat">—</span>;
  const near = Math.abs(g) < 1;
  return (
    <span className={`plan-watch-gap ${near ? "plan-watch-gap-near" : ""}`}>
      {g > 0 ? "+" : ""}
      {g.toFixed(1)}%
    </span>
  );
}

function LevelCell({
  label,
  level,
  price,
  tone,
}: {
  label: string;
  level: LevelDraftView | undefined;
  price: number | null;
  tone?: "up" | "down";
}) {
  const r = read(level);
  return (
    <div className="plan-watch-level">
      <span className="plan-watch-level-label">{label}</span>
      <span className={`mono plan-watch-level-value ${tone ? `v-${tone}` : ""}`}>
        {r.value === null ? "—" : formatPrice(String(r.value))}
      </span>
      <Gap price={price} level={r.value} />
      {r.name && (
        /* Naming the source matters: "71,842" and "POC (developing), as at arm"
           are the same number and very different claims. */
        <span className="plan-watch-level-src" title="Value at arming — derived levels move">
          {r.name} · at arm
        </span>
      )}
    </div>
  );
}

function expiryLabel(expiresAt: number): { text: string; urgent: boolean } {
  const left = expiresAt - Date.now();
  if (left <= 0) return { text: "expired", urgent: true };
  const days = Math.floor(left / DAY);
  if (days >= 2) return { text: `${days}d left`, urgent: false };
  const hours = Math.max(1, Math.floor(left / 3_600_000));
  return { text: `${hours}h left`, urgent: true };
}

function Branch({ branch, price }: { branch: PlanBranchView; price: number | null }) {
  const triggered = branch.status === "triggered" || Boolean(branch.triggeredAt);
  return (
    <div className={`plan-watch-branch ${triggered ? "plan-watch-branch-live" : ""}`}>
      <div className="plan-watch-branch-head">
        <span className="plan-watch-branch-label">{branch.label || branch.id}</span>
        {triggered && <span className="badge badge-paper">triggered</span>}
        <span className="mono ml-auto plan-watch-share">{branch.budgetSharePct}%</span>
      </div>
      <div className="plan-watch-levels">
        <LevelCell label="entry" level={branch.entry} price={price} />
        <LevelCell label="stop" level={branch.stop} price={price} tone="down" />
        <LevelCell label="target" level={branch.targets?.[0]} price={price} tone="up" />
      </div>
    </div>
  );
}

export function PlanWatchPanel({
  plans,
  price,
  pair,
  onOpen,
}: {
  plans: StoredPlanView[];
  /** Last close from the **analysis** feed — see rule 2 above. */
  price: number | null;
  pair: string;
  /** Open the full plan. The panel is a summary; the detail is where the
   *  assumptions and the invalidation live. */
  onOpen?: (plan: StoredPlanView) => void;
}) {
  const watched = plans.filter((p) => WATCHED.includes(p.state));

  return (
    <section className="panel plan-watch" style={{ flexShrink: 0 }}>
      <div className="panel-header">
        <Target size={13} style={{ color: "var(--accent)" }} />
        <span className="label-micro">Armed plans</span>
        <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
          {price === null ? "no price" : formatPrice(String(price))}
        </span>
      </div>

      {watched.length === 0 ? (
        <div style={{ padding: "14px 10px", fontSize: "var(--text-md)", color: "var(--text-faint)" }}>
          No armed plans for {pair}. Create one on the Plans page.
        </div>
      ) : (
        <div className="panel-body-flush vy-scroll">
          {watched.map((p) => {
            const exp = expiryLabel(p.expiresAt);
            return (
              <div
                key={p.rowId}
                className={`plan-watch-plan ${onOpen ? "plan-watch-plan-open" : ""}`}
                onClick={onOpen ? () => onOpen(p) : undefined}
                role={onOpen ? "button" : undefined}
                tabIndex={onOpen ? 0 : undefined}
                onKeyDown={(e) => {
                  if (onOpen && (e.key === "Enter" || e.key === " ")) onOpen(p);
                }}
              >
                <div className="plan-watch-plan-head">
                  <span className="plan-watch-slug">{p.slug}</span>
                  <span className={`badge badge-${p.state === "triggered" ? "supervised" : "paper"}`}>
                    {p.state}
                  </span>
                  <span
                    className={`plan-watch-expiry ml-auto ${exp.urgent ? "plan-watch-expiry-urgent" : ""}`}
                  >
                    <Clock size={11} /> {exp.text}
                  </span>
                </div>
                <div className="plan-watch-thesis">{p.thesis}</div>
                {p.branches.map((b) => (
                  <Branch key={b.rowId ?? b.id} branch={b} price={price} />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {watched.length > 0 && (
        <div className="panel-footer">
          {price === null ? (
            <>
              <AlertTriangle size={12} style={{ color: "var(--caution)" }} />
              <span style={{ color: "var(--caution)" }}>No price for {pair}, so distances are unavailable.</span>
            </>
          ) : (
            <span>Levels marked "at arm" were measured when you armed the plan.</span>
          )}
        </div>
      )}
    </section>
  );
}
