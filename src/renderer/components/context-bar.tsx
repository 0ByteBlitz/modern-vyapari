import { useEffect, useState } from "react";
import { api, isError, type FeedHealth, type FeedStreamState, type Result } from "@/lib/api";

/**
 * Context bar (34px) — what surface you're on, and whether the data behind it
 * can be trusted.
 *
 * Feed health lives here rather than in settings because a stale feed silently
 * invalidates everything above it: a chart, an indicator, a strategy trigger.
 * If Binance goes quiet the user should notice without going looking.
 */
interface Feed {
  name: string;
  tone: "up" | "caution" | "down" | "idle";
  value: string;
  /** The tooltip: what the chip measured. */
  detail?: string;
}

const TONE_COLOR: Record<Feed["tone"], string> = {
  up: "var(--up)",
  caution: "var(--caution)",
  down: "var(--down)",
  idle: "var(--muted-foreground)",
};

/** The stream read is local (no network), so it can be frequent enough that a
 *  silence shows within seconds of the watchdog's threshold. */
const STREAM_POLL_MS = 5_000;
/** Network round trips stay slow. */
const REST_POLL_MS = 30_000;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const ago = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`);

const INTERVAL_LABEL: Record<number, string> = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "1d" };

/** The Binance chip from the socket's state, then from the engine's own
 *  streams — the market list's traffic keeps the socket busy while a plan's
 *  stream can have stopped, so while anything is watched the worst watched
 *  stream decides. A failing REST check can make it worse, never better. */
function binanceFeed(res: Result<FeedHealth>, rest: { ok: boolean; ms: number } | null): Feed {
  const name = "Binance";
  const restNote = rest ? (rest.ok ? `history round trip ${seconds(rest.ms)}` : "history requests failing") : "";
  if (isError(res)) return { name, tone: "down", value: "error", detail: "stream state unreadable" };
  /* Named always, since after a failure either may be a fallback host. */
  const hostNote = `stream ${res.hosts.stream}, history ${res.hosts.history}`;
  const withRest = (d: string) => [d, restNote, hostNote].filter(Boolean).join(" · ");
  const s: FeedStreamState = res.socket;
  const w = res.watched.worst;
  switch (s.state) {
    case "live": {
      const watchedNote = w ? `watching ${res.watched.count} stream${res.watched.count === 1 ? "" : "s"}` : "nothing watched";
      if (w && w.state === "silent") {
        return { name, tone: "down", value: `${w.pair} silent ${ago(w.msSinceTick)}`, detail: withRest(`${w.pair} ${INTERVAL_LABEL[w.intervalMin] ?? `${w.intervalMin}m`} has sent nothing for ${ago(w.msSinceTick)}; its plans are waiting · ${watchedNote}`) };
      }
      if (w && w.state === "catching_up") {
        return { name, tone: "caution", value: `${w.pair} catching up`, detail: withRest(`loading bars ${w.pair} missed; its plans resume when they are in · ${watchedNote}`) };
      }
      const last = w ? `slowest watched stream ${ago(w.msSinceTick)} ago` : `last update ${ago(s.msSinceLastMessage)} ago`;
      return rest && !rest.ok
        ? { name, tone: "caution", value: "history down", detail: withRest(`stream live, ${last} · ${watchedNote}`) }
        : { name, tone: "up", value: "live", detail: withRest(`stream live, ${last} · ${watchedNote}`) };
    }
    case "silent":
      return { name, tone: "down", value: `silent ${ago(s.msSinceLastMessage)}`, detail: withRest("stream open but sending nothing; reconnecting") };
    case "connecting":
      return { name, tone: "caution", value: "connecting", detail: withRest("stream connecting") };
    case "down":
      return { name, tone: "down", value: "down", detail: withRest("stream disconnected; retrying") };
    case "idle":
      return rest && !rest.ok
        ? { name, tone: "down", value: "down", detail: withRest("nothing streaming") }
        : { name, tone: "idle", value: "idle", detail: withRest("nothing streaming") };
  }
}

export function ContextBar({ title, subtitle }: { title: string; subtitle?: string }) {
  /* The venue's name comes from the active adapter, not a literal. This bar
     reports *execution* health, so labelling it "RevX" when the venue is
     something else would be a status line about a system that isn't running. */
  const [venueName, setVenueName] = useState("Venue");
  /* The simulated venue has no connection, so it has no latency to show. */
  const [simulatedVenue, setSimulatedVenue] = useState(false);
  const [binanceChip, setBinanceChip] = useState<Feed>({ name: "Binance", tone: "idle", value: "…" });
  const [venueChip, setVenueChip] = useState<Feed>({ name: "Venue", tone: "idle", value: "…" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await api.getVenueInfo();
      if (!cancelled && !isError(info)) {
        setVenueName(info.active.displayName);
        setSimulatedVenue(info.active.id === "simulated");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* The Binance chip reads the live stream, because that is what plans, alerts
     and paper stops run on (2026-11-03). A REST round trip — what it showed
     before — answers fine while the socket is silent, so the badge read green
     while nothing was being watched. REST is still checked, slower, because
     history and backfill depend on it; it can only make a live chip worse. */
  useEffect(() => {
    let cancelled = false;
    let rest: { ok: boolean; ms: number } | null = null;

    const pingRest = async () => {
      const t0 = Date.now();
      const r = await api.pingFeed();
      rest = { ok: !isError(r), ms: Date.now() - t0 };
    };

    const read = async () => {
      const res = await api.getFeedStream();
      if (cancelled) return;
      setBinanceChip(binanceFeed(res, rest));
    };

    void pingRest().then(read);
    const streamId = setInterval(() => void read(), STREAM_POLL_MS);
    const restId = setInterval(() => void pingRest(), REST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(streamId);
      clearInterval(restId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (simulatedVenue) {
        setVenueChip({ name: "Venue", tone: "idle", value: "simulated" });
        return;
      }
      // Measured by an actual round trip, not assumed.
      const t0 = Date.now();
      const health = await api.getTickers();
      const ms = Date.now() - t0;
      if (cancelled) return;
      setVenueChip(
        isError(health)
          ? { name: venueName, tone: "down", value: "error", detail: "not responding" }
          : { name: venueName, tone: ms > 3000 ? "caution" : "up", value: seconds(ms), detail: `last round trip ${seconds(ms)}` }
      );
    };

    void poll();
    const id = setInterval(() => void poll(), REST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    /* `venueName` is a real dependency: without it this effect would close over
       the initial placeholder and the health row would read "Venue" forever,
       even after the adapter's name arrived. */
  }, [venueName, simulatedVenue]);

  const feeds = [binanceChip, venueChip];

  return (
    <div className="context-bar">
      <span className="context-title">{title}</span>
      {subtitle && <span className="context-sub">{subtitle}</span>}
      <div className="flex-1" />
      {feeds.map((f) => (
        /* A degraded feed colours its *text*, not just its dot. The first UI
           test run could not find this row at all (§1.1–1.3): at --text-xs in
           --muted-foreground, right-aligned in a 34px band, it was the quietest
           thing on screen — which defeats the stated purpose of the component,
           that a feed going quiet is noticed without going looking. A 6px dot
           changing colour is not enough on its own. */
        <div
          key={f.name}
          className={`feed-pill ${f.tone === "down" || f.tone === "caution" ? "feed-pill-bad" : ""}`}
          style={f.tone === "down" || f.tone === "caution" ? { color: TONE_COLOR[f.tone] } : undefined}
          title={f.detail ? `${f.name} — ${f.detail}` : f.name}
        >
          <span
            className={`feed-dot ${f.tone === "up" ? "feed-dot-live" : ""}`}
            style={{ background: TONE_COLOR[f.tone] }}
          />
          {f.name} {f.value}
        </div>
      ))}
    </div>
  );
}
