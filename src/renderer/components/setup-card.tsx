import { useState } from "react";
import { Check, Copy, KeyRound, ArrowRight, Wallet, Brain, ShieldCheck } from "lucide-react";
import { api, isError, type SetupStatus, errorText } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface SetupCardProps {
  setup: SetupStatus | null;
  setupError: string;
  onRefresh: () => Promise<void>;
  onFinish?: () => void;
  tab?: Tab;
}

type Tab = "revolut" | "anthropic";

export function SetupCard({ setup, setupError, onRefresh, onFinish, tab }: SetupCardProps) {
  /* The AI provider is always required; the venue only to go live — so start there. */
  const [selectedTab, setSelectedTab] = useState<Tab>("anthropic");
  const activeTab = tab ?? selectedTab;
  
  const [apiKey, setApiKey] = useState("");
  const [apiKeyMsg, setApiKeyMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicMsg, setAnthropicMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const onGenerateKeys = async () => {
    const res = await api.generateKeys();
    if (isError(res)) return;
    await onRefresh();
  };

  const onSaveApiKey = async () => {
    const res = await api.saveApiKey(apiKey);
    if (isError(res)) {
      setApiKeyMsg({ text: errorText(res), ok: false });
      return;
    }
    setApiKeyMsg({ text: "Key saved.", ok: true });
    setApiKey("");
    await onRefresh();
  };

  const onSaveAnthropicKey = async () => {
    const res = await api.saveAnthropicApiKey(anthropicKey);
    if (isError(res)) {
      setAnthropicMsg({ text: errorText(res), ok: false });
      return;
    }
    setAnthropicMsg({ text: "Key saved.", ok: true });
    setAnthropicKey("");
    await onRefresh();
  };

  const onCopyPublicKey = async () => {
    await api.copyToClipboard(setup?.publicKeyPem ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Tab configurations
  const TABS: { id: Tab; label: string; icon: any; isComplete: boolean; isOptional: boolean }[] = [
    {
      id: "anthropic",
      label: "AI Agent",
      icon: Brain,
      isComplete: !!setup?.ai.configured,
      isOptional: false,
    },
    {
      id: "revolut",
      label: "Trading Venue",
      icon: Wallet,
      isComplete: !!setup?.venue.configured,
      /* Simulated mode trades on paper and needs no exchange account. */
      isOptional: !setup?.venue.required,
    },
  ];

  if (!setup) return <div className="text-center p-8 text-muted-foreground animate-pulse">Loading secure vault...</div>;

  return (
    <Card className="onboarding-config-card">
      <div className="onboarding-config-layout">
        
        {/* Sidebar Tabs */}
        {!tab && <div className="onboarding-tabs" aria-label="Setup sections">
          <h3 className="onboarding-tabs-label">Connections</h3>
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setSelectedTab(tab.id)}
                className={`onboarding-tab${active ? " onboarding-tab-active" : ""}`}
                aria-pressed={active}
              >
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4" aria-hidden="true" />
                  <span>{tab.label}</span>
                </div>
                {tab.isComplete ? (
                  <ShieldCheck className="w-4 h-4 onboarding-tab-check" aria-label="Connected" />
                ) : tab.isOptional ? (
                  <span className="onboarding-optional">Optional</span>
                ) : null}
              </button>
            );
          })}
        </div>}

        {/* Content Area */}
        <div className="onboarding-config-content">
          {setupError && (
            <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
              {setupError}
            </div>
          )}

          {/* ─────────────────────────────────────────────────────────
              REVOLUT X TAB
              ───────────────────────────────────────────────────────── */}
          {activeTab === "revolut" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="flex items-start gap-4 mb-2">
                <div className="w-12 h-12 rounded-lg border border-border bg-background flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-xl font-bold text-foreground">{setup.venue.displayName} Connection</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Create signing keys for requests to this venue.
                  </p>
                </div>
              </div>
              {!setup.venue.required && (
                <p className="text-sm text-muted-foreground p-3 rounded-md border border-border bg-secondary/30">
                  Optional while you trade in simulated mode — simulated trading needs no exchange account.
                  Connect {setup.venue.displayName} to see your live balances.
                </p>
              )}

              <div className="space-y-4">
                {/* Step 1: Ed25519 Keys */}
                <div className="p-5 border border-border rounded-xl bg-background/50 backdrop-blur">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h4 className="text-[10px] font-bold text-warning uppercase tracking-widest mb-1">Step 01</h4>
                      <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                        Generate Signing Keys
                        {setup.hasKeyPair && <span className="text-[10px] bg-success/20 text-success px-2 py-0.5 rounded-sm uppercase tracking-wider font-bold">Generated</span>}
                      </h3>
                      <p className="text-xs text-muted-foreground mt-1">
                        This key pair signs authenticated requests to the venue.
                      </p>
                    </div>
                    {!setup.hasKeyPair && (
                      <Button onClick={onGenerateKeys} className="bg-primary hover:bg-primary/90 text-primary-foreground font-medium border-0 shadow-lg shadow-primary/20">
                        Generate New Pair
                      </Button>
                    )}
                  </div>
                  
                  {setup.hasKeyPair && (
                    <div className="space-y-2 mt-2">
                      <div className="relative">
                        <pre className="overflow-x-auto rounded-md border border-border bg-secondary/30 p-4 text-[11px] text-muted-foreground font-mono leading-relaxed">
                          {setup.publicKeyPem}
                        </pre>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="absolute top-2 right-2 h-8 w-8 hover:bg-secondary/80 hover:text-foreground text-muted-foreground" 
                          onClick={onCopyPublicKey}
                          title="Copy public key"
                        >
                          {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Step 2: API Key */}
                <div className={`p-5 border border-border rounded-xl transition-opacity ${!setup.hasKeyPair ? 'opacity-50 pointer-events-none' : ''} bg-background/50 backdrop-blur`}>
                  <div className="mb-4">
                    <h4 className="text-[10px] font-bold text-warning uppercase tracking-widest mb-1">Step 02</h4>
                    <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                      Enter API Credentials
                      {setup.hasApiKey && <span className="text-[10px] bg-success/20 text-success px-2 py-0.5 rounded-sm uppercase tracking-wider font-bold">Saved</span>}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      The unique identifier provided by the Revolut X dashboard.
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <Input
                      type="password"
                      placeholder="api_key_live_xxxxxxxxxxxxxxxx"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="flex-1 bg-secondary/50 h-10 font-mono text-xs"
                      autoComplete="off"
                    />
                    <Button 
                      onClick={onSaveApiKey} 
                      disabled={!apiKey.trim()} 
                      className="bg-primary hover:bg-primary/90 text-primary-foreground font-medium px-6 h-10 border-0 shadow-lg shadow-primary/10"
                    >
                      Save key
                    </Button>
                  </div>
                  {apiKeyMsg && (
                    <p className={`text-xs mt-3 font-medium ${apiKeyMsg.ok ? "text-success" : "text-destructive"}`}>{apiKeyMsg.text}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ─────────────────────────────────────────────────────────
              ANTHROPIC TAB
              ───────────────────────────────────────────────────────── */}
          {activeTab === "anthropic" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="flex items-start gap-4 mb-2">
                <div className="w-12 h-12 rounded-lg border border-border bg-background flex items-center justify-center shrink-0">
                  <Brain className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-foreground">{setup.ai.displayName}</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Connect {setup.ai.displayName} to enable the AI assistant.
                  </p>
                </div>
              </div>

              <div className="p-5 border border-border rounded-xl bg-background/50 backdrop-blur">
                <div className="mb-4">
                  <h4 className="text-[10px] font-bold text-warning uppercase tracking-widest mb-1">Step 01</h4>
                  <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                    API Configuration
                    {setup.hasAnthropicApiKey && <span className="text-[10px] bg-success/20 text-success px-2 py-0.5 rounded-sm uppercase tracking-wider font-bold">Active</span>}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Save your {setup.ai.displayName} API key to enable the AI assistant.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Input
                    type="password"
                    placeholder="sk-ant-..."
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    className="flex-1 bg-secondary/50 h-10 font-mono text-xs"
                    autoComplete="off"
                  />
                  <Button onClick={onSaveAnthropicKey} disabled={!anthropicKey.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground font-medium px-6 h-10 border-0 shadow-lg shadow-primary/10">
                    Save key
                  </Button>
                </div>
                {anthropicMsg && (
                  <p className={`text-xs mt-3 font-medium ${anthropicMsg.ok ? "text-success" : "text-destructive"}`}>{anthropicMsg.text}</p>
                )}
              </div>
            </div>
          )}

          {/* ─────────────────────────────────────────────────────────
              LAUNCH BUTTON (Only shown during onboarding when ready)
              ───────────────────────────────────────────────────────── */}
          {onFinish && setup.setupComplete && (
            <div className="mt-8 pt-6 border-t border-border flex justify-end animate-in fade-in duration-500">
              <Button onClick={onFinish} className="group">
                Continue to Dashboard
                <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
