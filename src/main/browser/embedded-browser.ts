import { BrowserWindow, Rectangle, WebContentsView, session } from "electron";
import { emitTo } from "../events/outbound";

/**
 * Embedded browser (Phase 1 surface 3): a native `WebContentsView` stacked on
 * top of the main window's own content, positioned to match a placeholder
 * element in the renderer (see browser-page.tsx). Display-only research
 * surface — this process never scrapes, reads, or automates it (TradingView
 * ToS §3, docs/PLAN.md §9); the only bridge from here to the AI is the user
 * manually pasting a snapshot into chat.
 *
 * Privacy posture ("privacy-focused, lightweight browser" — not a full
 * ad-blocker, just sensible defaults with zero new dependencies):
 * - Isolated persistent session partition, entirely separate from the app's
 *   own default session — nothing else in the app touches this cookie jar,
 *   and it never sees this app's own IPC-facing state.
 * - No preload script; contextIsolation + sandbox on, nodeIntegration off —
 *   whatever site loads here gets zero access to this app's IPC bridge.
 * - All permission requests denied (camera/mic/geolocation/notifications/...).
 * - A small, hand-picked ad/tracker domain blocklist cut at the network layer.
 * - Spellcheck disabled — Chromium's spellcheck service phones home by default.
 */

const SESSION_PARTITION = "persist:research-browser";
/** Home page. Now that Research has real charting of its own, this tab is a
 *  general-purpose browser rather than a TradingView frame — so it opens on a
 *  search engine instead of assuming what you want to look at. */
const DEFAULT_URL = "https://duckduckgo.com/";

const TRACKER_HOST_SUBSTRINGS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "adservice.google.com",
  "facebook.com/tr",
  "connect.facebook.net",
  "hotjar.com",
  "hotjar.io",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "fullstory.com",
  "criteo.com",
  "criteo.net",
  "outbrain.com",
  "taboola.com",
  "scorecardresearch.com",
  "quantserve.com",
  "quantcount.com",
  "adnxs.com",
  "adsrvr.org",
  "rubiconproject.com",
  "pubmatic.com",
  "bat.bing.com",
  "clarity.ms",
  "matomo.cloud",
];

export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

let view: WebContentsView | null = null;
let ownerWindow: BrowserWindow | null = null;
let sessionConfigured = false;

function configureSession(): Electron.Session {
  const ses = session.fromPartition(SESSION_PARTITION);
  if (sessionConfigured) return ses;
  sessionConfigured = true;

  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  ses.webRequest.onBeforeRequest((details, callback) => {
    const blocked = TRACKER_HOST_SUBSTRINGS.some((host) => details.url.includes(host));
    callback({ cancel: blocked });
  });

  return ses;
}

function broadcastState(win: BrowserWindow): void {
  if (!view || win.isDestroyed()) return;
  emitTo(win.webContents, "browser:state", getState());
}

function ensureView(win: BrowserWindow): WebContentsView {
  if (view && ownerWindow === win) return view;

  const ses = configureSession();

  view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // No preload — this view only ever shows external sites, which must
      // never get access to this app's IPC bridge.
    },
  });

  win.contentView.addChildView(view);
  ownerWindow = win;
  view.setVisible(false); // hidden until the renderer's Browser page mounts

  view.webContents.setWindowOpenHandler(({ url }) => {
    // No tab strip — links that would open a new window just navigate here.
    view?.webContents.loadURL(url);
    return { action: "deny" };
  });

  view.webContents.on("did-navigate", () => broadcastState(win));
  view.webContents.on("did-navigate-in-page", () => broadcastState(win));
  view.webContents.on("page-title-updated", () => broadcastState(win));
  view.webContents.on("did-start-loading", () => broadcastState(win));
  view.webContents.on("did-stop-loading", () => broadcastState(win));

  win.on("closed", () => {
    view = null;
    ownerWindow = null;
  });

  void view.webContents.loadURL(DEFAULT_URL);

  return view;
}

/** Creates (once) and shows the embedded browser. Safe to call repeatedly. */
export function showBrowser(win: BrowserWindow): void {
  const v = ensureView(win);
  v.setVisible(true);
  broadcastState(win);
}

export function hideBrowser(): void {
  view?.setVisible(false);
}

export function setBrowserBounds(bounds: Rectangle): void {
  view?.setBounds(bounds);
}

export function navigate(url: string): void {
  if (!view) return;
  const trimmed = url.trim();
  if (!trimmed) return;
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  view.webContents.loadURL(normalized).catch(() => {
    // Bad URL / offline — did-stop-loading still fires, surfacing as
    // "not loading" with the previous URL intact rather than throwing.
  });
}

export function goHome(): void {
  navigate(DEFAULT_URL);
}

export function goBack(): void {
  view?.webContents.navigationHistory.goBack();
}

export function goForward(): void {
  view?.webContents.navigationHistory.goForward();
}

export function reload(): void {
  view?.webContents.reload();
}

/** Used by main.ts's global web-contents-created guard to exclude this view
 *  from the app-wide "block all navigation" lockdown — this view IS a
 *  browser and needs normal link-following. Only the app's own window
 *  (loading our local renderer) should ever have navigation blocked. */
export function isResearchBrowserWebContents(contents: Electron.WebContents): boolean {
  return contents.session === session.fromPartition(SESSION_PARTITION);
}

export function getState(): BrowserState | null {
  if (!view) return null;
  const wc = view.webContents;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  };
}

const READ_TEXT_MAX_CHARS = 8000;
const SCREENSHOT_MAX_WIDTH = 1280;

/**
 * Agent-facing read of whatever page is currently open (owner decision:
 * overrides the original "TradingView is display-only, never automate it"
 * rule — see CLAUDE.md security posture notes for the accepted-risk record).
 * Returns visible page text, truncated to keep tool results a reasonable
 * size. This is untrusted web content by nature — callers should treat it
 * as data, not instructions.
 */
export async function readPageText(): Promise<{ url: string; title: string; text: string; truncated: boolean } | null> {
  if (!view || view.webContents.isDestroyed()) return null;
  const wc = view.webContents;
  const raw: string = await wc.executeJavaScript("document.body ? document.body.innerText : ''");
  const truncated = raw.length > READ_TEXT_MAX_CHARS;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    text: truncated ? raw.slice(0, READ_TEXT_MAX_CHARS) : raw,
    truncated,
  };
}

/** Agent-facing screenshot of whatever page is currently visible — same
 *  owner-accepted override as readPageText above. Downscaled to keep the
 *  image payload reasonable for the vision API. */
export async function capturePageScreenshot(): Promise<{ url: string; title: string; base64: string; mediaType: "image/png" } | null> {
  if (!view || view.webContents.isDestroyed()) return null;
  const wc = view.webContents;
  const image = await wc.capturePage();
  const { width } = image.getSize();
  const resized = width > SCREENSHOT_MAX_WIDTH ? image.resize({ width: SCREENSHOT_MAX_WIDTH }) : image;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    base64: resized.toPNG().toString("base64"),
    mediaType: "image/png",
  };
}
