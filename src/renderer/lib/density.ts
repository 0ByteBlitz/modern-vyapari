/**
 * UI density — the type and icon scale, chosen by the user.
 *
 * Lives in localStorage rather than the DB: it's a per-machine display
 * preference that no engine reads, and routing it through IPC would mean the
 * first paint happens at the wrong size while the round trip completes.
 *
 * Applied as `data-density` on <html>; `index.css` swaps the `--text-*` and
 * `--icon-*` tokens off that attribute. "default" writes no attribute so the
 * `:root` values apply unchanged.
 */

export type Density = "compact" | "default" | "comfortable";

export const DENSITIES: { id: Density; label: string; description: string }[] = [
  { id: "compact", label: "Compact", description: "Maximum data on screen. The original terminal scale." },
  { id: "default", label: "Default", description: "Readable at a glance without giving up much density." },
  { id: "comfortable", label: "Comfortable", description: "Largest type. Fewer rows visible per screen." },
];

const KEY = "ui_density";

export function getDensity(): Density {
  const saved = localStorage.getItem(KEY);
  return saved === "compact" || saved === "comfortable" || saved === "default" ? saved : "default";
}

export function applyDensity(density: Density): void {
  if (density === "default") delete document.documentElement.dataset.density;
  else document.documentElement.dataset.density = density;
}

export function setDensity(density: Density): void {
  localStorage.setItem(KEY, density);
  applyDensity(density);
}

/** Call once before first paint so the app never renders at the wrong size. */
export function initDensity(): void {
  applyDensity(getDensity());
}
