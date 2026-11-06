import { useCallback, useEffect, useRef, useState } from "react";
import { api, isError, type SetupStatus, type Session, type PaperStats, errorText } from "@/lib/api";
import { Titlebar } from "@/components/titlebar";
import { AppToolbar, type BellEntry, type RiskChip, type TradingMode } from "@/components/app-toolbar";
import { ContextBar } from "@/components/context-bar";
import { SessionRail, isSessionSurface, type Surface } from "@/components/session-rail";
import { LockScreen } from "@/components/lock-screen";
import { OnboardingPage } from "@/components/pages/onboarding-page";
import { HomePage } from "@/components/pages/home-page";
import { DashboardPage } from "@/components/pages/dashboard-page";
import { MarketPage } from "@/components/pages/market-page";
import { BrowserPage } from "@/components/pages/browser-page";
import { SettingsPage, type SettingsSectionId } from "@/components/pages/settings-page";
import { OrdersPage } from "@/components/pages/orders-page";
import { PlansPage } from "@/components/pages/plans-page";
import { JournalPage } from "@/components/pages/journal-page";
import { PortfolioPage } from "@/components/pages/portfolio-page";
import { ApprovalsPage } from "@/components/pages/approvals-page";
import { ResearchPage } from "@/components/pages/research-page";
import { AlertsPage } from "@/components/pages/alerts-page";
import { ChatDrawer } from "@/components/chat-drawer";
import { AgentMascot } from "@/components/agent-mascot";
import { AlertToastHost } from "@/components/alert-toast";
import { formatUsd, formatPct, formatPrice } from "@/lib/format";
import { ModeContext } from "@/lib/mode";
import type { AppMode, HelloAvailability, LockStatus } from "@/lib/api";

/** Surface titles + subtitles for the context bar. */
function surfaceMeta(surface: Surface, session: Session | null, mode: AppMode): { title: string; sub: string } {
  /* A paused or archived session must never read as a running one — the pair
     alone looks identical either way. */
  const pair = session ? (session.status === "active" ? session.pair : `${session.pair} · ${session.status}`) : "no session";
  switch (surface) {
    case "home":
      return { title: "Home", sub: "everything, at a glance" };
    case "dashboard":
      return { title: "Dashboard", sub: `${pair} · ${mode}` };
    case "orders":
      return { title: "Orders & fills", sub: `${pair} · ${mode} fills` };
    case "plans":
      return { title: "Scenario plans", sub: `${pair} · a thesis the engine monitors` };
    case "journal":
      return { title: "Journal & memory", sub: `${pair} · reviews and lessons` };
    case "research":
      return { title: "Charts", sub: `${pair} · Binance analysis feed` };
    case "alerts":
      return { title: "Active alerts", sub: `${pair} · streaming condition rules` };
    case "portfolio":
      return { title: "Portfolio", sub: "all sessions · read-only aggregate" };
    case "markets":
      return { title: "Markets", sub: "all pairs · Binance analysis feed" };
    case "browser":
      return { title: "Research browser", sub: "external pages · not a trigger source" };
    case "approvals":
      return { title: "Approvals & safety", sub: "no orders to approve until live trading exists" };
    case "settings":
      return { title: "Settings", sub: "how the app trades, thinks and reaches you" };
  }
}

const UNANSWERED: LockStatus = {
  locked: true,
  hello: "available",
  settings: { lockAtLaunch: true, lockWithWindows: true, idleMinutes: null },
};

/**
 * The app lock. Main holds it (security/app-lock.ts) and refuses requests
 * while it is set; this only follows it. The shell unmounts while locked, so
 * nothing on screen polls a main process that would refuse it, and every
 * surface reloads fresh after the unlock.
 */
export default function App() {
  const [lock, setLock] = useState<LockStatus | null>(null);

  const readLock = useCallback(async () => {
    const res = await api.getLockStatus();
    /* Unanswerable means locked: an error here must never open the app. */
    setLock(isError(res) ? UNANSWERED : res);
  }, []);

  useEffect(() => {
    const off = api.onLockChanged(setLock);
    void readLock();
    return off;
  }, [readLock]);

  if (lock === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="animate-pulse text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }
  if (lock.locked) return <LockScreen onUnlock={() => void readLock()} />;
  /* The owner asked for a lock this device cannot provide: said on every
     surface, not left to be discovered. */
  const { lockAtLaunch, lockWithWindows, idleMinutes } = lock.settings;
  const wantsLock = lockAtLaunch || lockWithWindows || idleMinutes !== null;
  return <Shell lockNotice={wantsLock && lock.hello !== "available" ? lock.hello : null} />;
}

function Shell({ lockNotice }: { lockNotice: Exclude<HelloAvailability, "available"> | null }) {
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
  /* A pair to open Markets on (a Home mover). `n` changes per request, so the
     same tile clicked twice still re-opens it. */
  const [marketSymbol, setMarketSymbol] = useState<{ symbol: string; n: number } | null>(null);
  /* A request to open a Settings section from elsewhere (the AI spend chip).
     `n` changes on every request so asking twice re-opens it. */
  const [settingsSection, setSettingsSection] = useState<{ id: SettingsSectionId; n: number } | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  /* Alert history lives at the root so the bell has something to open. Toasts
     auto-dismiss after 12s; without this, an alert that fired while you were
     reading something else was simply gone. In-memory by design — alerts are
     already persisted in the DB; this is the "since you've been looking away"
     list, not an archive. */
  const [alertHistory, setAlertHistory] = useState<BellEntry[]>([]);
  const [unreadAlerts, setUnreadAlerts] = useState(0);

  useEffect(() => {
    let seq = 0;
    const push = (entry: Omit<BellEntry, "key">) => {
      setAlertHistory((prev) => [{ ...entry, key: `${entry.kind}-${entry.at}-${++seq}` }, ...prev].slice(0, 30));
      setUnreadAlerts((n) => n + 1);
    };
    const offAlert = api.onAlertTriggered((e) =>
      push({
        kind: "alert",
        title: e.label,
        detail: e.symbol + (e.currentValue !== null && e.currentValue !== undefined ? ` · now ${formatPrice(e.currentValue)}` : ""),
        at: e.triggeredAt,
      })
    );
    /* Plan events (triggered, invalidated, expired) and the engine's own
       warnings (a silent feed, an alert it could not check). The body's last
       line is the reason — a plan's thesis comes first. */
    const offPlan = api.onNotifyEvent((e) =>
      push({ kind: e.kind.startsWith("plan_") ? "plan" : "engine", title: e.title, detail: e.body.split("\n").filter(Boolean).pop() ?? "", at: e.at })
    );
    return () => {
      offAlert();
      offPlan();
    };
  }, []);

  /* What the agent is doing, named by main per tool ("Drafting a plan"). Not
     the page title: the page on screen is often not where the tool works. */
  const [agentActivity, setAgentActivity] = useState<string | null>(null);
  /* The plan a turn drafted, to open on Plans. `key` re-opens it when the same
     plan is focused twice. */
  const [agentFocusPlan, setAgentFocusPlan] = useState<{ planId: number; key: number } | null>(null);

  /* What is on screen, for the agent-navigation listener below, which is
     registered once and would otherwise read the first render's values. */
  const screenRef = useRef<{ session: Session | null; surface: Surface }>({ session: null, surface: "home" });
  screenRef.current = { session: activeSession, surface };

  /* Agent-driven navigation: main moves the UI at most once per turn, to where
     the turn's work landed — Plans with the drafted plan open, for instance —
     plus before a tool that reads the screen itself (a chart screenshot).

     Only the conversation on screen may move it. A session's agent moves the
     screen only while that session is open on one of its own surfaces; the
     general agent only while no session surface is showing. Without this, a
     reply that outlived a session switch — or a turn for a session that is not
     open at all — dropped the owner onto a session page with no session behind
     it, or onto another session's Plans with a foreign plan "focused". */
  useEffect(() => {
    const offNav = api.onAgentNavigate(({ surface: s, conversation, focusPlanId }) => {
      const valid: Surface[] = [
        "dashboard", "orders", "plans", "journal", "research", "alerts",
        "portfolio", "markets", "approvals", "settings", "browser",
      ];
      if (!valid.includes(s as Surface)) return;
      const { session, surface: shown } = screenRef.current;
      const onSessionSurface = session !== null && isSessionSurface(shown);
      const onScreen =
        conversation === "general" ? !onSessionSurface : onSessionSurface && session.id === conversation;
      if (!onScreen) return;
      setSurface(s as Surface);
      if (focusPlanId !== undefined) setAgentFocusPlan({ planId: focusPlanId, key: Date.now() });
    });
    const offActing = api.onAgentActing((activity) => {
      setAgentActivity(activity);
    });
    return () => {
      offNav();
      offActing();
    };
  }, []);
  /* Main decides: simulated mode needs only an AI provider; live mode also
     needs the venue. Re-deriving it here from venue-specific key flags is what
     used to lock onboarding to one exchange. */
  const isSetupComplete = Boolean(setup?.setupComplete);

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
    /* Same rule as the chat and the rail: the toolbar's "session pnl" belongs
       to a session only while you are on one of its surfaces. */
    if (!activeSession || !isSessionSurface(surface)) {
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

  const meta = surfaceMeta(surface, activeSession, setup.mode);
  /** The session whose agent drawer is on screen: only on its own surfaces. */
  const sessionChat = activeSession && isSessionSurface(surface) ? activeSession : null;

  /* The session's figures, in the toolbar only while one of its surfaces is
     open — on a global surface they would belong to nothing on screen. */
  const riskChips: RiskChip[] = sessionChat
    ? [
        {
          label: "session pnl",
          value: stats ? formatUsd(stats.realizedPnl, { sign: true }) : "—",
          tone: !stats ? "neutral" : stats.realizedPnl > 0 ? "up" : stats.realizedPnl < 0 ? "down" : "neutral",
        },
        {
          label: "win rate",
          value: stats && stats.closedCount > 0 ? formatPct(stats.winRate, 0) : "—",
          tone: "neutral",
        },
        {
          label: "open",
          value: stats ? `${stats.openCount}` : "—",
          tone: stats && stats.openCount > 0 ? "caution" : "neutral",
        },
      ]
    : [];
  /* From main, like the titlebar's badge. A constant here once read "paper"
     while main ran live — two answers to the one question that may not have
     two. `setup` is non-null here — the gate above returns until it loads. */
  const mode: TradingMode = setup.mode;

  return (
    <ModeContext.Provider value={mode}>
    <div className="app-shell">
      <AlertToastHost onOpenBot={() => setSurface("alerts")} />
      <Titlebar
        onOpenUsage={() => {
          setSettingsSection({ id: "usage", n: Date.now() });
          setSurface("settings");
          setAlertsOpen(false);
        }}
      />
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
      {lockNotice && (
        <div className="lock-notice" role="status">
          {lockNotice === "unavailable"
            ? "No lock: Windows Hello isn't set up. Add a PIN or fingerprint in Windows Settings › Accounts › Sign-in options."
            : "No lock: this system has no Windows Hello."}
        </div>
      )}
      <main className={`app-main ${agentActivity ? "agent-acting" : ""}`}>
        {agentActivity && (
          <div className="agent-acting-badge">
            <div className="agent-acting-badge-dot" />
            <span>Agent: {agentActivity}…</span>
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
          <ContextBar title={meta.title} subtitle={meta.sub} />
          <div className="stage-body vy-scroll">
            {surface === "home" && (
              <HomePage
                setup={setup}
                onOpenSession={(id) => void openSessionById(id)}
                onNavigate={(s) => setSurface(s)}
                onOpenMarket={(symbol) => {
                  setMarketSymbol({ symbol, n: Date.now() });
                  setSurface("markets");
                }}
              />
            )}
            {surface === "dashboard" && <DashboardPage activeSession={activeSession} />}
            {surface === "orders" && <OrdersPage activeSession={activeSession} />}
            {surface === "plans" && activeSession && <PlansPage session={activeSession} focus={agentFocusPlan} />}
            {surface === "journal" && <JournalPage activeSession={activeSession} />}
            {/* Research is the full charting workspace (KLineChart + drawing
                tools), scoped to the session's pair. Markets stays the
                lightweight scanner across every pair. */}
            {surface === "research" && <ResearchPage activeSession={activeSession} />}
            {surface === "alerts" && <AlertsPage activeSession={activeSession} />}
            {surface === "markets" && (
              <MarketPage key={marketSymbol?.n ?? 0} initialSymbol={marketSymbol?.symbol} />
            )}
            {surface === "portfolio" && (
              <PortfolioPage onOpenSession={(s) => void openSessionById(s.id)} />
            )}
            {surface === "approvals" && <ApprovalsPage />}
            {surface === "browser" && <BrowserPage />}
            {surface === "settings" && (
              <SettingsPage
                key={settingsSection?.n ?? 0}
                openSection={settingsSection?.id}
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
        {/* Two agents (31 Oct 2026). The SESSION agent is the drawer, and it
            follows the rail's rule: a session is only "open" on one of its own
            surfaces. The GLOBAL agent is the mascot, on every surface, in the
            lower-right corner — moving left only to sit beside the drawer.
            Both hidden on the embedded browser, which owns its own
            WebContentsView bounds and would be overlapped. */}
        {surface !== "browser" && sessionChat && (
          <ChatDrawer session={sessionChat} open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
        )}
        {surface !== "browser" && (
          <AgentMascot
            dock={!sessionChat ? "corner" : chatOpen ? "drawer" : "rail"}
            selectedSession={activeSession}
            onOpenSession={(s) => void selectSession(s)}
          />
        )}
      </main>
    </div>
    </ModeContext.Provider>
  );
}
