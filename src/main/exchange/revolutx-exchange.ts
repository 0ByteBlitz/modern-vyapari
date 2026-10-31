/**
 * Revolut X live execution — **NOT IMPLEMENTED, AND DELIBERATELY FAILS LOUDLY.**
 *
 * ── Why this file is shaped like this ───────────────────────────────────
 * The first draft of it was the most dangerous code in the repository. Every
 * method returned fabricated success:
 *
 *   • `getBalances()`  returned a hardcoded `{ USD: 10000, BTC: 0.5, ETH: 2 }`
 *   • `placeOrder()`   returned `status: "filled"` at a hardcoded $65,000 —
 *                      without contacting the venue at all
 *   • `cancelOrder()`  returned `true` unconditionally
 *
 * Nothing imported it, so nothing broke. But the moment any caller wired itself
 * to `placeOrder` believing it worked, the app would have recorded filled orders
 * that never existed, at prices nobody traded, and reconciled its books against
 * them. Silent fabrication in the execution path is the worst failure this
 * codebase can have — worse than a crash, because a crash tells you.
 *
 * So the stub now throws. An unimplemented venue must be indistinguishable from
 * a broken one at the call site, never from a working one.
 *
 * ── The gate before this may be implemented (plan §7, §12 Phase 4) ──────
 *   1. The risk engine exists and is tested                      ✅ (Stage C)
 *   2. Order intents flow through `OrderPipeline` on every path   ⬜
 *   3. Startup reconciliation against the venue actually works    ⬜ (see
 *      `reconciliation.ts` — also a stub, also honest about it now)
 *   4. Every live position carries a venue-side TP/SL order       ⬜
 *   5. A strategy has earned it through the paper gate            ⬜
 *
 * Signing, headers and the endpoint contract already exist and are proven in
 * `src/main/revx/client.ts` + `signing.ts` (read-only calls). A real
 * implementation belongs there, behind the pipeline — not here in a parallel
 * client with its own idea of what an order is.
 */
import { createLogger } from "../logger";
import { AppError } from "../../shared/errors";

const log = createLogger("revolutx-exchange");

export interface LiveOrderResult {
  exchangeOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  status: "filled" | "open" | "rejected";
}

/** Thrown by every method here. Distinct type so a caller cannot mistake
 *  "not built" for "the venue rejected it" or "the network failed". */
export class LiveExecutionNotImplementedError extends AppError {
  constructor(operation: string) {
    super(
      "NOT_IMPLEMENTED",
      `Live execution is not built yet, so ${operation} cannot be performed.`,
      { hint: "This app is paper-only today. See docs/PLAN.md §12 Phase 4 for the gate." }
    );
    this.name = "LiveExecutionNotImplementedError";
  }
}

export class RevolutXExchangeEngine {
  public async getBalances(): Promise<Record<string, number>> {
    /* Read-only balances DO already work — via `revx.getBalances()` in
       `src/main/revx/client.ts`, signed and against the real venue. Callers must
       use that. Returning a plausible-looking object from here would put a
       second, fake source of account truth into the app. */
    log.error("getBalances() called on the unimplemented live exchange engine — use revx/client.ts instead.");
    throw new LiveExecutionNotImplementedError("reading live balances through this engine");
  }

  public async placeOrder(
    _symbol: string,
    _side: "buy" | "sell",
    _type: "market" | "limit",
    _quantity: number,
    _price?: number
  ): Promise<LiveOrderResult> {
    log.error("placeOrder() called on the unimplemented live exchange engine — refusing.");
    throw new LiveExecutionNotImplementedError("placing a live order");
  }

  public async cancelOrder(_exchangeOrderId: string): Promise<boolean> {
    log.error("cancelOrder() called on the unimplemented live exchange engine — refusing.");
    throw new LiveExecutionNotImplementedError("cancelling a live order");
  }
}

export const revolutX = new RevolutXExchangeEngine();
