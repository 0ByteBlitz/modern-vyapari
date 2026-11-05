import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ShieldCheck } from "lucide-react";
import { SetupCard } from "@/components/setup-card";
import { SecurityPane } from "@/components/security-pane";
import { NotificationsPane } from "@/components/notifications-pane";
import { AppearancePane, LimitsPane } from "@/components/pages/settings-page";
import type { SetupStatus } from "@/lib/api";
import logoUrl from "../../assets/logo.svg";
import { TAGLINE_NE, TAGLINE_ROMAN, TAGLINE_EN } from "@/lib/brand";
import { Button } from "@/components/ui/button";

interface OnboardingPageProps {
  setup: SetupStatus | null;
  setupError: string;
  onRefresh: () => Promise<void>;
  onFinish: () => void;
}

const STORAGE_KEY = "vyapari:onboarding-step";
const STEPS = ["Welcome", "AI provider", "Trading venue", "Risk limits", "Appearance", "Screen lock", "Notifications", "Review"];

function savedStep(): number {
  const value = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isInteger(value) && value >= 0 && value < STEPS.length ? value : 0;
}

export function OnboardingPage({ setup, setupError, onRefresh, onFinish }: OnboardingPageProps) {
  const [step, setStep] = useState(savedStep);
  const [showOptionalVenue, setShowOptionalVenue] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(step));
  }, [step]);

  const goTo = (next: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, next)));
  const canFinish = !!setup?.setupComplete;
  const stepComplete = (index: number) => {
    if (index === 0) return index < step;
    if (index === 1) return !!setup?.ai.configured;
    if (index === 2) return !!setup && (!setup.venue.required || setup.venue.configured);
    return index < step;
  };

  return (
    <main className="onboarding">
      <header className="onboarding-topbar">
        <div className="onboarding-brand">
          <img src={logoUrl} alt="" className="onboarding-logo" />
          <div className="brand-lockup">
            <span className="brand-tagline" lang="ne" title={TAGLINE_EN}>{TAGLINE_NE}</span>
            <span className="brand-tagline-roman">{TAGLINE_ROMAN}</span>
          </div>
        </div>
        <span className="onboarding-topbar-label">Workspace setup</span>
      </header>

      <section className="onboarding-shell" aria-labelledby="onboarding-title">
        <div className="onboarding-heading">
          <span className="onboarding-eyebrow">A considered way to trade</span>
          <h1 id="onboarding-title">{step === 0 ? "Welcome to Modern Vyapari" : "Set up your workspace"}</h1>
          <p>{step === 0 ? "Make a plan you can follow, then sign it before it runs." : "Choose what you need now. You can change these settings later."}</p>
        </div>

        <nav className="onboarding-progress" aria-label="Setup progress">
          {STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              className={`onboarding-progress-step${index === step ? " is-current" : ""}${stepComplete(index) ? " is-done" : ""}`}
              aria-current={index === step ? "step" : undefined}
              onClick={() => index < step && goTo(index)}
              disabled={index > step}
            >
              <span className="onboarding-progress-mark">
                {stepComplete(index) ? <Check aria-hidden="true" /> : String(index + 1).padStart(2, "0")}
              </span>
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <section className="onboarding-step-panel" aria-live="polite">
          <div className="onboarding-step-heading">
            <span className="onboarding-step-kicker">Step {String(step + 1).padStart(2, "0")} of {String(STEPS.length).padStart(2, "0")}</span>
            <h2>{STEPS[step]}</h2>
          </div>

          {step === 0 && (
            <div className="onboarding-welcome">
              <h3>Make a plan.<br />Let it hold.</h3>
              <p className="onboarding-welcome-lead">Modern Vyapari helps you turn a market thesis into a plan you can follow.</p>
              <div className="onboarding-welcome-steps">
                <div><span>01</span><strong>Draft with the agent</strong><p>The agent helps shape a plan; it cannot arm or place orders.</p></div>
                <div><span>02</span><strong>Review and sign</strong><p>You approve the terms before a plan can run.</p></div>
                <div><span>03</span><strong>Let code follow the plan</strong><p>While the app is running, deterministic code follows the signed terms.</p></div>
              </div>
              <p className="onboarding-welcome-note">Current mode: {setup?.mode === "live" ? "Live" : "Simulated"}. Paper fills are estimates; live order placement is not available yet.</p>
            </div>
          )}

          {step === 1 && (
            <>
              <p className="onboarding-step-copy">Connect {setup?.ai.displayName ?? "an AI provider"} to enable the assistant. Your key stays on this device in encrypted storage.</p>
              <SetupCard setup={setup} setupError={setupError} onRefresh={onRefresh} tab="anthropic" />
            </>
          )}

          {step === 2 && (
            setup?.venue.required || showOptionalVenue ? (
              <>
                <p className="onboarding-step-copy">{setup?.venue.required
                  ? `Connect ${setup.venue.displayName} for the selected live mode.`
                  : "An exchange account is optional in simulated mode."}</p>
                <SetupCard setup={setup} setupError={setupError} onRefresh={onRefresh} tab="revolut" />
                {!setup?.venue.required && <button className="onboarding-text-button" type="button" onClick={() => setShowOptionalVenue(false)}>Use simulated mode without an exchange</button>}
              </>
            ) : (
              <div className="onboarding-info-card">
                <span className="onboarding-info-icon"><ShieldCheck aria-hidden="true" /></span>
                <div>
                  <h3>Simulated mode is ready</h3>
                  <p>It uses a paper account and needs no exchange credentials. Live order placement is not available yet.</p>
                </div>
                <span className="onboarding-ready-tag">Selected</span>
                <button className="onboarding-text-button" type="button" onClick={() => setShowOptionalVenue(true)}>Connect {setup?.venue.displayName ?? "an exchange"} anyway</button>
              </div>
            )
          )}

          {step === 3 && <><p className="onboarding-step-copy">These are the risk engine’s current limits. They are read-only, and no order passes through that engine yet.</p><LimitsPane /></>}
          {step === 4 && <><p className="onboarding-step-copy">Choose how compact the interface feels. This changes text and icon size only.</p><AppearancePane /></>}
          {step === 5 && <><p className="onboarding-step-copy">Windows Hello can lock the app when you open it, when Windows locks, or after inactivity.</p><SecurityPane /></>}
          {step === 6 && <><p className="onboarding-step-copy">Telegram is optional. In-app alerts work without it.</p><NotificationsPane /></>}
          {step === 7 && (
            <div className="onboarding-summary">
              <div className="onboarding-summary-status">
                <span className={canFinish ? "is-ready" : "is-pending"}>{canFinish ? <Check aria-hidden="true" /> : null}</span>
                <div>
                  <h3>{canFinish ? "Your workspace is ready" : "One connection is still needed"}</h3>
                  <p>{canFinish ? "You can start in the Home view. Simulated fills are estimates; live order placement is not available." : "Connect the AI provider before opening the workspace."}</p>
                </div>
              </div>
              <dl>
                <div><dt>Mode</dt><dd>{setup?.mode === "live" ? "Live" : "Simulated"}</dd></div>
                <div><dt>AI provider</dt><dd>{setup?.ai.configured ? "Connected" : "Not connected"}</dd></div>
                <div><dt>Trading venue</dt><dd>{setup?.venue.configured ? "Connected" : setup?.venue.required ? "Required" : "Not needed for simulated mode"}</dd></div>
                <div><dt>Plan signature</dt><dd>You review and sign each plan before it can run.</dd></div>
              </dl>
              {!canFinish && <button className="onboarding-text-button" type="button" onClick={() => goTo(1)}>Return to AI provider setup</button>}
            </div>
          )}
        </section>

        <footer className="onboarding-footer">
          <span className="onboarding-security"><ShieldCheck aria-hidden="true" /> Credentials are encrypted with your operating system’s secure storage.</span>
          <div className="onboarding-actions">
            {step > 0 && <Button variant="outline" onClick={() => goTo(step - 1)}><ArrowLeft aria-hidden="true" /> Back</Button>}
            {step < STEPS.length - 1
              ? <Button onClick={() => goTo(step + 1)}>{step === 0 ? "Start setup" : "Continue"} <ArrowRight aria-hidden="true" /></Button>
              : <Button disabled={!canFinish} onClick={() => { localStorage.removeItem(STORAGE_KEY); onFinish(); }}>Open workspace <ArrowRight aria-hidden="true" /></Button>}
          </div>
        </footer>
      </section>
    </main>
  );
}
