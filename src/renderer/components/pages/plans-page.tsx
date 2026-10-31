/**
 * Scenario plans — authoring and arming (roadmap S3-2).
 *
 * This is the surface the whole product is for: the owner writes down a thesis,
 * and the agent monitors it. Two things about how it is built matter more than
 * how it looks.
 *
 * **The falsifiability gate is not re-implemented here.** `validatePlan` lives
 * in main and is the single definition of what makes a plan armable. This page
 * calls `armPlan`, renders whatever errors come back, and never pre-judges — a
 * UI copy of that rule would be a second definition of the one thing that must
 * have exactly one, and the two would drift.
 *
 * **Arming shows concrete numbers before it commits.** `armPlan` returns what
 * each derived level resolved to, so "VAH resolves to 71,842 right now" is
 * visible at the moment of approval. Approving a thesis and approving a
 * geometry are different acts, and this is where they are made the same one.
 */
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, ShieldCheck, AlertTriangle, Activity, X } from "lucide-react";
import { PlanDetail } from "@/components/plan-detail";
import { CalibrationPanel } from "@/components/calibration-panel";
import {
  api,
  isError,
  errorText,
  type Session,
  type StoredPlanView,
  type PlanInputView,
  type ArmResultView,
  type PlanDryRun,
  type LevelReferenceView,
  type PlanState,
} from "@/lib/api";

const DAY = 86_400_000;

interface Props {
  session: Session;
}

/* A level as authored in the form: either a typed price, or a promoted
   reference chosen by id. Kept separate from the wire shape so the form can
   hold "nothing chosen yet" without inventing a level. */
type LevelChoice = { mode: "price"; price: string } | { mode: "ref"; refId: number | null };

interface BranchDraft {
  id: string;
  label: string;
  triggerOp: "crosses_above" | "crosses_below" | "above" | "below";
  triggerValue: string;
  entry: LevelChoice;
  stop: LevelChoice;
  target: LevelChoice;
  budgetSharePct: string;
}

const emptyBranch = (n: number): BranchDraft => ({
  id: `branch-${n}`,
  label: n === 1 ? "primary" : `branch ${n}`,
  triggerOp: "crosses_above",
  triggerValue: "",
  entry: { mode: "price", price: "" },
  stop: { mode: "price", price: "" },
  target: { mode: "price", price: "" },
  budgetSharePct: "100",
});

const STATE_LABEL: Record<PlanState, string> = {
  draft: "Draft",
  planned: "Armed",
  triggered: "Triggered",
  closed: "Closed",
  expired: "Expired",
  invalidated: "Invalidated",
};

export function PlansPage({ session }: Props) {
  const [plans, setPlans] = useState<StoredPlanView[]>([]);
  const [refs, setRefs] = useState<LevelReferenceView[]>([]);
  const [authoring, setAuthoring] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [armResult, setArmResult] = useState<{ planId: number; res: ArmResultView } | null>(null);
  /* The structural check, run on demand rather than automatically: it replays
     400 bars and the owner should ask for it, not have the list stutter. */
  const [dryRun, setDryRun] = useState<{ planId: number; res: PlanDryRun } | null>(null);
  const [checking, setChecking] = useState<number | null>(null);
  /* Finished plans are kept and shown, never deleted: an expired-unfired plan
     is the denominator of the trigger rate, and removing it would raise that
     rate with nothing that would notice. A tab is the answer to the clutter,
     not a delete button. */
  const [tab, setTab] = useState<"active" | "finished">("active");
  const [detail, setDetail] = useState<StoredPlanView | null>(null);
  /** Last analysis-feed close, so the detail view can show distances. Null for
   *  a pair with no analysis feed — the view then shows levels without gaps
   *  rather than gaps computed against nothing. */
  const [price, setPrice] = useState<number | null>(null);

  /* Form state */
  const [slug, setSlug] = useState("");
  const [thesis, setThesis] = useState("");
  const [assumptions, setAssumptions] = useState<string[]>([""]);
  const [invalidationOp, setInvalidationOp] = useState<"below" | "above">("below");
  const [invalidationValue, setInvalidationValue] = useState("");
  const [expiryDays, setExpiryDays] = useState("14");
  const [maxQuote, setMaxQuote] = useState("250");
  const [ocoExclusive, setOcoExclusive] = useState(true);
  const [branches, setBranches] = useState<BranchDraft[]>([emptyBranch(1)]);

  const load = useCallback(async () => {
    const [p, r, candles] = await Promise.all([
      api.listPlans(session.id),
      api.listLevelReferences(session.pair),
      api.getAnalysisCandles(session.pair, 60, 2),
    ]);
    if (isError(p)) setProblem(errorText(p));
    else {
      setPlans(p);
      /* Keep an open detail view in step with the list — otherwise arming a
         plan while its detail is open leaves the modal showing the old state. */
      setDetail((d) => (d ? (p.find((x) => x.rowId === d.rowId) ?? null) : null));
    }
    if (!isError(r)) setRefs(r);
    if (!isError(candles) && candles.length > 0) {
      const close = Number(candles[candles.length - 1]!.close);
      setPrice(Number.isFinite(close) ? close : null);
    }
  }, [session.id, session.pair]);

  useEffect(() => {
    void load();
  }, [load]);

  /* The agent can now draft a plan. Without this the page would keep showing
     the list from before the tool ran — the "add the broadcast or the UI goes
     stale" rule, which this surface was missing. */
  useEffect(() => {
    return api.onDataUpdated((d) => {
      if (d.kind === "plan" || d.kind === "level") void load();
    });
  }, [load]);

  /* Open and close both clear the banner. It renders *outside* the form, so a
     refusal about a form you have since cancelled otherwise sits on the page
     describing something that no longer exists — reported in the first UI test
     run (§2.8): "the error persisted even after closing the form". */
  function openForm() {
    setProblem(null);
    setAuthoring(true);
  }

  function closeForm() {
    setProblem(null);
    setAuthoring(false);
    resetForm();
  }

  function resetForm() {
    setSlug("");
    setThesis("");
    setAssumptions([""]);
    setInvalidationValue("");
    setExpiryDays("14");
    setMaxQuote("250");
    setOcoExclusive(true);
    setBranches([emptyBranch(1)]);
  }

  /** A form choice → the wire shape. Returns null when nothing was chosen, so
   *  main's gate sees a missing level rather than a fabricated zero. */
  function toLevel(choice: LevelChoice): unknown | null {
    if (choice.mode === "price") {
      const n = Number(choice.price);
      return Number.isFinite(n) && choice.price.trim() !== "" ? { kind: "static", price: n } : null;
    }
    const ref = refs.find((r) => r.id === choice.refId);
    return ref ? ref.level : null;
  }

  async function save() {
    setProblem(null);
    const input: PlanInputView = {
      sessionId: session.id,
      slug: slug.trim() || `plan-${Date.now()}`,
      pair: session.pair,
      thesis: thesis.trim(),
      assumptions: assumptions.filter((a) => a.trim()).map((text) => ({ text: text.trim() })),
      /* An intent, not a ConditionGroup. The renderer describes the condition;
         main compiles it. Building the engine's wire format here is what made
         a UI file break when that format changed. */
      invalidation: { subject: "price", operator: invalidationOp, value: Number(invalidationValue) },
      expiresAt: Date.now() + Number(expiryDays || 0) * DAY,
      risk: { maxQuote: Number(maxQuote) },
      ocoExclusive,
      evalInterval: "4h",
      branches: branches.map((b) => ({
        id: b.id,
        label: b.label,
        trigger: { subject: "price", operator: b.triggerOp, value: Number(b.triggerValue) },
        entry: (toLevel(b.entry) ?? {}) as Record<string, unknown>,
        stop: (toLevel(b.stop) ?? {}) as Record<string, unknown>,
        targets: [toLevel(b.target)].filter(Boolean) as Record<string, unknown>[],
        budgetSharePct: Number(b.budgetSharePct),
      })),
    };

    const res = await api.createPlan(input);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    /* A refusal is a value now — a malformed condition is reported rather than
       stored as an empty group that would surface later as a confusing gate
       failure. */
    if (!res.ok) {
      setProblem(res.reason ?? "That plan could not be saved.");
      return;
    }
    closeForm();
    await load();
  }

  async function arm(planId: number) {
    setProblem(null);
    const res = await api.armPlan(planId);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    setArmResult({ planId, res });
    await load();
  }

  async function check(planId: number) {
    setProblem(null);
    setChecking(planId);
    const res = await api.dryRunPlan(planId);
    setChecking(null);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    setDryRun({ planId, res });
  }

  async function discard(planId: number) {
    const res = await api.deletePlan(planId);
    if (isError(res)) {
      setProblem(errorText(res));
      return;
    }
    if (!res.ok) setProblem(res.reason ?? "That plan cannot be deleted.");
    await load();
  }

  /* Draft and armed on one side, over on the other. `triggered` counts as
     active: a plan holding a position is very much still live, and a thesis can
     still be disproved while that position is green. */
  const FINISHED = ["closed", "expired", "invalidated"];
  const active = plans.filter((p) => !FINISHED.includes(p.state));
  const finished = plans.filter((p) => FINISHED.includes(p.state));
  const shown = tab === "active" ? active : finished;

  return (
    <div className="plans-page">
      <div className="plans-head">
        <div>
          <h2>Scenario plans</h2>
          {/* Says what the surface does and what a plan needs. The reasoning —
              why falsifiability replaces a backtest here — is in trade-plan.ts
              and docs/PLAN.md §17, which is where reasoning belongs. */}
          <p className="plans-sub">
            Write down a trade and the engine watches for it. Each plan needs
            assumptions, an invalidation price, an expiry and a budget.
          </p>
        </div>
        {!authoring && (
          <button className="plans-primary" onClick={openForm}>
            <Plus size={13} /> New plan
          </button>
        )}
      </div>

      {/* Above the plans, because the moment it matters is the moment before
          writing the next one. */}
      <CalibrationPanel />

      {problem && <div className="plans-problem">{problem}</div>}

      {authoring && (
        <div className="plans-form">
          <label className="plans-field">
            <span>Name</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="range-break" />
          </label>

          <label className="plans-field">
            <span>Thesis — what you expect</span>
            <textarea
              rows={2}
              value={thesis}
              onChange={(e) => setThesis(e.target.value)}
              placeholder="Reclaiming 72k and holding it for a session opens the gap to 78k."
            />
          </label>

          <div className="plans-field">
            <span>
              Assumptions — what must be true. <em>At least one.</em>
            </span>
            {assumptions.map((a, i) => (
              <div key={i} className="plans-row">
                <input
                  value={a}
                  onChange={(e) =>
                    setAssumptions((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                  }
                  placeholder="The 72k shelf is real supply, not a single wick."
                />
                <button
                  className="plans-icon"
                  onClick={() => setAssumptions((prev) => prev.filter((_, j) => j !== i))}
                  title="Remove"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button className="plans-ghost" onClick={() => setAssumptions((p) => [...p, ""])}>
              <Plus size={12} /> Add assumption
            </button>
          </div>

          <div className="plans-field">
            <span>
              Invalidation — the price that proves you wrong.{" "}
              <em>Not the stop. This can fire while you're in profit.</em>
            </span>
            <div className="plans-row">
              <select value={invalidationOp} onChange={(e) => setInvalidationOp(e.target.value as never)}>
                <option value="below">price below</option>
                <option value="above">price above</option>
              </select>
              <input
                value={invalidationValue}
                onChange={(e) => setInvalidationValue(e.target.value)}
                placeholder="66000"
                inputMode="decimal"
              />
            </div>
          </div>

          <div className="plans-grid">
            <label className="plans-field">
              <span>Expires in (days)</span>
              <input value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} inputMode="numeric" />
            </label>
            <label className="plans-field">
              <span>Risk budget (quote)</span>
              <input value={maxQuote} onChange={(e) => setMaxQuote(e.target.value)} inputMode="decimal" />
            </label>
          </div>

          <label className="plans-check">
            <input type="checkbox" checked={ocoExclusive} onChange={(e) => setOcoExclusive(e.target.checked)} />
            <span>
              Branches are one-cancels-the-other.{" "}
              <em>Turning this off lets more than one branch fire, sizing the plan twice.</em>
            </span>
          </label>

          <div className="plans-field">
            <span>Branches — the paths the market might take</span>
            {branches.map((b, i) => (
              <div key={i} className="plans-branch">
                <div className="plans-row">
                  <input
                    value={b.label}
                    onChange={(e) =>
                      setBranches((p) => p.map((v, j) => (j === i ? { ...v, label: e.target.value } : v)))
                    }
                    placeholder="breakout continuation"
                  />
                  {branches.length > 1 && (
                    <button
                      className="plans-icon"
                      onClick={() => setBranches((p) => p.filter((_, j) => j !== i))}
                      title="Remove branch"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>

                <div className="plans-row">
                  <select
                    value={b.triggerOp}
                    onChange={(e) =>
                      setBranches((p) => p.map((v, j) => (j === i ? { ...v, triggerOp: e.target.value as never } : v)))
                    }
                  >
                    <option value="crosses_above">crosses above</option>
                    <option value="crosses_below">crosses below</option>
                    <option value="above">is above</option>
                    <option value="below">is below</option>
                  </select>
                  <input
                    value={b.triggerValue}
                    onChange={(e) =>
                      setBranches((p) => p.map((v, j) => (j === i ? { ...v, triggerValue: e.target.value } : v)))
                    }
                    placeholder="trigger price"
                    inputMode="decimal"
                  />
                </div>

                {(["entry", "stop", "target"] as const).map((slot) => (
                  <div className="plans-row" key={slot}>
                    <span className="plans-slot">{slot}</span>
                    <select
                      value={b[slot].mode === "ref" ? `ref:${(b[slot] as { refId: number | null }).refId ?? ""}` : "price"}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next: LevelChoice = v.startsWith("ref:")
                          ? { mode: "ref", refId: Number(v.slice(4)) }
                          : { mode: "price", price: "" };
                        setBranches((p) => p.map((x, j) => (j === i ? { ...x, [slot]: next } : x)));
                      }}
                    >
                      <option value="price">a price</option>
                      {refs.map((r) => (
                        <option key={r.id} value={`ref:${r.id}`}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                    {b[slot].mode === "price" && (
                      <input
                        value={(b[slot] as { price: string }).price}
                        onChange={(e) =>
                          setBranches((p) =>
                            p.map((x, j) => (j === i ? { ...x, [slot]: { mode: "price", price: e.target.value } } : x))
                          )
                        }
                        inputMode="decimal"
                      />
                    )}
                  </div>
                ))}

                <div className="plans-row">
                  <span className="plans-slot">budget %</span>
                  <input
                    value={b.budgetSharePct}
                    onChange={(e) =>
                      setBranches((p) => p.map((v, j) => (j === i ? { ...v, budgetSharePct: e.target.value } : v)))
                    }
                    inputMode="decimal"
                  />
                </div>
              </div>
            ))}
            <button className="plans-ghost" onClick={() => setBranches((p) => [...p, emptyBranch(p.length + 1)])}>
              <Plus size={12} /> Add branch
            </button>
          </div>

          <div className="plans-actions">
            <button className="plans-primary" onClick={() => void save()}>
              Save draft
            </button>
            <button
              className="plans-ghost"
              onClick={closeForm}
            >
              Cancel
            </button>
          </div>
          <p className="plans-note">
            Drafts save unfinished. Everything is checked when you arm.
          </p>
        </div>
      )}

      {(active.length > 0 || finished.length > 0) && (
        <div className="plans-tabs">
          <button
            className={`plans-tab ${tab === "active" ? "plans-tab-on" : ""}`}
            onClick={() => setTab("active")}
          >
            Active <span className="plans-tab-n">{active.length}</span>
          </button>
          <button
            className={`plans-tab ${tab === "finished" ? "plans-tab-on" : ""}`}
            onClick={() => setTab("finished")}
          >
            Finished <span className="plans-tab-n">{finished.length}</span>
          </button>
        </div>
      )}

      {shown.length === 0 && !authoring && (
        <p className="plans-empty">
          {plans.length === 0
            ? `No plans on ${session.pair} yet.`
            : tab === "active"
              ? "Nothing armed or in draft."
              : "Nothing has finished yet."}
        </p>
      )}

      {shown.map((p) => (
        <div
          key={p.rowId}
          className="plans-card plans-card-open"
          onClick={() => setDetail(p)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setDetail(p);
          }}
        >
          <div className="plans-card-head">
            <span className="plans-slug">{p.slug}</span>
            <span className={`plans-state plans-state-${p.state}`}>{STATE_LABEL[p.state]}</span>
          </div>
          <p className="plans-thesis">{p.thesis}</p>
          <div className="plans-meta">
            <span>{p.branches.length} branch{p.branches.length === 1 ? "" : "es"}</span>
            <span>{p.assumptions.length} assumption{p.assumptions.length === 1 ? "" : "s"}</span>
            <span>budget {p.risk.maxQuote}</span>
            <span>expires {new Date(p.expiresAt).toLocaleDateString()}</span>
            {!p.ocoExclusive && <span className="plans-warn">OCO off</span>}
          </div>
          {p.outcomeReason && <p className="plans-outcome">{p.outcomeReason}</p>}

          {p.state === "draft" && (
            <div className="plans-actions" onClick={(e) => e.stopPropagation()}>
              <button className="plans-primary" onClick={() => void arm(p.rowId)}>
                <ShieldCheck size={13} /> Arm
              </button>
              {/* Before committing: would this fire at all? The gate proves a
                  plan can be wrong; this proves it can happen. */}
              <button className="plans-ghost" disabled={checking === p.rowId} onClick={() => void check(p.rowId)}>
                <Activity size={13} /> {checking === p.rowId ? "Checking…" : "Check"}
              </button>
              <button className="plans-ghost" onClick={() => void discard(p.rowId)}>
                Discard
              </button>
            </div>
          )}

          {dryRun?.planId === p.rowId && (
            <div className={dryRun.res.verdict === "fires" ? "plans-arm-ok" : "plans-arm-fail"}>
              <strong>{dryRun.res.headline}</strong>
              {/* Deliberately no PnL anywhere in here. A plan is never
                  backtested; this says whether it can happen, not how it did. */}
              {dryRun.res.problems.map((x, i) => (
                <p key={`p${i}`} className="plans-warn">{x}</p>
              ))}
              {dryRun.res.notes.map((x, i) => (
                <p key={`n${i}`}>{x}</p>
              ))}
              {dryRun.res.barsExamined > 0 && (
                <p style={{ color: "var(--text-faint)" }}>
                  Checked {dryRun.res.barsExamined} bars. This says what the plan would have done, not
                  what the market will do.
                </p>
              )}
            </div>
          )}

          {armResult?.planId === p.rowId && (
            <div className={armResult.res.ok ? "plans-arm-ok" : "plans-arm-fail"}>
              {armResult.res.ok ? (
                <>
                  <strong>Armed.</strong>
                  {armResult.res.resolved.length > 0 && (
                    <ul>
                      {armResult.res.resolved.map((r, i) => (
                        <li key={i}>
                          {r.where}: {r.label} resolved to <strong>{r.price}</strong>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  <strong>
                    <AlertTriangle size={12} /> Not armed
                  </strong>
                  <ul>
                    {armResult.res.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </>
              )}
              {armResult.res.warnings.map((w, i) => (
                <p key={i} className="plans-warn">
                  {w}
                </p>
              ))}
            </div>
          )}
        </div>
      ))}

      {detail && (
        <PlanDetail
          plan={detail}
          price={price}
          /* Watching only happens on an active session — the engine skips
              paused and archived ones, exactly as it does for strategies. */
          monitored={session.status === "active"}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}
