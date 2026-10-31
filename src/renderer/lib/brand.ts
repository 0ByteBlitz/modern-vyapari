/**
 * Brand constants — one definition, used by every surface that shows identity
 * (titlebar, lock screen, onboarding).
 *
 * The tagline is Nepali: जानेर मात्र, किनबेच — "jaanera matra, kinbech",
 * roughly "trade only knowingly". It's the product thesis in three words: the
 * app exists to make you know before you act, which is why strategies must
 * earn their way through backtests and paper trades before they can touch
 * real money.
 *
 * Devanagari needs a font that actually has the glyphs; `--font-deva` in
 * index.css falls back through the Windows Nepali fonts before generic sans.
 */

export const APP_NAME = "Modern Vyapari";

/** Nepali (Devanagari). Shown as the primary tagline. */
export const TAGLINE_NE = "जानेर मात्र, किनबेच";

/** Romanisation, for places where Devanagari may not render. */
export const TAGLINE_ROMAN = "Jaanera matra, kinbech";

/** English gloss, used as a title/tooltip rather than displayed inline. */
export const TAGLINE_EN = "Trade only knowingly";
