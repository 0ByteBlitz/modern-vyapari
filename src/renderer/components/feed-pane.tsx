import { useEffect, useState } from "react";
import { LineChart } from "lucide-react";
import { api, isError } from "@/lib/api";
import { CandleCoveragePane } from "@/components/candle-coverage-pane";

/**
 * Settings › Analysis feed — the one place the feed is described.
 *
 * It used to be described twice (an Integrations card and a "Data & feeds"
 * page), and the card's "connected" badge was a literal: it read green whether
 * or not the feed answered. The badge is now a real round trip to the feed,
 * measured when the pane opens.
 */
export function FeedPane() {
  const [health, setHealth] = useState<{ ok: boolean; ms: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      /* The ticker snapshot always goes to the feed. A candle read is served
         from the local cache when it is fresh, so it answered "responding" in
         0.0s whether or not the feed was reachable. */
      const t0 = Date.now();
      const res = await api.getTickerSnapshot();
      if (!cancelled) setHealth({ ok: !isError(res) && res.length > 0, ms: Date.now() - t0 });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="integ-pane">
      <section className="panel">
        <div className="panel-header">
          <LineChart size={13} style={{ color: "var(--accent)" }} />
          <span className="label-micro">Analysis feed</span>
        </div>
        <div className="integ-body">
          <div className="integ-row">
            <div>
              <div className="integ-name">Binance</div>
              <div className="integ-sub">
                Charts, indicators, simulated fills and every level a plan resolves. Needs no key.
              </div>
            </div>
            <span className={`badge badge-${!health ? "draft" : health.ok ? "supervised" : "down"}`}>
              {!health ? "checking…" : health.ok ? `responding · ${(health.ms / 1000).toFixed(1)}s` : "not responding"}
            </span>
          </div>
          {/* The rule that keeps the two apart, in one line. */}
          <p className="integ-note">
            Prices are never mixed: analysis comes from here, execution from the exchange. Analysis is
            USD-quoted only, with no currency conversion.
          </p>
        </div>
      </section>

      <CandleCoveragePane />
    </div>
  );
}
