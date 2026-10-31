import { useCallback, useEffect, useState } from "react";
import { IntegrationsPane } from "@/components/integrations-pane";
import { NotificationsPane } from "@/components/notifications-pane";
import { ModePane } from "@/components/mode-pane";
import { UsagePanel } from "@/components/usage-panel";
import { CandleCoveragePane } from "@/components/candle-coverage-pane";
import { api, isError, type SetupStatus, type ActivityEvent } from "@/lib/api";
import { DENSITIES, getDensity, setDensity, type Density } from "@/lib/density";

/**
 * Settings — 200px section nav, one pane at a time.
 *
 * The prototype's structure, with one honesty change: the risk-limit editor is
 * shown as read-only "not enforced yet". Limits that appear editable but are
 * checked by nothing would be the most misleading control in the app — a user
 * would reasonably believe they were protected.
 */
const SECTIONS = [
  /* First, because it is the one setting that changes what the app can do. */
  { id: "mode", label: "Mode" },
  { id: "appearance", label: "Appearance" },
  { id: "limits", label: "Risk limits" },
  { id: "integrations", label: "Integrations" },
  { id: "notifications", label: "Notifications" },
  { id: "models", label: "Models & cost" },
  { id: "feeds", label: "Data & feeds" },
  { id: "audit", label: "Audit log" },
  { id: "diagnostics", label: "Diagnostics" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** The limits the Phase 4 risk engine will enforce. Values are the plan's
 *  defaults, displayed so the intended shape is reviewable before it's live. */
const PLANNED_LIMITS: { label: string; note: string; value: string }[] = [
  { label: "Max capital per pair", note: "share of total equity", value: "20%" },
  { label: "Max daily loss", note: "halts the session, not just the order", value: "5%" },
  { label: "Max open positions", note: "across all sessions", value: "3" },
  { label: "Max orders per day", note: "Revolut X caps limit orders at 1,000/day", value: "50" },
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
          Themes, accent colours and chart palettes are planned — see the roadmap in <code>docs/PLAN.md</code> §16.
        </p>
      </div>
    </section>
  );
}

function DiagnosticsPane() {
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
  const [section, setSection] = useState<SectionId>("integrations");
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
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`settings-nav-item ${section === s.id ? "settings-nav-item-active" : ""}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="settings-pane vy-scroll">
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
              These are the values the risk engine will be built to enforce (Phase 4). They are
              displayed read-only on purpose: an editable field that nothing checks would imply a
              protection that does not exist.
            </div>
          </section>
        )}

        {section === "mode" && <ModePane />}

        {section === "notifications" && <NotificationsPane />}

        {section === "integrations" && (
          <IntegrationsPane setup={setup} setupError={setupError} onRefresh={onRefresh} />
        )}

        {section === "models" && (
          <>
            <UsagePanel />
          <section className="panel">
            <div className="panel-header">
              <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Models & cost</span>
            </div>
            <div className="panel-body" style={{ fontSize: "var(--text-md)", color: "var(--muted-foreground)", lineHeight: 1.6 }}>
              The chat model is chosen per session in the agent drawer. Post-trade reviews run
              unattended on a cheaper model — <span className="mono">claude-haiku-4-5-20251001</span> by
              default, overridable with the <span className="mono">review_model</span> settings key.
              <div style={{ marginTop: 8, color: "var(--text-faint)", fontSize: "var(--text-sm)" }}>
                Per-call cost accounting isn't tracked yet.
              </div>
            </div>
          </section>
          </>
        )}

        {section === "feeds" && (
          <section className="panel">
            <div className="panel-header">
              <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Data & feeds</span>
            </div>
            <div className="panel-body" style={{ fontSize: "var(--text-md)", color: "var(--muted-foreground)", lineHeight: 1.7 }}>
              <p>
                <strong style={{ color: "var(--foreground)" }}>Binance</strong> is the analysis feed —
                charts, indicators, backtests, paper fills, strategy triggers. One cached history per
                symbol so a chart can never disagree with the engine that traded on it.
              </p>
              <p style={{ marginTop: 8 }}>
                <strong style={{ color: "var(--foreground)" }}>Revolut X</strong> is execution and
                reconciliation truth — balances, orders, fills. It is never charted from.
              </p>
              <p style={{ marginTop: 8, color: "var(--text-faint)" }}>
                Analysis is USD-quote only; no FX conversion happens anywhere. The basis monitor samples
                the RevX-vs-Binance spread every 60s and feeds the measured value into backtest slippage.
              </p>
              {dbStatus && (
                <p className="mono" style={{ marginTop: 10, color: "var(--text-faint)", fontSize: "var(--text-sm)" }}>
                  database {dbStatus}
                </p>
              )}
            </div>
          </section>
        )}

        {section === "feeds" && <CandleCoveragePane />}

        {section === "appearance" && <AppearancePane />}

        {section === "diagnostics" && <DiagnosticsPane />}

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
