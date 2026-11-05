/**
 * The rail's own icon set: single-stroke line drawings on a 24px grid, one per
 * surface, so the navigation reads as one family. Hand-drawn paths rather than
 * a library glyph each, because the set is small and fixed.
 *
 * Colour comes from `currentColor`; the active item paints its icon indigo in
 * index.css (`.rail-item-active .rail-icon`), indigo meaning "selected".
 */
const PATHS = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  dashboard: "M12 14l4-4M3.5 18a9 9 0 1 1 17 0",
  orders: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  plans: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  journal: "M5 3h11l3 3v15H5zM9 9h6M9 13h6M9 17h4",
  research: "M7 4v16M5 8h4v8H5zM17 4v16M15 6h4v6h-4z",
  alerts: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4",
  portfolio: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  markets: "M3 3v18h18M7 15l4-4 3 3 5-6",
  browser: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  approvals: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  settings: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4",
} as const;

export type RailIconName = keyof typeof PATHS;

export function RailIcon({ name }: { name: RailIconName }) {
  return (
    <svg
      className="rail-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
