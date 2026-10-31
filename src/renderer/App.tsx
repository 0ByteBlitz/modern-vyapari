import { useCallback, useEffect, useState } from "react";
import { api, isError, type SetupStatus, type Session, type PaperStats, type AlertEvent, errorText } from "@/lib/api";
import { Titlebar } from "@/components/titlebar";
import { AppToolbar, type RiskChip, type TradingMode } from "@/components/app-toolbar";
import { ContextBar } from "@/components/context-bar";
import { SessionRail, isSessionSurface, type Surface } from "@/components/session-rail";
import { LockScreen } from "@/components/lock-screen";
import { OnboardingPage } from "@/components/pages/onboarding-page";
import { HomePage } from "@/components/pages/home-page";
import { DashboardPage } from "@/components/pages/dashboard-page";
import { MarketPage } from "@/components/pages/market-page";
import { BrowserPage } from "@/components/pages/browser-page";
import { SettingsPage } from "@/components/pages/settings-page";
import { OrdersPage } from "@/components/pages/orders-page";
import { PlansPage } from "@/components/pages/plans-page";
import { JournalPage } from "@/components/pages/journal-page";
import { PortfolioPage } from "@/components/pages/portfolio-page";
import { ApprovalsPage } from "@/components/pages/approvals-page";
import { ResearchPage } from "@/components/pages/research-page";
import { AlertsPage } from "@/components/pages/alerts-page";
import { ChatDrawer } from "@/components/chat-drawer";
import { AlertToastHost } from "@/components/alert-toast";
import { formatUsd, formatPct } from "@/lib/format";

/** Surface titles + subtitles for the context bar. */
function surfaceMeta(surface: Surface, session: Session | null): { title: string; sub: string } {
  /* A paused or archived session must never read as a running one — the pair
     alone looks identical either way. */
  const pair = session ? (session.status === "active" ? session.pair : `${session.pair} · ${session.status}`) : "no session";
  switch (surface) {
    case "home":
      return { title: "Home", sub: "everything, at a glance" };
    case "dashboard":
      return { title: "Dashboard", sub: `${pair} · live paper state` };
    case "orders":
      return { title: "Orders & fills", sub: `${pair} · paper mode` };
    case "plans":
      return { title: "Scenario plans", sub: `${pair} · a thesis the engine monitors` };
    case "journal":
      return { title: "Journal & memory", sub: `${pair} · reviews and lessons` };
    case "research":
      return { title: "Research", sub: `${pair} · Binance analysis feed` };
    case "alerts":
      return { title: "Active alerts", sub: `${pair} · streaming condition rules` };
    case "portfolio":
      return { title: "Portfolio", sub: "all sessions · read-only aggregate" };
    case "markets":
      return { title: "Markets", sub: "all pairs · Binance analysis feed" };
    case "browser":
      return { title: "Research browser", sub: "external pages · not a trigger source" };
    case "approvals":
      return { title: "Approvals & safety", sub: "risk engine not built — Phase 4" };
    case "settings":
      return { title: "Settings", sub: "credentials · models · risk limits" };
  }
}

export default function App() {
  const [dbStatus, setDbStatus] = useState("…");
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [setupError, setSetupError] = useState("");
  /* Launch on Home, not on the last session's dashboard. Opening straight
     into a session answers "what is ARB-USD doing" before you've asked it,
     and hides everything that happened elsewhere while the app was closed. */
  const [surface, setSurface] = useState<Surface>("home");
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [stats, setStats] = useState<PaperStats | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  /* Alert history lives at the root so the bell has something to open. Toasts
     auto-dismiss after 12s; without this, an alert that fired while you were
     reading something else was simply gone. In-memory by design — alerts are
     already persisted in the DB; this is the "since you've been looking away"
     list, not an archive. */
  const [alertHistory, setAlertHistory] = useState<AlertEvent[]>([]);
  const [unreadAlerts, setUnreadAlerts] = useState(0);

  useEffect(() => {
    return api.onAlertTriggered((event) => {
      setAlertHistory((prev) => [event, ...prev].slice(0, 30));
      setUnreadAlerts((n) => n + 1);
    });
  }, []);

  const [agentActing, setAgentActing] = useState(false);

  /* Agent-driven navigation: when the agent uses a tool that targets a specific
     page (e.g. screenshot_research → Research, screenshot_browser → Browser),
     the main process sends an 'agent:navigate' event so the UI switches to that
     surface. This way the user sees what the agent is looking at in real time,
     like modern AI assistants that navigate to the page they're working on. */
  useEffect(() => {
    const offNav = api.onAgentNavigate((s) => {
      const valid: Surface[] = [
        "dashboard", "orders", "plans", "journal", "research", "alerts",
        "portfolio", "markets", "approvals", "settings", "browser",
      ];
      if (valid.includes(s as Surface)) setSurface(s as Surface);
    });
    const offActing = api.onAgentActing((acting) => {
      setAgentActing(acting);
    });
    return () => {
      offNav();
      offActing();
    };
  }, []);
  // App-launch gate: "checking" while we ask Windows whether Hello is set up
  // on this device, "locked" if so (until the user verifies), "unlocked"
  // once verified or immediately if Hello isn't available (fails open).
  const [helloState, setHelloState] = useState<"checking" | "locked" | "unlocked">("checking");

  useEffect(() => {
    void (async () => {
      const res = await api.checkWindowsHello();
      setHelloState(!isError(res) && res === "available" ? "locked" : "unlocked");
    })();
  }, []);

  const isSetupComplete = setup?.hasKeyPair && setup?.hasApiKey && setup?.hasAnthropicApiKey;

  const refreshStatus = useCallback(async () => {
    const db = await api.dbInfo();
    setDbStatus(isError(db) ? `DB error: ${errorText(db)}` : `v${db.schemaVersion} · ${db.sessionCount} sessions`);
    const s = await api.setupStatus();
    if (isError(s)) setSetupError(errorText(s));
    else {
      setSetup(s);
      setSetupError("");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (setup !== null && showOnboarding === null) setShowOnboarding(!isSetupComplete);
  }, [setup, isSetupComplete, showOnboarding]);

  useEffect(() => {
    void (async () => {
      const res = await api.getSelectedSession();
      if (!isError(res) && res) setActiveSession(res);
    })();
  }, []);

  /* Paper stats drive the toolbar's risk chips. */
  useEffect(() => {
    if (!activeSession) {
      setStats(null);
      return;
    }
    const load = async () => {
      const res = await api.getPaperStats(activeSession.id);
      setStats(isError(res) ? null : res);
    };
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [activeSession?.id, surface]);

  const selectSession = async (session: Session) => {
    const res = await api.selectSession(session.id);
    if (isError(res)) return;
    setActiveSession(res);
    if (!isSessionSurface(surface)) setSurface("dashboard");
  };

  const navigate = async (next: Surface, session?: Session) => {
    if (session && session.id !== activeSession?.id) {
      const res = await api.selectSession(session.id);
      if (!isError(res)) setActiveSession(res);
    }
    setSurface(next);
    setAlertsOpen(false);
  };

  /**
   * Re-sync with the main process after a session's status changes.
   *
   * Archiving the open session clears the selection in main (`setSessionStatus`
   * → `selectSession(null)`). Without this the shell would keep rendering that
   * session's surfaces against stale state — a Dashboard for a session the
   * engines have already stopped running.
   */
  const syncSelectedSession = useCallback(async () => {
    const res = await api.getSelectedSession();
    const next = isError(res) ? null : res;
    setActiveSession(next);
    if (!next) {
      setSurface((s) => (isSessionSurface(s) ? "home" : s));
    } else if (next.status === "archived") {
      // Readable, but nothing on a session surface should imply it's running.
      setSurface((s) => (isSessionSurface(s) && s !== "journal" ? "journal" : s));
    }
  }, []);

  /** Portfolio rows carry a summary, not a full Session — select by id so the
   *  main process stays the single source of truth for what's selected. */
  const openSessionById = async (id: number) => {
    const res = await api.selectSession(id);
    if (isError(res)) return;
    setActiveSession(res);
    setSurface("dashboard");
  };

  /* ── App-launch gate ── */
  if (helloState === "checking") {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="animate-pulse text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }
  if (helloState === "locked") return <LockScreen onUnlock={() => setHelloState("unlocked")} />;

  if (showOnboarding === true) {
    return (
      <OnboardingPage
        setup={setup}
        setupError={setupError}
        onRefresh={refreshStatus}
        onFinish={() => setShowOnboarding(false)}
      />
    );
  }

  if (setup === null || showOnboarding === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="animate-pulse text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  /* Risk budget shown in the toolbar. Only genuinely-known figures appear —
     an invented limit is worse than a missing one. */
  const riskChips: RiskChip[] = [
    {
      label: "session pnl",
      value: stats ? formatUsd(stats.realizedPnl, { sign: true }) : "—",
      pct: stats ? Math.min(100, Math.abs(stats.realizedPnl)) : 0,
      tone: !stats ? "neutral" : stats.realizedPnl > 0 ? "up" : stats.realizedPnl < 0 ? "down" : "neutral",
    },
    {
      label: "win rate",
      value: stats && stats.closedCount > 0 ? formatPct(stats.winRate, 0) : "—",
      pct: stats?.winRate ?? 0,
      tone: "neutral",
    },
    {
      label: "open",
      value: stats ? `${stats.openCount}` : "—",
      pct: stats ? Math.min(100, stats.openCount * 25) : 0,
      tone: stats && stats.openCount > 0 ? "caution" : "neutral",
    },
  ];

  const meta = surfaceMeta(surface, activeSession);
  const mode: TradingMode = "paper";

  return (
    <div className="app-shell">
      <AlertToastHost onOpenBot={() => setSurface("alerts")} />
      <Titlebar />
      <AppToolbar
        mode={mode}
        /* No risk engine, no execution engine — live mode is not reachable
           from the UI by design (plan Phase 4 gate). */
        onModeChange={null}
        riskChips={riskChips}
        unreadAlerts={unreadAlerts}
        alertsOpen={alertsOpen}
        onToggleAlerts={() => {
          setAlertsOpen((v) => !v);
          setUnreadAlerts(0);
        }}
        alertHistory={alertHistory}
        onClearAlerts={() => setAlertHistory([])}
      />
      <main className={`app-main ${agentActing ? "agent-acting" : ""}`}>
        {agentActing && (
          <div className="agent-acting-badge">
            <div className="agent-acting-badge-dot" />
            <span>Agent acting on {meta.title}…</span>
          </div>
        )}
        <SessionRail
          activeSessionId={activeSession?.id ?? null}
          surface={surface}
          onSelectSession={(s) => void selectSession(s)}
          onNavigate={(next, s) => void navigate(next, s)}
          onSessionsChanged={() => void syncSelectedSession()}
        />
        <div className="stage">
          <ContextBar title={meta.title} subtitle={surface === "settings" ? dbStatus : meta.sub} />
          <div className="stage-body vy-scroll">
            {surface === "home" && (
              <HomePage
                setup={setup}
                onOpenSession={(id) => void openSessionById(id)}
                onNavigate={(s) => setSurface(s)}
              />
            )}
            {surface === "dashboard" && <DashboardPage activeSession={activeSession} />}
            {surface === "orders" && <OrdersPage activeSession={activeSession} />}
            {surface === "plans" && activeSession && <PlansPage session={activeSession} />}
            {surface === "journal" && <JournalPage activeSession={activeSession} />}
            {/* Research is the full charting workspace (KLineChart + drawing
                tools), scoped to the session's pair. Markets stays the
                lightweight scanner across every pair. */}
            {surface === "research" && <ResearchPage activeSession={activeSession} />}
            {surface === "alerts" && <AlertsPage activeSession={activeSession} />}
            {surface === "markets" && <MarketPage />}
            {surface === "portfolio" && (
              <PortfolioPage onOpenSession={(s) => void openSessionById(s.id)} />
            )}
            {surface === "approvals" && <ApprovalsPage />}
            {surface === "browser" && <BrowserPage />}
            {surface === "settings" && (
              <SettingsPage
                setup={setup}
                setupError={setupError}
                onRefresh={refreshStatus}
                dbStatus={dbStatus}
              />
            )}
          </div>
        </div>
        {/* Chat is available from every surface, not just the dashboard —
            asking the bot about a backtest shouldn't mean navigating away
            from it. Hidden on the embedded browser, which owns its own
            WebContentsView bounds and would be overlapped. */}
        {surface !== "browser" && (
          <ChatDrawer session={activeSession} open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
        )}
      </main>
    </div>
  );
}
