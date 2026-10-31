import { useCallback, useEffect, useState } from "react";
import { Target } from "lucide-react";
import { api, isError, type CalibrationRecord, type TagCalibration } from "@/lib/api";

/**
 * How the owner's own theses tend to play out, by assumption tag.
 *
 * **It sits on the Plans page, above the plans**, because the moment it matters
 * is the moment before writing the next one — "do my range-reclaim theses
 * actually play out?" is a question asked while authoring, not while reviewing.
 *
 * **Cross-session on purpose.** The same thesis type recurs on different pairs,
 * and that is the whole unit of evidence: a plan is a one-shot bet with no
 * sample, but the person writing them repeats.
 *
 * The two things this must never do are show a rate from four plans, and count
 * a plan the app was not awake for. Both are handled in main; this renders what
 * it is given and says plainly when a number is being withheld.
 */
function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}

function TagRow({ t, minSample }: { t: TagCalibration; minSample: number }) {
  const thin = t.triggerRate === null;
  return (
    <div className="calib-row">
      <span className="calib-tag">{t.tag ?? "untagged"}</span>
      <span className="calib-counts mono">
        {t.triggered}/{t.resolved} triggered
      </span>
      {thin ? (
        /* Counts alone until the sample is worth quoting. "3 of 4 = 75%" reads
           as a finding about the thesis rather than about the sample size. */
        <span className="calib-thin">
          {t.resolved} of {minSample} needed for a rate
        </span>
      ) : (
        <>
          <span className="mono">{pct(t.triggerRate)} fire</span>
          <span className="mono" title="Of those that fired, how often the thesis was disproved">
            {pct(t.invalidationRate)} disproved
          </span>
        </>
      )}
      {t.capturedShare !== null && (
        <span className="mono" title="How far the forecast move got, averaged. Not profit.">
          {pct(t.capturedShare)} of target
        </span>
      )}
      {t.unwatched > 0 && (
        <span className="calib-unwatched" title="Excluded: the app was closed for part of their life">
          {t.unwatched} unwatched
        </span>
      )}
    </div>
  );
}

export function CalibrationPanel() {
  const [rec, setRec] = useState<CalibrationRecord | null>(null);

  const load = useCallback(async () => {
    /* No session argument: cross-session is the useful view. */
    const res = await api.planCalibration();
    if (!isError(res)) setRec(res);
  }, []);

  useEffect(() => {
    void load();
    return api.onDataUpdated(({ kind }) => {
      if (kind === "plan") void load();
    });
  }, [load]);

  if (!rec) return null;

  if (rec.empty) {
    return (
      <section className="panel calib">
        <div className="panel-header">
          <Target size={13} style={{ color: "var(--accent)" }} />
          <span className="label-micro">Your track record</span>
        </div>
        <div className="calib-body">
          <p className="calib-empty">
            Nothing has finished yet. Tag your assumptions and this fills in as plans resolve.
            {rec.stillOpen > 0 && ` ${rec.stillOpen} still running.`}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel calib">
      <div className="panel-header">
        <Target size={13} style={{ color: "var(--accent)" }} />
        <span className="label-micro">Your track record</span>
        <span className="ml-auto mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
          {rec.overall.resolved} finished{rec.stillOpen > 0 ? ` · ${rec.stillOpen} running` : ""}
        </span>
      </div>
      <div className="calib-body">
        {rec.tags.map((t) => (
          <TagRow key={t.tag ?? "untagged"} t={t} minSample={rec.minSample} />
        ))}
        {rec.tags.length > 1 && (
          <div className="calib-row calib-overall">
            <span className="calib-tag">all</span>
            <span className="calib-counts mono">
              {rec.overall.triggered}/{rec.overall.resolved} triggered
            </span>
            {rec.overall.triggerRate !== null && <span className="mono">{pct(rec.overall.triggerRate)} fire</span>}
          </div>
        )}
        <p className="calib-note">
          How your theses played out — not how much they made.
        </p>
      </div>
    </section>
  );
}
