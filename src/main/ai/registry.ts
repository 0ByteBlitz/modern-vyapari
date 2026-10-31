/**
 * Which AI provider the app talks to.
 *
 * One provider at a time, chosen by configuration rather than hardcoded — the
 * same "swappable, not concurrent" scope as the venue registry. Anthropic is the
 * only adapter today; adding one is a new file in this folder plus a line below.
 */
import type { AiProvider } from "./port";
import { anthropicProvider } from "./anthropic";

const PROVIDERS: Record<string, AiProvider> = {
  [anthropicProvider.info.id]: anthropicProvider,
};

const DEFAULT_PROVIDER = anthropicProvider.info.id;

let override: AiProvider | null = null;

export function listAiProviders(): AiProvider[] {
  return Object.values(PROVIDERS);
}

/** The active provider. Unknown or missing configuration resolves to the
 *  default rather than failing — the same safe-default rule as app modes. */
export function aiProvider(configuredId?: string | null): AiProvider {
  if (override) return override;
  return (configuredId && PROVIDERS[configuredId]) || PROVIDERS[DEFAULT_PROVIDER]!;
}

/** Test seam. Never called in production code. */
export function setAiProviderForTesting(p: AiProvider | null): void {
  override = p;
}
