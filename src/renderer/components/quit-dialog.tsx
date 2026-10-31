import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Power } from "lucide-react";
import { api } from "@/lib/api";
import { describeQuit, type QuitSummary } from "@shared/quit";

/**
 * The quit confirmation, in the app's theme.
 *
 * Main intercepts the close and sends `app:quitRequested` with what is being
 * watched; this shows it. Mounted beside <App/> in main.tsx, not inside it, so
 * it works on the lock screen and during onboarding too, and survives the app
 * tree crashing into its error boundary.
 *
 * The dialog renders first and acknowledges after (`quitShown`), so a dialog
 * that fails to render never acknowledges and main falls back to its native
 * box. If main has already fallen back (renderer too slow), the acknowledgement
 * answers false and the dialog removes itself.
 *
 * Focus goes to the safe action when quitting stops something (Cancel), and to
 * Quit when nothing is armed or open — Enter then does the expected thing.
 */
export function QuitDialog() {
  const [summary, setSummary] = useState<QuitSummary | null>(null);
  const [closing, setClosing] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const quitRef = useRef<HTMLButtonElement>(null);
  /** Bumped per request, so a stale close timer can't dismiss a newer dialog. */
  const generation = useRef(0);

  useEffect(
    () =>
      api.onQuitRequested((s) => {
        generation.current += 1;
        setClosing(false);
        setSummary(s);
      }),
    []
  );

  useLayoutEffect(() => {
    if (!summary) return;
    const gen = generation.current;
    void api.quitShown().then((ok) => {
      if (ok !== true && generation.current === gen) setSummary(null);
    });
  }, [summary]);

  const answer = useCallback((quit: boolean) => {
    if (quit) {
      void api.answerQuit(true);
      return;
    }
    setClosing(true);
    void api.answerQuit(false);
    /* Normally the exit animation's end unmounts it; this is the backstop for
       when no animation runs at all. */
    const gen = generation.current;
    window.setTimeout(() => {
      if (generation.current === gen) setSummary(null);
    }, 400);
  }, []);

  const copy = summary ? describeQuit(summary) : null;

  useEffect(() => {
    if (!copy) return;
    (copy.guarded ? cancelRef : quitRef).current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        answer(false);
      }
      // Two buttons: keep Tab inside the dialog.
      if (e.key === "Tab") {
        e.preventDefault();
        const next = document.activeElement === cancelRef.current ? quitRef : cancelRef;
        next.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [copy, answer]);

  if (!summary || !copy) return null;
  const live = summary.mode === "live";

  return (
    <div
      className={`modal-backdrop${closing ? " is-closing" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && answer(false)}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) setSummary(null);
      }}
    >
      <div
        className="modal modal-sm quit-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="quit-title"
        aria-describedby="quit-body"
      >
        <div className="quit-head">
          <span className={`quit-icon${copy.guarded ? " quit-icon-guarded" : ""}`}>
            <Power size={15} />
          </span>
          <div className="quit-heading">
            <span id="quit-title" className="modal-title">
              {copy.title}
            </span>
            <span className={`mode-badge quit-mode ${live ? "mode-badge-live" : "mode-badge-sim"}`}>
              {live ? "LIVE" : "simulated"}
            </span>
          </div>
        </div>

        <div id="quit-body" className="quit-body">
          <p className="modal-lead">{copy.lead}</p>
          {copy.consequences.length > 0 && (
            <ul className="modal-list quit-list">
              {copy.consequences.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="modal-foot">
          <button
            ref={cancelRef}
            className={`btn${copy.guarded ? " btn-primary" : ""}`}
            onClick={() => answer(false)}
          >
            Cancel
          </button>
          <button
            ref={quitRef}
            className={`btn${copy.guarded ? "" : " btn-primary"}`}
            onClick={() => answer(true)}
          >
            Quit
          </button>
        </div>
      </div>
    </div>
  );
}
