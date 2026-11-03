/**
 * Which Binance host the analysis feed talks to, and what happens when one of
 * them stops answering.
 *
 * Before this, every call site named `api.binance.com` or
 * `stream.binance.com:9443` itself, so one unreachable host meant no history,
 * no market list and no live stream — while Binance's other official hosts
 * were up. Now each call site asks this module, which tries the hosts in order
 * and remembers the one that answered.
 *
 * Host lists checked against Binance's spot API docs on 2026-11-03 ("General
 * API Information", "WebSocket Streams", "Market Data Only"). The
 * `binance.vision` hosts serve public market data only, which is all the
 * analysis feed ever reads. Futures (`fapi.binance.com`) is a different
 * service with no documented alternative host, so it is not here.
 *
 * Vendor-contained on purpose: this is the shape the feed port's adapter takes
 * over (ROADMAP S2-9).
 */
import { auditLog, isDbReady } from "../db/database";
import { isNetworkDisabled } from "../net-guard";
import { createLogger } from "../logger";

const log = createLogger("binance-hosts");

/** In order of preference. `api1`–`api4` are faster but documented as less
 *  stable, so they come after the two primaries. */
const REST_HOSTS = [
  "https://api.binance.com",
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://data-api.binance.vision",
] as const;

const STREAM_HOSTS = [
  "wss://stream.binance.com:9443",
  "wss://stream.binance.com:443",
  "wss://data-stream.binance.vision:443",
] as const;

/** Per attempt. Long enough for the full 24h ticker (hundreds of KB), short
 *  enough that a host that just hangs costs seconds, not the OS's minutes. */
const REST_TIMEOUT_MS = 15_000;

let restIndex = 0;
let streamIndex = 0;

const label = (url: string) => url.replace(/^[a-z]+:\/\//, "");

function recordSwitch(kind: "rest" | "stream", from: string, to: string, reason: string): void {
  log.warn(`Binance ${kind} host ${label(from)} failed (${reason}); switching to ${label(to)}`);
  try {
    if (isDbReady()) auditLog("feed_host_switch", { kind, from: label(from), to: label(to), reason });
  } catch (err) {
    log.error("Could not audit host switch", err);
  }
}

/** A failure that says the host is unwell, not the request. 429 and 418 are
 *  rate limits, which Binance counts per IP across every host: moving to the
 *  next host is exactly the "not backing off" that earns an IP ban, so they
 *  go back to the caller unrotated. */
const isHostFailure = (status: number) => status >= 500;

/**
 * GET a public Binance REST path (e.g. `/api/v3/ping`), trying each host from
 * the last one that worked. Returns the first response that isn't a host
 * failure — a 4xx means the request itself was wrong and is returned as is.
 * When every host fails, returns the last 5xx, or throws the last network error.
 */
export async function binanceFetch(path: string): Promise<Response> {
  if (isNetworkDisabled()) throw new Error("Network is disabled");

  const start = restIndex;
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let i = 0; i < REST_HOSTS.length; i++) {
    const idx = (start + i) % REST_HOSTS.length;
    const host = REST_HOSTS[idx]!;
    let reason: string;
    try {
      const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
      if (!isHostFailure(res.status)) {
        if (idx !== restIndex) {
          recordSwitch("rest", REST_HOSTS[restIndex]!, host, lastError ? errorText(lastError) : `HTTP ${lastResponse?.status}`);
          restIndex = idx;
        }
        return res;
      }
      lastResponse = res;
      lastError = null;
      reason = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err;
      lastResponse = null;
      reason = errorText(err);
    }
    log.warn(`Binance REST ${label(host)} ${path.split("?")[0]} failed: ${reason}`);
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "timed out";
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

/** The stream URL to connect to now. */
export function streamUrl(): string {
  return `${STREAM_HOSTS[streamIndex]}/ws`;
}

/** The current stream host failed (never opened, or open and silent): the next
 *  connect goes to the next host, wrapping round. */
export function streamHostFailed(reason: string): void {
  const from = STREAM_HOSTS[streamIndex]!;
  streamIndex = (streamIndex + 1) % STREAM_HOSTS.length;
  recordSwitch("stream", from, STREAM_HOSTS[streamIndex]!, reason);
}

/** Which hosts are in use, for the header badge. */
export function feedHosts(): { stream: string; history: string } {
  return { stream: label(STREAM_HOSTS[streamIndex]!), history: label(REST_HOSTS[restIndex]!) };
}
