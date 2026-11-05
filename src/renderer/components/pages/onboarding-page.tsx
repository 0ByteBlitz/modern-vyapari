import { ArrowDownRight, ArrowUpRight, ChartNoAxesCombined, ClipboardCheck, FilePenLine, KeyRound, ShieldCheck, Sparkles, Waypoints } from "lucide-react";
import { SetupCard } from "@/components/setup-card";
import type { SetupStatus } from "@/lib/api";
import logoUrl from "../../assets/logo.svg";
import { TAGLINE_NE, TAGLINE_ROMAN, TAGLINE_EN } from "@/lib/brand";

interface OnboardingPageProps {
  setup: SetupStatus | null;
  setupError: string;
  onRefresh: () => Promise<void>;
  onFinish: () => void;
}

const PLAN_STEPS = [
  { title: "Choose a market", icon: ChartNoAxesCombined },
  { title: "Read the chart", icon: Waypoints },
  { title: "Build a thesis", icon: FilePenLine },
  { title: "Draft a plan", icon: Sparkles },
  { title: "Check the terms", icon: ClipboardCheck },
  { title: "Sign the plan", icon: KeyRound },
  { title: "Monitor while the app runs", icon: ArrowUpRight },
  { title: "Review the outcome", icon: ArrowDownRight },
];

export function OnboardingPage({ setup, setupError, onRefresh, onFinish }: OnboardingPageProps) {
  return (
    <main className="onboarding">
      <div className="onboarding-layout">
        <section className="onboarding-intro" aria-labelledby="onboarding-title">
          <div className="onboarding-brand">
            <img src={logoUrl} alt="" className="onboarding-logo" />
            <div className="brand-lockup">
              <span className="brand-tagline" lang="ne" title={TAGLINE_EN}>{TAGLINE_NE}</span>
              <span className="brand-tagline-roman">{TAGLINE_ROMAN}</span>
            </div>
          </div>

          <div className="onboarding-copy">
            <span className="onboarding-eyebrow">A considered way to trade</span>
            <h1 id="onboarding-title" className="onboarding-title">Make a plan.<br />Let it hold.</h1>
            <p className="onboarding-subtitle">
              {setup?.venue.required
                ? "Connect an AI provider and trading venue to finish setup."
                : "Connect an AI provider to begin. Simulated mode needs no exchange account."}
            </p>
            <p className="onboarding-principle">
              The agent helps shape a draft. You review and sign it; deterministic code follows the terms while the app is running.
            </p>
          </div>

          <div className="onboarding-journey" aria-label="How a plan moves through Modern Vyapari">
            <div className="onboarding-journey-heading">
              <span>How a plan moves</span>
              <span className="onboarding-journey-count">01 — 08</span>
            </div>
            <ol className="onboarding-steps">
              {PLAN_STEPS.map(({ title, icon: Icon }, index) => (
                <li className="onboarding-step" key={title}>
                  <span className="onboarding-step-index">{String(index + 1).padStart(2, "0")}</span>
                  <Icon aria-hidden="true" className="onboarding-step-icon" />
                  <span>{title}</span>
                  {index === 5 && <ShieldCheck aria-label="Your signature" className="onboarding-signature" />}
                </li>
              ))}
            </ol>
            <p className="onboarding-mode-note">
              <span className="onboarding-mode-mark" aria-hidden="true" />
              Setup starts in simulated mode. Live order placement is not available yet.
            </p>
          </div>

          <p className="onboarding-security">
            <ShieldCheck aria-hidden="true" />
            Saved credentials are encrypted with your operating system’s secure storage.
          </p>
        </section>

        <section className="onboarding-setup" aria-labelledby="setup-heading">
          <div className="onboarding-setup-heading">
            <div>
              <span className="onboarding-eyebrow">First, a secure connection</span>
              <h2 id="setup-heading">Set up your workspace</h2>
            </div>
            <span className={`onboarding-setup-state${setup?.setupComplete ? " onboarding-setup-ready" : ""}`}>
              <span className="onboarding-state-dot" />
              {setup?.setupComplete ? "Ready" : "Setup"}
            </span>
          </div>
          <SetupCard setup={setup} setupError={setupError} onRefresh={onRefresh} onFinish={onFinish} />
          <p className="onboarding-setup-footnote">
            {setup?.venue.required
              ? "Both connections are required for the selected mode."
              : "An exchange connection can be added later in Settings."}
          </p>
        </section>
      </div>
    </main>
  );
}
