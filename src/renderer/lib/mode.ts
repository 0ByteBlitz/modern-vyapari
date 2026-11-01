import { createContext, useContext } from "react";
import type { AppMode } from "@/lib/api";

/**
 * The mode this process runs in, for any component that names it.
 *
 * Provided once by `App` from main's answer (`setup.mode`). Components read it
 * here rather than writing a word of their own: "paper", "simulated" and a
 * constant that read "paper" while main ran live were three answers to one
 * question that may only have one.
 */
export const ModeContext = createContext<AppMode | null>(null);

/** The running mode. Throws outside the provider rather than guessing one. */
export function useAppMode(): AppMode {
  const mode = useContext(ModeContext);
  if (mode === null) throw new Error("useAppMode() used outside ModeContext");
  return mode;
}

/** "Simulated" / "Live", for the start of a label. */
export function modeTitle(mode: AppMode): string {
  return mode === "live" ? "Live" : "Simulated";
}
