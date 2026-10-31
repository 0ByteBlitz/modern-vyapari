/**
 * What the Research chart is currently showing.
 *
 * The agent's `read_research_chart` and `screenshot_research` tools claim to
 * read "what the user is looking at". Without this they didn't: the numeric
 * tool defaulted to 4H regardless of the selected timeframe, and the
 * screenshot captured the whole window including the chat transcript.
 *
 * The renderer reports its view here whenever it changes; the tools read it.
 * When Research has never been opened this stays null and the tools say so
 * rather than guessing.
 */
export interface ResearchView {
  symbol: string;
  intervalMin: number;
  /** Chart bounds in CSS pixels, for a cropped screenshot. */
  bounds: { x: number; y: number; width: number; height: number } | null;
  updatedAt: number;
}

let current: ResearchView | null = null;

export function setResearchView(v: Omit<ResearchView, "updatedAt">): void {
  current = { ...v, updatedAt: Date.now() };
}

export function getResearchView(): ResearchView | null {
  return current;
}

export function clearResearchView(): void {
  current = null;
}
