/**
 * Number formatting — one implementation, used everywhere.
 *
 * Crypto prices span ten orders of magnitude: BTC at 64,448.01 and a
 * small-cap at 0.0000094213 have to render in the same column. The app was
 * using ad-hoc `toPrecision(6)` and `toFixed(2)` per component, which:
 *   • rounded sub-cent prices to "0.00" — actively wrong, not just ugly
 *   • printed "0.0781000" (toPrecision pads to significant digits)
 *   • formatted the same value differently on different surfaces
 *
 * Rules here:
 *   • Prices keep up to 10 decimal places and trailing zeros are trimmed.
 *   • Money that is denominated in USD (PnL, fees, balances) stays at 2dp —
 *     it's a currency amount, not a token price.
 *   • Quantities keep enough precision to be recognisable without becoming
 *     an unreadable float tail.
 */

/** Maximum decimals the venues quote. */
const MAX_PRICE_DECIMALS = 10;

function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * How many decimal places a price of this magnitude should show.
 *
 * Exported so the CHARTS use the same rule as the tables. Chart libraries
 * default to their own precision — lightweight-charts padded to
 * "0.09100000", KLineChart picks its own — so the same price rendered
 * differently depending on which surface you were looking at.
 */
export function priceDecimals(v: string | number | null | undefined): number {
  const n = toNumber(v);
  if (n === null) return 2;
  const abs = Math.abs(n);
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 6;
  if (abs > 0) return Math.min(MAX_PRICE_DECIMALS, Math.floor(-Math.log10(abs)) + 4);
  return 2;
}

/**
 * A token price. Scales decimals to the magnitude so both BTC and a
 * sub-cent alt read correctly, and never rounds a non-zero price to zero.
 *
 *   64448.0100  → "64,448.01"
 *   0.0781      → "0.0781"
 *   0.000009421 → "0.000009421"
 */
export function formatPrice(v: string | number | null | undefined, opts: { grouping?: boolean } = {}): string {
  const n = toNumber(v);
  if (n === null) return "—";

  const abs = Math.abs(n);
  const decimals = priceDecimals(n);

  const s = n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
    useGrouping: opts.grouping ?? true,
  });

  // Ensure at least 2dp for readability on round numbers ("64,448" → "64,448.00")
  if (!s.includes(".") && abs >= 1) return `${s}.00`;
  return s;
}

/** USD amounts: PnL, fees, balances. Always 2dp — this is currency. */
export function formatUsd(v: string | number | null | undefined, opts: { sign?: boolean } = {}): string {
  const n = toNumber(v);
  if (n === null) return "—";
  const body = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? "−" : opts.sign ? "+" : "";
  return `${sign}${body}`;
}

/** Token quantities — up to 8dp, trailing zeros trimmed. */
export function formatQty(v: string | number | null | undefined): string {
  const n = toNumber(v);
  if (n === null) return "—";
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

/** Percentages. */
export function formatPct(v: number | null | undefined, decimals = 2, sign = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = v.toFixed(decimals);
  return `${sign && v > 0 ? "+" : ""}${s}%`;
}

/** Large counts (volume, open interest): 1.2K / 3.4M / 5.6B. */
export function formatCompact(v: string | number | null | undefined): string {
  const n = toNumber(v);
  if (n === null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}
