import { useCallback, useEffect, useState } from "react";
import { Check, X, Plug, ShieldCheck, AlertTriangle } from "lucide-react";
import { api, isError, type SetupStatus, type VenueInfo } from "@/lib/api";
import { VenueKeysPanel } from "@/components/credentials-panels";

/**
 * Exchange — what executes, what it can do, and its keys, in one place.
 *
 * Was "Integrations" until 2026-11-01, which put the exchange, the analysis
 * feed and every key on one page: the Revolut X keys sat below the Analysis
 * feed card, away from the Exchange card they belong to, and the Exchange card
 * said "connected" for the simulated venue because the venue's keys happened to
 * be saved. The feed moved to Settings › Analysis feed and each key to the
 * section it powers.
 *
 * Settings used to show **Credentials**: one venue's key status, and nothing
 * about the venue itself. That was true when Revolut X was referred to by name
 * from wherever it was needed; it stopped being true when S2-9 put venues
 * behind a port with a registry and declared capabilities. The owner said so
 * plainly: *"there is no way of wanted integrations feature."*
 *
 * What an integration page owes the reader is **what is connected, what it can
 * actually do, and how to change it** — in that order. The capability rows are
 * the interesting part and they are read from the adapter, never asserted here:
 * `canPlaceOrders` is false until S4-1 exists and `venueSideProtectiveOrders`
 * is false until S4-2 verifies it against the real API. An adapter that cannot
 * rest a stop on the venue must refuse live trading rather than emulate one
 * locally, because a local stop is not a stop if the app is closed. Printing
 * those honestly is the point of the section.
 *
 * **Key management stays where it is.** `VenueKeysPanel` is embedded rather
 * than reimplemented: it is the only code that handles the Ed25519 keypair, and
 * a second path to writing a private key the venue already knows is exactly the
 * kind of duplication this codebase keeps paying for.
 */
function Cap({ label, on, note }: { label: string; on: boolean; note?: string }) {
  return (
    <div className="integ-cap">
      {on ? (
        <Check size={12} style={{ color: "var(--up)" }} />
      ) : (
        <X size={12} style={{ color: "var(--text-ghost)" }} />
      )}
      <span className={on ? "" : "integ-cap-off"}>{label}</span>
      {note && <span className="integ-cap-note ml-auto">{note}</span>}
    </div>
  );
}

export function ExchangePane({
  setup,
  onRefresh,
}: {
  setup: SetupStatus | null;
  onRefresh: () => Promise<void>;
}) {
  const [venue, setVenue] = useState<{ active: VenueInfo; available: VenueInfo[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.getVenueInfo();
    if (isError(res)) {
      setProblem("Couldn't read the venue.");
      return;
    }
    setVenue(res);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* The simulated venue has no keys and no connection; calling it "connected"
     because a real venue's keys were saved described a different system. */
  const simulated = venue?.active.id === "simulated";
  const keysSaved = Boolean(setup?.hasApiKey && setup?.hasKeyPair);

  return (
    <div className="integ-pane">
      <section className="panel">
        <div className="panel-header">
          <Plug size={13} style={{ color: "var(--accent)" }} />
          <span className="label-micro">Exchange</span>
        </div>

        <div className="integ-body">
          {problem && <p className="integ-problem">{problem}</p>}

          {venue && (
            <>
              <div className="integ-row">
                <div>
                  <div className="integ-name">{venue.active.displayName}</div>
                  <div className="integ-sub">
                    {simulated
                      ? "No venue. Fills are simulated against the analysis feed."
                      : "Execution, balances and fills come from here."}
                  </div>
                </div>
                <span className={`badge badge-${simulated ? "paper" : keysSaved ? "supervised" : "draft"}`}>
                  {simulated ? "simulated" : keysSaved ? "keys saved" : "keys not set"}
                </span>
              </div>

              <div className="integ-caps">
                <Cap
                  label="Place orders"
                  on={venue.active.canPlaceOrders}
                  note={venue.active.canPlaceOrders ? undefined : "not built yet"}
                />
                <Cap
                  label="Stop and target held on the exchange"
                  on={venue.active.venueSideProtectiveOrders}
                  note={venue.active.venueSideProtectiveOrders ? undefined : "unverified"}
                />
                <Cap label="One-cancels-the-other on the exchange" on={venue.active.venueSideOco} />
                <Cap
                  label="Daily order limit"
                  on={venue.active.dailyOrderLimit !== null}
                  note={venue.active.dailyOrderLimit ? `${venue.active.dailyOrderLimit}/day` : undefined}
                />
              </div>

              {/* The rule this section exists to make visible. */}
              <p className="integ-note">
                {venue.active.venueSideProtectiveOrders ? (
                  <>
                    <ShieldCheck size={12} style={{ color: "var(--up)" }} /> A stop rests on the
                    exchange, so it survives this app being closed.
                  </>
                ) : (
                  <>
                    <AlertTriangle size={12} style={{ color: "var(--caution)" }} /> Live trading stays
                    off until a stop can rest on the exchange. A stop held only here isn't a stop when
                    the app is shut.
                  </>
                )}
              </p>

              {venue.available.length > 1 && (
                <p className="integ-note">
                  {venue.available.length} exchanges available. Switching is refused while anything is
                  open.
                </p>
              )}
            </>
          )}
        </div>
      </section>

      {/* Keys keep their own panel — one implementation for anything that
          writes a private key the venue already knows. In simulated mode they
          are kept for when live trading exists, and the panel says so. */}
      {setup && (
        <VenueKeysPanel
          setup={setup}
          onRefresh={onRefresh}
          note={simulated ? "used once live trading exists" : "execution venue"}
        />
      )}
    </div>
  );
}
