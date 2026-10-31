import { useCallback, useEffect, useState } from "react";
import { describeActivity, ACTIVITY_TONE_COLOR } from "@/lib/activity";
import { Fingerprint, Loader2 } from "lucide-react";
import { api, isError, type ActivityEvent, errorText } from "@/lib/api";
import logoUrl from "../assets/logo.svg";
import { TAGLINE_NE, TAGLINE_ROMAN, TAGLINE_EN } from "@/lib/brand";

interface LockScreenProps {
  onUnlock: () => void;
}

type PromptState = "idle" | "prompting" | "failed";

/**
 * App-launch gate: shown once per app start when Windows Hello is available
 * on the device. This is an additive layer on top of credential encryption
 * (safeStorage/DPAPI), not a replacement for it — see security/windows-hello.ts.
 */
export function LockScreen({ onUnlock }: LockScreenProps) {
  const [state, setState] = useState<PromptState>("idle");
  const [detail, setDetail] = useState("");
  /* "While you were away" — the engines keep running whether or not anyone is
     looking, so the lock screen carries the state across rather than making
     the user unlock first to find out what happened. */
  const [away, setAway] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    void (async () => {
      const res = await api.listActivity(6);
      if (!isError(res)) setAway(res);
    })();
  }, []);

  const prompt = useCallback(async () => {
    setState("prompting");
    setDetail("");
    const res = await api.requestWindowsHello("Unlock Modern Vyapari");
    if (isError(res)) {
      setState("failed");
      setDetail(errorText(res));
      return;
    }
    if (res.verified) {
      onUnlock();
      return;
    }
    setState("failed");
    setDetail(res.detail === "Canceled" ? "Cancelled — try again when you're ready." : "Verification failed.");
  }, [onUnlock]);

  // No auto-trigger: let the user see the lock screen (and the "while you
  // were away" activity feed) before they choose to authenticate. The Unlock
  // button calls prompt() when clicked.

  return (
    <div className="lock-screen">
      <div className="lock-screen-content">
        <img src={logoUrl} alt="Modern Vyapari" className="h-20 w-20" />
        {/* The one screen with room for the full lockup — Devanagari first,
            romanisation under it, since the app is used in both scripts. */}
        <div className="brand-lockup">
          <span className="brand-tagline" lang="ne" title={TAGLINE_EN}>
            {TAGLINE_NE}
          </span>
          <span className="brand-tagline-roman">{TAGLINE_ROMAN}</span>
        </div>
        <h1 className="lock-screen-title">Modern Vyapari is locked</h1>
        {/* The design's copy, kept verbatim: it states the security property
            (nothing trades while locked) rather than just how to get in. */}
        <p className="lock-screen-subtitle">Windows Hello · the app never trades while locked</p>

        <div className="lock-screen-status">
          {state === "prompting" && (
            <span className="lock-screen-status-line">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for Windows Hello…
            </span>
          )}
          {state === "failed" && <span className="lock-screen-status-line lock-screen-status-error">{detail}</span>}
        </div>

        {/* One spinner, not two: progress is reported by the status line above,
            so the button keeps its fingerprint icon and just goes quiet. */}
        <button className="lock-screen-btn" onClick={() => void prompt()} disabled={state === "prompting"}>
          <Fingerprint className="h-4 w-4" />
          {state === "failed" ? "Try again" : "Unlock"}
        </button>

        {away.length > 0 && (
          <div className="lock-away">
            <div className="lock-away-head label-micro">While you were away</div>
            <div className="lock-away-body">
              {away.map((ev) => {
                const d = describeActivity(ev);
                return (
                <div key={ev.id} className="lock-away-row">
                  <span style={{ color: ACTIVITY_TONE_COLOR[d.tone] }}>●</span>
                  {/* Same formatter as every other feed. The lock screen is the
                      first thing read after an absence, so a list of function
                      names is the worst place for one. */}
                  <span>{d.text}</span>
                  <span className="mono ml-auto" style={{ color: "var(--text-faint)" }}>
                    {new Date(ev.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                );
              })}
            </div>
            <div className="lock-away-foot">The app never trades while locked — this is what happened before it was.</div>
          </div>
        )}
      </div>
    </div>
  );
}
