import { useCallback, useEffect, useState } from "react";
import { ExchangePane } from "@/components/exchange-pane";
import { NotificationsPane } from "@/components/notifications-pane";
import { ModePane } from "@/components/mode-pane";
import { SimulatedAccountPane } from "@/components/account-pane";
import { AiPane } from "@/components/ai-pane";
import { FeedPane } from "@/components/feed-pane";
import { UsagePanel } from "@/components/usage-panel";
import { api, isError, type SetupStatus, type ActivityEvent } from "@/lib/api";
import { DENSITIES, getDensity, setDensity, type Density } from "@/lib/density";

/**
 * Settings — 200px section nav, one pane at a time.
 *
 * The prototype's structure, with one honesty change: the risk-limit editor is
 * shown as read-only "not enforced yet". Limits that appear editable but are
 * checked by nothing would be the most misleading control in the app — a user
 * would reasonably believe they were protected.
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

/** The limits the risk engine will enforce once it exists. Values are the plan's
 *  defaults, displayed so the intended shape is reviewable before it's live. */
const PLANNED_LIMITS: { label: string; note: string; value: string }[] = [
  { label: "Max capital per pair", note: "share of total equity", value: "20%" },
  { label: "Max daily loss", note: "halts the session, not just the order", value: "5%" },
  { label: "Max open positions", note: "across all sessions", value: "3" },
  { label: "Max orders per day", note: "exchanges also cap orders per day", value: "50" },
  { label: "Min time between orders", note: "throttles a misfiring strategy", value: "60s" },
  { label: "Feed staleness tolerance", note: "no orders on stale data", value: "3 intervals" },
];

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
        <button className="btn ml-auto" onClick={() => void load()}>Refresh</button>
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
}

export function SettingsPage({ setup, setupError, onRefresh, dbStatus }: SettingsPageProps) {
  /* Opens where something is missing: without the AI key nothing else in the
     app works, so that comes first; otherwise the first section. */
  const [section, setSection] = useState<SectionId>(setup && !setup.hasAnthropicApiKey ? "ai" : "mode");
  const [audit, setAudit] = useState<ActivityEvent[]>([]);

  const loadAudit = useCallback(async () => {
    const res = await api.listActivity(80);
    if (!isError(res)) setAudit(res);
  }, []);

  useEffect(() => {
    if (section === "audit") void loadAudit();
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

        {section === "limits" && (
          <section className="panel">
            <div className="panel-header">
              <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Hard limits</span>
              <span style={{ fontSize: "var(--text-sm)", color: "var(--text-faint)" }}>
                will be enforced in code before every order
              </span>
              <span className="mono ml-auto" style={{ fontSize: "var(--text-xs)", color: "var(--caution)" }}>
                not enforced yet
              </span>
            </div>
            {PLANNED_LIMITS.map((l) => (
              <div key={l.label} className="limit-row">
                <div className="limit-label">
                  <span style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>{l.label}</span>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>{l.note}</span>
                </div>
                <div className="limit-value mono">{l.value}</div>
              </div>
            ))}
            <div className="panel-footer">
              These are the values the risk engine will enforce once it exists. They are
              displayed read-only on purpose: an editable field that nothing checks would imply a
              protection that does not exist.
            </div>
          </section>
        )}

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
              <button className="btn ml-auto" onClick={() => void loadAudit()}>
                Refresh
              </button>
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
              Append-only. Written before an action is taken, never after.
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
