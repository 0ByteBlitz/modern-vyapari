import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { api, isError, type SetupStatus } from "@/lib/api";

/**
 * Credentials, in the Settings visual language.
 *
 * `SetupCard` stays as-is for onboarding, where a guided "Step 01 / Step 02"
 * flow with its own inner tab strip is the right shape. Inside Settings it was
 * wrong twice over: it nested a second navigation inside the section nav, and
 * it carried onboarding chrome (glass cards, amber step labels, shield icons)
 * that exists nowhere else in the app. Here each credential is just a panel.
 *
 * **Each key is its own panel, placed beside what it powers** (2026-11-01):
 * the venue's keys under Exchange, the AI provider's under AI, Browserbase
 * under the agent's web tools. They used to be one block in Integrations, so
 * the one key setup needs sat below two optional ones.
 */
function Status({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span
      className="mono ml-auto"
      style={{ fontSize: "var(--text-xs)", color: ok ? "var(--up)" : "var(--text-faint)" }}
    >
      {label ?? (ok ? "configured" : "not set")}
    </span>
  );
}

function KeyInput({
  placeholder,
  value,
  onChange,
  onSave,
  disabled,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="password"
        className="settings-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && value.trim() && onSave()}
        spellCheck={false}
        autoComplete="off"
      />
      <button className="btn btn-primary" onClick={onSave} disabled={disabled || !value.trim()}>
        Save
      </button>
    </div>
  );
}

function Msg({ msg }: { msg: { text: string; ok: boolean } | null }) {
  if (!msg) return null;
  return (
    <span style={{ fontSize: "var(--text-sm)", color: msg.ok ? "var(--up)" : "var(--down)" }}>{msg.text}</span>
  );
}

type Saver = (
  fn: () => Promise<unknown>,
  setMsg: (m: { text: string; ok: boolean }) => void,
  clear: () => void
) => Promise<void>;

/** Save a key and report it in the panel's own words; refresh setup status after. */
function makeSaver(onRefresh: () => Promise<void>): Saver {
  return async (fn, setMsg, clear) => {
    const res = (await fn()) as { error?: string };
    if (res && typeof res === "object" && "error" in res && res.error) {
      setMsg({ text: res.error, ok: false });
      return;
    }
    setMsg({ text: "Saved and encrypted.", ok: true });
    clear();
    await onRefresh();
  };
}

interface KeyPanelProps {
  setup: SetupStatus;
  onRefresh: () => Promise<void>;
}

/** The venue's signing key pair and API key. */
export function VenueKeysPanel({ setup, onRefresh, note }: KeyPanelProps & { note?: string }) {
  const [apiKey, setApiKey] = useState("");
  const [apiKeyMsg, setApiKeyMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const save = makeSaver(onRefresh);

  return (
    <section className="panel">
      <div className="panel-header">
        <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Revolut X</span>
        <span style={{ fontSize: "var(--text-sm)", color: "var(--text-faint)" }}>{note ?? "execution venue"}</span>
        {/* Saved, not "connected": nothing here has made a call with them. */}
        <Status ok={Boolean(setup.hasKeyPair && setup.hasApiKey)} label={setup.hasKeyPair && setup.hasApiKey ? "keys saved" : "not set"} />
      </div>

      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="cred-row">
          <div className="cred-label">
            <span style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>Signing key pair</span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
              Ed25519. The private half never leaves this machine — it's encrypted with your OS keystore and
              never crosses into the UI.
            </span>
          </div>
          {setup.hasKeyPair ? (
            <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--up)" }}>generated</span>
          ) : (
            <button
              className="btn btn-primary"
              onClick={async () => {
                await api.generateKeys();
                await onRefresh();
              }}
            >
              Generate
            </button>
          )}
        </div>

        {setup.publicKeyPem && (
          <div style={{ position: "relative" }}>
            <pre className="cred-pem vy-scroll">{setup.publicKeyPem}</pre>
            <button
              className="btn cred-copy"
              onClick={async () => {
                await api.copyToClipboard(setup.publicKeyPem ?? "");
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
              Paste this public key into Revolut X when creating the API key.
            </span>
          </div>
        )}

        <div className="cred-row">
          <div className="cred-label">
            <span style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>API key</span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
              64-character key from Revolut X.
            </span>
          </div>
          <Status ok={setup.hasApiKey} />
        </div>
        <KeyInput
          placeholder={setup.hasApiKey ? "replace existing key…" : "paste API key…"}
          value={apiKey}
          onChange={setApiKey}
          onSave={() => void save(() => api.saveApiKey(apiKey), setApiKeyMsg, () => setApiKey(""))}
        />
        <Msg msg={apiKeyMsg} />
      </div>
    </section>
  );
}

/** The AI provider's key — the one key setup needs. */
export function AiKeyPanel({ setup, onRefresh }: KeyPanelProps) {
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicMsg, setAnthropicMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const save = makeSaver(onRefresh);

  return (
    <section className="panel">
      <div className="panel-header">
        <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Anthropic</span>
        <span style={{ fontSize: "var(--text-sm)", color: "var(--text-faint)" }}>
          powers the agent, reviews and lessons
        </span>
        <Status ok={setup.hasAnthropicApiKey} />
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <KeyInput
          placeholder={setup.hasAnthropicApiKey ? "replace existing key…" : "sk-ant-…"}
          value={anthropicKey}
          onChange={setAnthropicKey}
          onSave={() =>
            void save(() => api.saveAnthropicApiKey(anthropicKey), setAnthropicMsg, () => setAnthropicKey(""))
          }
        />
        <Msg msg={anthropicMsg} />
      </div>
    </section>
  );
}

/** Browserbase — the agent's optional cloud browser. */
export function BrowserbaseKeyPanel({ setup, onRefresh }: KeyPanelProps) {
  const [bbKey, setBbKey] = useState("");
  const [bbMsg, setBbMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const save = makeSaver(onRefresh);

  return (
    <section className="panel">
      <div className="panel-header">
        <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Browserbase</span>
        <span style={{ fontSize: "var(--text-sm)", color: "var(--text-faint)" }}>optional</span>
        <Status ok={setup.hasBrowserbaseKey} />
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p style={{ fontSize: "var(--text-md)", color: "var(--muted-foreground)", lineHeight: 1.6, margin: 0 }}>
          A cloud browser the agent falls back to when a page won't render locally. Local fetching stays the
          default, so free-plan minutes are only spent when they're needed.
        </p>
        <p style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)", lineHeight: 1.55, margin: 0 }}>
          CAPTCHA solving and stealth mode are off in every session this app creates — a challenged fetch fails
          rather than working around the site.
        </p>
        <KeyInput
          placeholder={setup.hasBrowserbaseKey ? "replace existing key…" : "bb_live_…"}
          value={bbKey}
          onChange={setBbKey}
          onSave={() => void save(() => api.saveBrowserbaseKey(bbKey), setBbMsg, () => setBbKey(""))}
        />
        <div className="flex items-center gap-2">
          <Msg msg={bbMsg} />
          {setup.hasBrowserbaseKey && (
            <button
              className="btn ml-auto"
              onClick={async () => {
                await api.clearBrowserbaseKey();
                setBbMsg({ text: "Removed.", ok: true });
                await onRefresh();
              }}
            >
              Remove key
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
