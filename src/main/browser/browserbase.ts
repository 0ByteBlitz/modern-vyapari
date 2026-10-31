/**
 * Browserbase — cloud browser fallback for agent web research.
 *
 * Why it exists: the local headless fetch (`agent-fetch.ts`) is free and fast,
 * but it renders from this machine's IP and some sites return an empty shell,
 * a consent wall, or a challenge page to it. Browserbase runs a real browser
 * in the cloud, which gets past those cases and renders JS-heavy pages
 * properly. Local stays the default; this is the fallback.
 *
 * Driven over the Chrome DevTools Protocol via a raw WebSocket — Node's global
 * WebSocket is enough, so this adds no dependency (the project prefers zero).
 *
 * DELIBERATE SETTINGS, and why:
 *   solveCaptchas: false   — Browserbase defaults this to TRUE. Automatically
 *                            defeating a CAPTCHA is circumventing a site's
 *                            explicit statement that it doesn't want automated
 *                            access, so it is turned off. If a page challenges
 *                            us, the fetch fails and the agent says so.
 *   advancedStealth: off   — same reasoning: not in the business of evading
 *                            bot detection.
 *   recordSession: false   — pages the agent reads aren't replayed and stored
 *                            on a third party's servers by default.
 *   blockAds: true         — less noise in extracted text, fewer trackers.
 *
 * The API key lives in the main process only (encrypted at rest via
 * safeStorage) and is never sent to the renderer, logged, or put in a prompt.
 */
import * as credentials from "../security/credentials";

const API_BASE = "https://api.browserbase.com/v1";
const SESSION_TIMEOUT_S = 60;
const NAV_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 20_000;

export interface RemotePage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
  via: "browserbase";
}

export function isConfigured(): boolean {
  return credentials.hasBrowserbaseKey();
}

interface CreatedSession {
  id: string;
  connectUrl: string;
}

async function createSession(apiKey: string): Promise<CreatedSession> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BB-API-Key": apiKey },
    body: JSON.stringify({
      timeout: SESSION_TIMEOUT_S,
      browserSettings: {
        blockAds: true,
        solveCaptchas: false, // see file header — not negotiable
        recordSession: false,
        logSession: false,
        viewport: { width: 1280, height: 900 },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Free plan limits (concurrent sessions / monthly minutes) surface here.
    throw new Error(`Browserbase session failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }

  const data = (await res.json()) as { id: string; connectUrl: string };
  if (!data?.connectUrl) throw new Error("Browserbase returned no connectUrl");
  return { id: data.id, connectUrl: data.connectUrl };
}

async function endSession(apiKey: string, sessionId: string): Promise<void> {
  // Sessions bill by the minute — release rather than waiting for the timeout.
  try {
    await fetch(`${API_BASE}/sessions/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BB-API-Key": apiKey },
      body: JSON.stringify({ status: "REQUEST_RELEASE" }),
    });
  } catch {
    /* the session's own timeout will reap it */
  }
}

/** Minimal CDP client: send a command, await its matching id. */
class CdpConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private events = new Map<string, ((params: any) => void)[]>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message ?? "CDP error"));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const cb of this.events.get(msg.method) ?? []) cb(msg.params);
      }
    };
  }

  static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("Timed out connecting to the cloud browser")), 15_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to the cloud browser"));
      };
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, NAV_TIMEOUT_MS);
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method: string, cb: (params: any) => void): void {
    const list = this.events.get(method) ?? [];
    list.push(cb);
    this.events.set(method, list);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** http/https only — same rule as the local fetcher. */
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

/**
 * Load a page in a cloud browser and return its visible text.
 * Read-only: navigate and extract. No clicking, typing, or form submission.
 */
export async function fetchPageRemote(rawUrl: string): Promise<RemotePage> {
  const url = assertSafeUrl(rawUrl);
  const apiKey = credentials.getBrowserbaseKey();
  if (!apiKey) throw new Error("Browserbase is not configured — add the API key in Settings › Credentials.");

  const session = await createSession(apiKey);
  let cdp: CdpConnection | null = null;

  try {
    cdp = await CdpConnection.connect(session.connectUrl);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    await cdp.send("Page.enable", {}, sessionId);

    const loaded = new Promise<void>((resolve) => {
      cdp!.on("Page.loadEventFired", () => resolve());
      // Some pages never fire load (long-polling, media). Settle anyway and
      // take whatever rendered — better a partial read than a hang.
      setTimeout(resolve, NAV_TIMEOUT_MS - 5_000);
    });

    await cdp.send("Page.navigate", { url: url.href }, sessionId);
    await loaded;
    // Small settle for client-rendered pages to paint after load.
    await new Promise((r) => setTimeout(r, 1_200));

    const { result } = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const strip = ['script','style','noscript','svg','iframe','nav','footer','form'];
          for (const sel of strip) document.querySelectorAll(sel).forEach(n => n.remove());
          const main = document.querySelector('article, main, [role="main"]') || document.body;
          return JSON.stringify({
            title: document.title || '',
            url: location.href,
            text: (main && main.innerText) ? main.innerText : ''
          });
        })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId
    );

    const parsed = JSON.parse(String(result?.value ?? "{}")) as { title?: string; url?: string; text?: string };
    const collapsed = (parsed.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
    const truncated = collapsed.length > MAX_TEXT_CHARS;

    return {
      url: url.href,
      finalUrl: parsed.url ?? url.href,
      title: parsed.title ?? "",
      text: truncated ? `${collapsed.slice(0, MAX_TEXT_CHARS)}\n\n[truncated]` : collapsed,
      truncated,
      via: "browserbase",
    };
  } finally {
    cdp?.close();
    await endSession(apiKey, session.id);
  }
}
