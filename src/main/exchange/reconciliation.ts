/**
 * Startup reconciliation — **NOT IMPLEMENTED.**
 *
 * The plan's hard rule (§1, §7) is: *the exchange is the source of truth —
 * reconcile local state against it on startup.* The first draft of this file
 * claimed to do that while only counting rows in `paper_positions`, and then
 * returned `reconciled: true`. It never contacted the venue. A green
 * reconciliation report that never looked at the exchange is a lie in the one
 * direction that costs money: you would trust local state precisely when it had
 * silently diverged.
 *
 * So the report now describes what it actually checked, and `reconciled` is only
 * ever true when a real venue comparison happened — which today it never does.
 *
 * What a real implementation has to compare (all of it, not some):
 *   • open orders on the venue vs. `orders` rows not in a terminal state
 *   • fills since the last known trade vs. `trades`
 *   • venue balances vs. what the app believes it holds
 *   • every live position having its TP/SL orders still resting on the venue
 * and it must report DRIFT rather than silently adopting either side — an
 * automatic "fix" that picks wrong rewrites real financial history.
 */
import { getDb } from "../db/database";
import { createLogger } from "../logger";

const log = createLogger("reconciliation");

export interface ReconciliationReport {
  timestamp: number;
  /** Local open paper positions. Bookkeeping only — says nothing about the venue. */
  dbOpenPositions: number;
  /**
   * True only when local state was actually compared against the exchange.
   * Always `false` today, because no comparison happens.
   */
  reconciled: boolean;
  /** Why reconciliation did not happen, or what drifted if it did. */
  driftNote?: string;
}

/**
 * Local boot check. Counts what the app believes it holds; does **not** contact
 * the venue, and says so in the report rather than implying otherwise.
 */
export function reconcileStartupState(): ReconciliationReport {
  const db = getDb();

  const openPositions = db
    .prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE status = 'open'`)
    .get() as { n: number };

  log.info(
    `Boot check: ${openPositions.n} open paper position(s) in the local database. ` +
      `No venue comparison performed — live reconciliation is not implemented.`
  );

  return {
    timestamp: Date.now(),
    dbOpenPositions: openPositions.n,
    reconciled: false,
    driftNote:
      "Local-only boot check. No Revolut X comparison was made, so local state is unverified " +
      "against the venue. Required before live trading (docs/PLAN.md §12 Phase 4).",
  };
}
