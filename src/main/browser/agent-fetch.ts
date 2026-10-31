/**
 * Agent web fetch — headless, isolated, read-only.
 *
 * Separate from the embedded research browser on purpose:
 *   • The research browser is YOURS. It has a persistent profile, so if you
 *     log into TradingView those cookies live there. The agent can look at
 *     what's on screen when asked, but must not drive it.
 *   • This is the AGENT's. Non-persistent session partition (no `persist:`
 *     prefix) → an in-memory cookie jar that dies with the process, so a page
 *     the agent fetches can never see your logged-in state.
 *
 * The window is offscreen, never shown, and renders with images disabled. We
 * extract text only: no clicking, no form filling, no downloads, no popups.
 *
 * SECURITY NOTE, and the reason the tool description is worded the way it is:
 * fetched text is UNTRUSTED INPUT reaching a model that also holds tools which
 * write to the database. A page can contain text shaped like instructions.
 * The prompt wraps every result in an explicit untrusted-data envelope; the
 * structural protections are that this path cannot execute anything on the
 * page and that the agent has no order-placing tools at all.
 */
import { BrowserWindow, session } from "electron";
import * as browserbase from "./browserbase";
import { createLogger } from "../logger";

const log = createLogger("agent-fetch");

/** In-memory partition: no `persist:` prefix means nothing survives restart. */
const AGENT_PARTITION = "agent-fetch";

const LOAD_TIMEOUT_MS = 20_000;
/** Cap on returned text. Long enough for an article, short enough not to
 *  blow out the context window on a page of boilerplate. */
const MAX_TEXT_CHARS = 20_000;
/** The offscreen window is reused, then torn down when idle. */
const IDLE_DISPOSE_MS = 60_000;

let fetchWindow: BrowserWindow | null = null;
let disposeTimer: NodeJS.Timeout | null = null;

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
  /** Which engine produced this — local headless window, or a cloud browser. */
  via: "local" | "browserbase";
}

/** Below this, a "successful" load almost certainly returned a shell, a
 *  consent wall, or a block page rather than the article. */
const THIN_RESULT_CHARS = 400;

/** http/https only — blocks file://, about:, chrome://, data:, javascript:. */
function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Refused: only http(s) URLs can be fetched (got ${url.protocol}).`);
  }
  return url;
}

function configureAgentSession(): Electron.Session {
  const ses = session.fromPartition(AGENT_PARTITION);

  // Nothing the agent fetches may request camera, mic, notifications, etc.
  ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));

  // No downloads — a fetch must never write to disk.
  ses.on("will-download", (event) => event.preventDefault());

  return ses;
}

function ensureWindow(): BrowserWindow {
  if (fetchWindow && !fetchWindow.isDestroyed()) return fetchWindow;

  const ses = configureAgentSession();
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: ses,
      // No preload, no node, sandboxed: the fetched page gets zero access to
      // the app's IPC bridge, filesystem, or credentials.
      preload: undefined,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      images: false,
      webgl: false,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });

  // Popups and top-level navigations away from the loaded page are refused;
  // one fetch loads exactly one page.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  fetchWindow = win;
  return win;
}

function scheduleDispose(): void {
  if (disposeTimer) clearTimeout(disposeTimer);
  disposeTimer = setTimeout(() => {
    if (fetchWindow && !fetchWindow.isDestroyed()) fetchWindow.destroy();
    fetchWindow = null;
    disposeTimer = null;
  }, IDLE_DISPOSE_MS);
}

/**
 * Fetch a page, preferring the local headless window and falling back to a
 * cloud browser (Browserbase) when one is configured.
 *
 * Local first because it's free and instant; cloud only when local fails
 * outright or comes back suspiciously thin — a shell, a consent wall, or a
 * block page. On the free plan that keeps session minutes for the fetches
 * that actually need them.
 */
export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  try {
    const local = await fetchPageLocal(rawUrl);
    if (local.text.length >= THIN_RESULT_CHARS || !browserbase.isConfigured()) return local;

    // Thin result and a cloud browser available — try again out there.
    try {
      const remote = await browserbase.fetchPageRemote(rawUrl);
      return remote.text.length > local.text.length ? remote : local;
    } catch (err) {
      log.error("Browserbase retry failed:", err);
      return local;
    }
  } catch (localErr) {
    if (!browserbase.isConfigured()) throw localErr;
    log.info("Local fetch failed, trying Browserbase:", (localErr as Error).message);
    return browserbase.fetchPageRemote(rawUrl);
  }
}

/**
 * Load a URL in the local offscreen window and return its visible text.
 * Throws on unsafe scheme, load failure, or timeout — never returns partial
 * content that could be mistaken for the real page.
 */
async function fetchPageLocal(rawUrl: string): Promise<FetchedPage> {
  const url = assertSafeUrl(rawUrl);
  const win = ensureWindow();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${LOAD_TIMEOUT_MS / 1000}s loading ${url.href}`));
    }, LOAD_TIMEOUT_MS);

    const onDone = () => {
      cleanup();
      resolve();
    };

    const onFail = (_e: unknown, code: number, desc: string, validatedUrl: string, isMainFrame: boolean) => {
      if (!isMainFrame) return; // sub-resource failures are normal, ignore
      cleanup();
      reject(new Error(`Failed to load ${validatedUrl}: ${desc} (${code})`));
    };

    function cleanup() {
      clearTimeout(timer);
      win.webContents.off("did-finish-load", onDone);
      win.webContents.off("did-fail-load", onFail as never);
    }

    win.webContents.once("did-finish-load", onDone);
    win.webContents.once("did-fail-load", onFail as never);
    void win.loadURL(url.href).catch((err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  // Extract text in the page's own isolated world. This is a read: it does
  // not click, submit, or mutate anything.
  const raw = (await win.webContents.executeJavaScript(
    `(() => {
       const strip = ['script','style','noscript','svg','iframe','nav','footer','form'];
       for (const sel of strip) document.querySelectorAll(sel).forEach(n => n.remove());
       const main = document.querySelector('article, main, [role="main"]') || document.body;
       return { title: document.title || '', text: (main && main.innerText) ? main.innerText : '' };
     })()`,
    true
  )) as { title: string; text: string };

  const finalUrl = win.webContents.getURL();
  const collapsed = (raw.text || "").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = collapsed.length > MAX_TEXT_CHARS;

  // Blank the window so the last page isn't sitting in memory until dispose.
  void win.loadURL("about:blank").catch(() => {});
  scheduleDispose();

  return {
    url: url.href,
    finalUrl,
    title: raw.title || "",
    text: truncated ? `${collapsed.slice(0, MAX_TEXT_CHARS)}\n\n[truncated]` : collapsed,
    truncated,
    via: "local",
  };
}

/** Called on app quit. */
export function disposeAgentFetch(): void {
  if (disposeTimer) clearTimeout(disposeTimer);
  disposeTimer = null;
  if (fetchWindow && !fetchWindow.isDestroyed()) fetchWindow.destroy();
  fetchWindow = null;
}
