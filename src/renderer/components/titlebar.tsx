import logoUrl from "../assets/logo.svg";
import { useEffect, useState } from "react";
import { TAGLINE_NE } from "@/lib/brand";
import { api, isError, type AppModeStatus } from "@/lib/api";

/**
 * OS titlebar (40px) — window chrome and brand identity only.
 *
 * Navigation moved out of here in the redesign: the app is session-first, so
 * everything navigable lives in the left rail. That left this bar carrying
 * almost nothing, with a 18px logo reading as a favicon rather than a mark —
 * so the logo is now 24px and the Nepali tagline sits beside the name as a
 * quiet lockup. It's the only place brand appears during normal use, so it
 * should be legible rather than apologetic.
 *
 * The minimise/maximise/close buttons are painted by Windows itself
 * (titleBarStyle "hidden" + titleBarOverlay), so we reserve the top-right
 * space with the spacer rather than drawing our own — the prototype drew
 * custom ones, but replacing the native overlay would mean changing the
 * window config, which CLAUDE.md warns against.
 */
/**
 * The mode badge.
 *
 * **A launch-gate item: the running mode must be unmistakable on every screen.**
 * The titlebar is the one element present on all of them, so it lives here.
 *
 * The two states are deliberately asymmetric. Simulated is quiet — it is the
 * default and the safe one, and a loud badge on the normal case trains the eye
 * to ignore the badge. Live is loud, because the cost of misreading it is real
 * money. This is the same reasoning as the armed-vs-idle rule: no state may be
 * ambiguous, and the ambiguity that matters is only in one direction.
 */
function ModeBadge() {
  const [status, setStatus] = useState<AppModeStatus | null>(null);

  useEffect(() => {
    void api.appModeStatus().then((r) => {
      if (!isError(r)) setStatus(r);
    });
  }, []);

  if (!status) return null;
  const live = status.mode === "live";

  return (
    <span
      className={`mode-badge ${live ? "mode-badge-live" : "mode-badge-sim"}`}
      title={
        live
          ? "Live mode — the venue adapter is real."
          : "Simulated mode — there is no route to a real order."
      }
    >
      {live ? "LIVE" : "simulated"}
      {/* Chosen but not yet in effect. Showing only the pending value would
          tell the owner they are live while the engine is still simulated. */}
      {status.pending !== status.mode && (
        <span className="mode-badge-pending" title="Takes effect on the next launch">
          → {status.pending} on restart
        </span>
      )}
    </span>
  );
}

export function Titlebar({ version = "0.1.0" }: { version?: string }) {
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <img src={logoUrl} alt="Modern Vyapari" className="titlebar-logo" />
        <div className="titlebar-lockup">
          <span className="titlebar-title">Modern Vyapari</span>
          <span className="titlebar-tagline" lang="ne">
            {TAGLINE_NE}
          </span>
        </div>
        <span className="titlebar-version">v{version}</span>
        <ModeBadge />
      </div>
      {/* Eaten by titleBarOverlay's native window buttons */}
      <div className="titlebar-spacer" />
    </header>
  );
}
