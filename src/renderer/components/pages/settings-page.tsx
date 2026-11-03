import { useCallback, useEffect, useState } from "react";
import { ExchangePane } from "@/components/exchange-pane";
import { NotificationsPane } from "@/components/notifications-pane";
import { ModePane } from "@/components/mode-pane";
import { SimulatedAccountPane } from "@/components/account-pane";
import { AiPane } from "@/components/ai-pane";
import { FeedPane } from "@/components/feed-pane";
import { UsagePanel } from "@/components/usage-panel";
import { SecurityPane } from "@/components/security-pane";
import { api, isError, errorText, type SetupStatus, type ActivityEvent, type RiskLimitsView } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { DENSITIES, getDensity, setDensity, type Density } from "@/lib/density";
import { RefreshButton } from "@/components/refresh-button";

/**
 * Settings — 200px section nav, one pane at a time.
 *
 * The prototype's structure, with one honesty change: the risk limits are
 * read-only, and read from the engine. They once showed the plan's intended
 * values ("max daily loss 5%") while the engine used $500 absolute — numbers
 * the code did not use. Limits that appear editable but are checked by nothing
 * would be the most misleading control in the app.
 *
 * **Grouped by what each setting powers** (2026-11-01). The flat list mixed
 * levels — "Integrations" held the exchange, the analysis feed and every key;
 * "Mode" held the account balance; "Models & cost" held spend but no model
 * choice; the feed was described on two pages. Each key now sits beside the
 * thing it powers, and every group answers one question.
 */
const GROUPS = [
  {
    label: "General",
    sections: [
      /* First, because it is the one setting that changes what the app can do. */
      { id: "mode", label: "Mode" },
      { id: "security", label: "Security" },
      { id: "appearance", label: "Appearance" },
    ],
  },
  {
    label: "Trading",
    sections: [
      { id: "exchange", label: "Exchange" },
      { id: "account", label: "Simulated account" },
      { id: "limits", label: "Risk limits" },
    ],
  },
  {
    label: "AI",
    sections: [
      { id: "ai", label: "Provider & models" },
      { id: "usage", label: "Usage & cost" },
    ],
  },
  { label: "Data", sections: [{ id: "feed", label: "Analysis feed" }] },
  { label: "Alerts", sections: [{ id: "notifications", label: "Telegram" }] },
  {
    label: "System",
    sections: [
      { id: "audit", label: "Audit log" },
      { id: "diagnostics", label: "Diagnostics" },
    ],
  },
] as const;

type SectionId = (typeof GROUPS)[number]["sections"][number]["id"];
export type SettingsSectionId = SectionId;

/** Checks the order path needs and the risk engine does not make. Named so
 *  their absence is on the page rather than discovered. */
const NOT_CHECKED: { label: string; note: string }[] = [
  { label: "Capital per pair", note: "as a share of equity" },
  { label: "Time between orders", note: "a misfiring trigger is not throttled" },
  { label: "Price against the venue", note: "the order price is not compared with the venue's" },
  { label: "Balance", note: "the account is not read before an order" },
  { label: "Duplicate orders", note: "a repeated order is not recognised" },
];

/**
 * Risk limits — the engine's own numbers (`risk-engine.ts` `RISK_DEFAULTS`,
 * read over IPC), plus what it does not check.
 *
 * "Not on any order path yet" is the truth today: `order-pipeline.ts` is the
 * only caller of `evaluateRisk`, and nothing calls it. Change that line in the
 * same PR that wires it.
 */
function LimitsPane() {
  const [limits, setLimits] = useState<RiskLimitsView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api.getRiskLimits();
      if (isError(res)) setProblem(errorText(res));
      else setLimits(res);
    })();
  }, []);

  const rows: { label: string; note: string; value: string }[] = limits
    ? [
        { label: "Max order size", note: "per order", value: `$${formatUsd(limits.maxPositionUsd)}` },
        { label: "Max daily loss", note: "realised, per session, in dollars", value: `$${formatUsd(limits.maxDailyLossUsd)}` },
        { label: "Max open positions", note: "per session", value: String(limits.maxOpenPositions) },
        { label: "Max trades per day", note: "per session", value: String(limits.maxDailyTrades) },
        { label: "Max spread", note: "at the moment of the order", value: `${limits.maxSpreadBps} bps` },
        { label: "Stop-loss", note: "on every buy", value: "required" },
      ]
    : [];

  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Risk engine</span>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--text-faint)" }}>
            checked in code before an order
          </span>
          <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--caution)" }}>
            not on any order path yet
          </span>
        </div>
        {problem && <p className="integ-problem" style={{ padding: "8px 12px" }}>{problem}</p>}
        {rows.map((l) => (
          <div key={l.label} className="limit-row">
            <div className="limit-label">
              <span style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>{l.label}</span>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>{l.note}</span>
            </div>
            <div className="limit-value mono">{l.value}</div>
          </div>
        ))}
        <div className="panel-footer">
          The engine's own values. No order passes through it yet: simulated fills don't, and live trading
          isn't built. Today a simulated plan is limited by the most it may spend, signed when you arm it,
          and by the kill switch, which blocks new entries.
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Not checked</span>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--text-faint)" }}>by the risk engine</span>
        </div>
        {NOT_CHECKED.map((l) => (
          <div key={l.label} className="limit-row">
            <div className="limit-label">
              <span style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>{l.label}</span>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>{l.note}</span>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

function clock(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Diagnostics — where internal detail lives.
 *
 * Error messages in the UI are deliberately short and free of internals
 * (see `src/shared/errors.ts`); the full stack traces, HTTP bodies and SQL
 * go to the log file. This pane is how you reach that when you actually
 * want it. Credentials are redacted before anything is written, so the file
 * is safe to share.
 */

/**
 * Appearance — currently just density, which rescales the type and icon
 * tokens app-wide.
 *
 * Density changes SIZE only, never what's on screen: a control that quietly
 * hid columns or rows would be a different feature wearing the same label.
 * Each option renders its own live specimen at its own scale, so the choice
 * is made by looking rather than by interpreting the word "compact".
 */
function AppearancePane() {
  const [density, setDensityState] = useState<Density>(() => getDensity());

  const choose = (d: Density) => {
    setDensity(d);
    setDensityState(d);
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <span style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>Interface density</span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-faint)", lineHeight: 1.5 }}>
          Scales text and icons everywhere. Nothing is hidden or removed at any setting — only the size changes.
        </p>

        <div className="density-options">
          {DENSITIES.map((d) => (
            <button
              key={d.id}
              className={`density-option ${density === d.id ? "density-option-active" : ""}`}
              onClick={() => choose(d.id)}
              /* Always set, including "default" — otherwise the Default
                 specimen would inherit whatever density is currently applied
                 and show the wrong sizes for the option it represents. */
              data-density={d.id}
            >
              <span className="density-option-label">{d.label}</span>
              <span className="density-option-desc">{d.description}</span>
              <span className="density-specimen">
                <span className="density-specimen-price" style={{ fontSize: "var(--text-2xl)" }}>
                  64,448.01
                </span>
                <span className="density-specimen-label" style={{ fontSize: "var(--text-micro)" }}>
                  BTC-USD
                </span>
              </span>
            </button>
          ))}
        </div>

        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-ghost)", lineHeight: 1.5 }}>
          Themes, accent colours and chart palettes aren't available yet.
        </p>
      </div>
    </section>
  );
}

function DiagnosticsPane({ dbStatus }: { dbStatus?: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [logPath, setLogPath] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);

  const load = useCallback(async () => {
    const [l, p] = await Promise.all([api.getRecentLogs(300), api.getLogPath()]);
    if (!isError(l)) setLines(l.lines);
    if (!isError(p)) setLogPath(p.path);
    return !isError(l);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = onlyErrors ? lines.filter((l) => l.includes(" ERROR") || l.includes(" WARN")) : lines;

  return (
    <section className="panel">
      <div className="panel-header">
        <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Application log</span>
        <label className="flex cursor-pointer select-none items-center gap-1.5" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
          <input type="checkbox" className="accent-primary" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
          errors & warnings only
        </label>
        <span className="ml-auto">
          <RefreshButton onRefresh={load} title="Refresh the log" />
        </span>
        <button className="btn" onClick={() => void api.revealLogs()}>Open file</button>
      </div>

      <div className="panel-body-flush vy-scroll" style={{ maxHeight: 460 }}>
        {shown.length === 0 ? (
          <div className="empty-state">Nothing logged yet.</div>
        ) : (
          <pre className="diag-log">{shown.join("\n")}</pre>
        )}
      </div>

      <div className="panel-footer" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
        <span className="mono" style={{ fontSize: "var(--text-xs)" }}>{logPath}</span>
        {/* Moved here from the Settings subtitle, where "v21 · 7 sessions"
            was internal detail on every visit. */}
        {dbStatus && <span className="mono" style={{ fontSize: "var(--text-xs)" }}>database {dbStatus}</span>}
        <span>
          API keys, signatures and private keys are redacted before writing, so this file is safe to share.
          Rotates at 2 MB, keeps 5 files.
        </span>
      </div>
    </section>
  );
}

interface SettingsPageProps {
  setup: SetupStatus | null;
  setupError: string;
  onRefresh: () => Promise<void>;
  dbStatus?: string;
  /** Open on this section, e.g. Usage & cost from the titlebar's spend chip. */
  openSection?: SectionId;
}

export function SettingsPage({ setup, setupError, onRefresh, dbStatus, openSection }: SettingsPageProps) {
  /* Opens where something is missing: without the AI key nothing else in the
     app works, so that comes first; otherwise the first section. */
  const [section, setSection] = useState<SectionId>(
    openSection ?? (setup && !setup.hasAnthropicApiKey ? "ai" : "mode")
  );
  const [audit, setAudit] = useState<ActivityEvent[]>([]);
  const [auditScope, setAuditScope] = useState<"all" | "agent">("all");

  const loadAudit = useCallback(async () => {
    const res = await api.listActivity(80, auditScope);
    if (isError(res)) return false;
    setAudit(res);
    return true;
  }, [auditScope]);

  useEffect(() => {
    if (section !== "audit") return;
    void loadAudit();
    return api.onDataUpdated(({ kind }) => {
      if (kind === "audit") void loadAudit();
    });
  }, [section, loadAudit]);

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        {GROUPS.map((g) => (
          <div key={g.label} className="settings-nav-group">
            <span className="settings-nav-heading">{g.label}</span>
            {g.sections.map((s) => (
              <button
                key={s.id}
                className={`settings-nav-item ${section === s.id ? "settings-nav-item-active" : ""}`}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="settings-pane vy-scroll">
        {/* Shown on every section: a setup error is never only one pane's. */}
        {setupError && <p className="integ-problem">{setupError}</p>}

        {section === "limits" && <LimitsPane />}

        {section === "security" && <SecurityPane />}

        {section === "mode" && <ModePane />}

        {section === "appearance" && <AppearancePane />}

        {section === "exchange" && <ExchangePane setup={setup} onRefresh={onRefresh} />}

        {section === "account" && <SimulatedAccountPane />}

        {section === "ai" && <AiPane setup={setup} onRefresh={onRefresh} />}

        {section === "usage" && <UsagePanel />}

        {section === "feed" && <FeedPane />}

        {section === "notifications" && <NotificationsPane />}

        {section === "diagnostics" && <DiagnosticsPane dbStatus={dbStatus} />}

        {section === "audit" && (
          <section className="panel">
            <div className="panel-header">
              <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Audit log</span>
              <label className="flex cursor-pointer select-none items-center gap-1.5" style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={auditScope === "agent"}
                  onChange={(e) => setAuditScope(e.target.checked ? "agent" : "all")}
                />
                agent only
              </label>
              <span className="ml-auto">
                <RefreshButton onRefresh={loadAudit} title="Refresh the audit log" />
              </span>
            </div>
            <table className="vy-table">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Time</th>
                  <th style={{ textAlign: "left" }}>Event</th>
                  <th style={{ textAlign: "left" }}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="t-text mono" style={{ color: "var(--text-faint)", fontSize: "var(--text-sm)" }}>
                      {clock(a.created_at)}
                    </td>
                    <td className="t-text" style={{ color: "var(--text-secondary)" }}>{a.action.replace(/_/g, " ")}</td>
                    <td
                      className="t-text mono"
                      style={{ color: "var(--text-faint)", fontSize: "var(--text-sm)", maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis" }}
                      title={a.detail}
                    >
                      {a.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {audit.length === 0 && <div className="empty-state">Nothing recorded yet.</div>}
            <div className="panel-footer">
              Append-only. Engine actions are written before they are taken; agent tool calls when they finish, with the outcome.
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
