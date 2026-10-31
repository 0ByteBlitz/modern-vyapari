import { useEffect, useState } from "react";
import { api, isError } from "@/lib/api";

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
}

const TONE_COLOR: Record<Feed["tone"], string> = {
  up: "var(--up)",
  caution: "var(--caution)",
  down: "var(--down)",
  idle: "var(--muted-foreground)",
};

export function ContextBar({ title, subtitle }: { title: string; subtitle?: string }) {
  /* The venue's name comes from the active adapter, not a literal. This bar
     reports *execution* health, so labelling it "RevX" when the venue is
     something else would be a status line about a system that isn't running. */
  const [venueName, setVenueName] = useState("Venue");
  const [feeds, setFeeds] = useState<Feed[]>([
    { name: "Binance", tone: "idle", value: "…" },
    { name: "Venue", tone: "idle", value: "…" },
  ]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await api.getVenueInfo();
      if (!cancelled && !isError(info)) setVenueName(info.active.displayName);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      // Both feeds are measured by an actual round trip, not assumed. This
      // bar previously hardcoded Binance as healthy, which made it worse than
      // useless: it read green while the market page couldn't load at all.
      const t0 = Date.now();
      const [binance, venueHealth] = await Promise.all([
        api.getAnalysisCandles("BTC-USD", 60, 1),
        api.getTickers(),
      ]);
      if (cancelled) return;
      const ms = Date.now() - t0;

      setFeeds([
        isError(binance)
          ? { name: "Binance", tone: "down", value: "error" }
          : { name: "Binance", tone: ms > 3000 ? "caution" : "up", value: `${(ms / 1000).toFixed(1)}s` },
        isError(venueHealth)
          ? { name: venueName, tone: "down", value: "error" }
          : { name: venueName, tone: ms > 3000 ? "caution" : "up", value: `${(ms / 1000).toFixed(1)}s` },
      ]);
    };

    void poll();
    const id = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    /* `venueName` is a real dependency: without it this effect would close over
       the initial placeholder and the health row would read "Venue" forever,
       even after the adapter's name arrived. */
  }, [venueName]);

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
          title={`${f.name} — ${f.tone === "down" ? "not responding" : `last round trip ${f.value}`}`}
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
