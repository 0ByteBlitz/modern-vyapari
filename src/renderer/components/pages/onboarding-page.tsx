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

export function OnboardingPage({ setup, setupError, onRefresh, onFinish }: OnboardingPageProps) {
  return (
    <div className="onboarding">
      <div className="onboarding-content">
        {/* ── Welcome header ──────────────────────── */}
        <div className="onboarding-header">
          <img src={logoUrl} alt="Modern Vyapari Logo" className="w-20 h-20 drop-shadow-md" />
          <div className="brand-lockup">
            <span className="brand-tagline" lang="ne" title={TAGLINE_EN}>
              {TAGLINE_NE}
            </span>
            <span className="brand-tagline-roman">{TAGLINE_ROMAN}</span>
          </div>
          <h1 className="onboarding-title">Welcome to Modern Vyapari</h1>
          <p className="onboarding-subtitle">
            Let's connect to your Revolut X account. This takes about 2 minutes.
          </p>
        </div>

        {/* ── Setup wizard (reused component) ─────── */}
        <div className="onboarding-card">
          <SetupCard setup={setup} setupError={setupError} onRefresh={onRefresh} onFinish={onFinish} />
        </div>

        {/* ── Footer hint ─────────────────────────── */}
        <p className="onboarding-hint">
          Your private key stays on this device, encrypted via your OS keychain.
          <br />
          The API key is stored with Electron's safeStorage — never in plain text.
        </p>
      </div>
    </div>
  );
}
