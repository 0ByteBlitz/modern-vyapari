import { useEffect } from "react";
import { api } from "./api";

/**
 * Run `load` now, whenever main says data changed, and on a slow poll.
 *
 * The poll alone left surfaces a full interval behind the engine: Home kept
 * "2 armed plans" for 41 s after one expired, and a position closed by its stop
 * still showed open on the session overview. `data:updated` is the engine's own
 * "something moved" signal, so every surface that shows engine state listens to
 * it. A closed bar can resolve many plans at once and each sends one, so a burst
 * is coalesced into a single reload. The poll stays for what no event reports —
 * prices, the clock.
 */
export function useLiveReload(load: () => unknown, pollMs: number, coalesceMs = 150): void {
  useEffect(() => {
    void load();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const off = api.onDataUpdated(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void load();
      }, coalesceMs);
    });
    const id = setInterval(() => void load(), pollMs);
    return () => {
      off();
      clearInterval(id);
      if (pending) clearTimeout(pending);
    };
  }, [load, pollMs, coalesceMs]);
}
