import { app, BrowserWindow, Menu, session } from "electron";
import * as path from "path";
import { registerIpcHandlers } from "./ipc";
import { initDatabase, getDb, auditLog } from "./db/database";
import { initSharedStore, adoptLegacyLessons, adoptLegacyUsage } from "./db/shared-store";
import { readMode, lockMode, appMode } from "./modes/app-mode";
import { initLogger, createLogger } from "./logger";
import { isResearchBrowserWebContents } from "./browser/embedded-browser";
import { attachQuitGuard } from "./services/quit-guard";

const log = createLogger("main");

// Security: fail fast if another instance is running (protects SQLite + future order state)
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Security: global safety net beyond the main window's own will-navigate/
// setWindowOpenHandler guards below — covers any webContents Electron creates
// later (devtools, future webviews) so a single missed spot can't become a
// navigation/popup escape hatch. Excludes the embedded research browser
// (Phase 1 surface 3) — that view is a real browser and needs normal
// link-following; it has its own popup handling in embedded-browser.ts.
app.on("web-contents-created", (_event, contents) => {
  if (isResearchBrowserWebContents(contents)) return;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (e) => e.preventDefault());

  // Enable native right-click context menu (Copy, Cut, Paste, Select All)
  contents.on("context-menu", (_e, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      menuItems.push(
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        { role: "selectAll" }
      );
    } else if (params.selectionText && params.selectionText.trim().length > 0) {
      menuItems.push(
        { role: "copy" },
        { type: "separator" },
        { role: "selectAll" }
      );
    }
    if (menuItems.length > 0) {
      Menu.buildFromTemplate(menuItems).popup({});
    }
  });
});

/** Shared reference so IPC handlers can access the window. */
export let mainWindow: BrowserWindow | null = null;

/* Windows loads .ico (multi-size, crisp in the taskbar); Linux cannot read .ico
   at all, so the window had no icon there. macOS ignores the window icon and
   shows the dock icon instead, which in an unpackaged dev run is Electron's
   own — set from the same PNG below. Packaged builds take their icons from
   electron-builder, not from here. */
const ICON_PATH = path.join(__dirname, "..", "..", "assets", process.platform === "win32" ? "icon.ico" : "icon.png");

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 600,
    title: "Modern Vyapari",
    icon: ICON_PATH,
    backgroundColor: "#080B10", // --background, so the first frame is not a flash of another colour
    // NOTE: no `frame: false` — it disables titleBarOverlay on Windows entirely.
    // titleBarStyle "hidden" + overlay gives the custom titlebar WITH native
    // min/max/close buttons (and Windows snap layouts) on the right.
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#05070a",       // --bg-void: the .titlebar background, so the native buttons sit on the same colour
      symbolColor: "#9AA7B8", // --muted-foreground
      height: 40,
    },
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // Made explicit for auditability even though these already match
      // Electron's defaults — the intent should be readable here, not implied.
    },
  });

  mainWindow = win;

  /* Confirm before closing, in the app's theme — with a native fallback so the
     window is always closable. See services/quit-guard.ts. */
  attachQuitGuard(win);

  win.on("closed", () => { mainWindow = null; });

  void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Security: block navigation away from the app and block new windows.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);   // hide native menu — app uses custom titlebar
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(ICON_PATH);

  // Security: deny every permission request (camera/mic/geolocation/notifications/...)
  // — the app has no legitimate use for any of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // Logger first: everything after this point should be able to report a
  // failure, including the database migration.
  initLogger(app.getPath("userData"));

  /* The mode is resolved and fixed BEFORE anything opens a database, because
     the mode decides which file opens. Anything unreadable resolves to
     simulated — a corrupt config must never be the reason the app comes up
     pointed at real money. */
  const mode = readMode(app.getPath("userData"));
  lockMode(mode);
  log.info(`Starting in ${mode} mode.`);

  initDatabase(app.getPath("userData"));
  /* Audited AFTER the database opens, not before — `auditLog` writes to it.
     The first version of this block recorded the mode first, which read
     naturally and threw "Database not initialized" on every launch. */
  auditLog("app_started", { mode });
  /* The one store both modes open: lessons, because what you learn about a
     market is true in both worlds, and API spend, because there is one
     Anthropic bill. Everything else stays mode-owned — a hit rate must never
     blend simulated fills with real ones. */
  initSharedStore(app.getPath("userData"));
  adoptLegacyLessons(getDb(), mode);
  adoptLegacyUsage(getDb(), mode);
  registerIpcHandlers();

  // Phase 3: paper trading engine + the post-trade review loop that hangs off
  // it. The review agent is attached as a *listener* on closed positions — it
  // runs after execution and can never influence it.
  const { paperEngine } = require("./paper/paper-exchange");
  const { attachReviewAgent, reviewPendingPositions, reviewPendingPlans } = require("./agent/review");
  attachReviewAgent(paperEngine);

  /* Read the gap BEFORE the first beat of this run — it is the only moment the
     previous run's end is still readable. An armed plan is only watched while
     this process is alive, and an unwatched window is otherwise
     indistinguishable from "price never came", which would quietly flatter the
     calibration record. */
  const heartbeat = require("./paper/monitor-heartbeat");
  const watchGap = heartbeat.gapSinceLastRun();
  if (watchGap) {
    log.warn(
      `Plans were not monitored for ${heartbeat.describeGap(watchGap)} ` +
        `(${new Date(watchGap.from).toISOString()} → ${new Date(watchGap.to).toISOString()}).`
    );
    auditLog("monitor_gap", { from: watchGap.from, to: watchGap.to, ms: watchGap.ms });
  }

  paperEngine.start();
  heartbeat.startHeartbeat();
  // Catch up on trades that closed while the app was shut (or whose review
  // failed). Fire-and-forget so startup is never blocked on an API call.
  void reviewPendingPositions();
  /* And on plans that finished WITHOUT trading. This is the common case — a
     plan that expired unfired — and until v18 it produced no record at all,
     which is backwards: it is the most informative outcome the calibration
     record has. Runs after the gap above is audited, so a plan whose life
     overlapped it is described as unwatched rather than as a miss. */
  void reviewPendingPlans();

  // Basis monitor: passively measures Revolut X's spread vs. Binance so the
  // analysis-feed/execution-venue gap is a tracked number before Phase 4.
  const { startBasisMonitor } = require("./data/basis-monitor");
  startBasisMonitor();

  // Background Job Scheduler: missed alert watchdog, hourly equity snapshots, feed health
  const { backgroundScheduler } = require("./services/scheduler");
  backgroundScheduler.start();

  /* Drains the notification outbox. Started here rather than lazily because the
     interesting messages are the ones owed while the app was CLOSED — the
     catch-up rule in docs/RUNTIME.md. Does nothing until Telegram is
     configured, and the backlog is delivered when it is. */
  const { startNotificationWorker } = require("./notify/worker");
  startNotificationWorker();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  // Tear down the agent's offscreen fetch window if one is alive.
  const { disposeAgentFetch } = require("./browser/agent-fetch");
  disposeAgentFetch();
  try {
    const { backgroundScheduler } = require("./services/scheduler");
    backgroundScheduler.stop();
  } catch {}
});

app.on("window-all-closed", () => {
  // Phase 0: quit on close. Later phases (unattended trading) will change this.
  app.quit();
});
