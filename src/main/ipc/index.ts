/**
 * The IPC surface: a registry, not a switchboard.
 *
 * **Split on 2026-08-05.** This was one 725-line file registering 102 channels
 * and importing 34 subsystems. Almost none of it was logic — about thirty lines
 * — so the complaint that it "did the heavy lifting" was only half right. What
 * it had become was the app's **dependency hub**: the single module that
 * transitively pulled in the venue adapter, the agent, the paper engine, the
 * credential vault and the embedded browser, so touching any part of the IPC
 * surface meant recompiling and re-reasoning about all of them.
 *
 * Now each domain registers its own channels and imports only its own services.
 * This file knows the *order* and nothing else.
 *
 * **The guard came first.** `test/ipc-surface.test.ts` was written and run green
 * against the un-split file, because moving 102 handlers between files is
 * exactly the mechanical edit that goes wrong once and is never noticed — a
 * dropped handler is a channel that rejects at runtime, in whichever surface
 * happens to call it, weeks later. It asserts the set of channels main answers
 * is exactly the set the preload bridge reaches for, in both directions, with
 * no duplicates, and that every handler reports failures under its own name.
 *
 * Rule unchanged and still the point: **no secret material returns through
 * these handlers** — only booleans, the public key, and market/account display
 * data.
 */
import { app } from "electron";
import * as credentials from "../security/credentials";
import { initIntegrationSecrets } from "../security/integration-secrets";
import { registerSetup } from "./setup";
import { registerVenue } from "./venue";
import { registerMarketdata } from "./marketdata";
import { registerSessions } from "./sessions";
import { registerPlans } from "./plans";
import { registerResearch } from "./research";
import { registerPaper } from "./paper";
import { registerInsights } from "./insights";
import { registerReadmodels } from "./readmodels";
import { registerSafety } from "./safety";
import { registerAgent } from "./agent";
import { registerBrowser } from "./browser";
import { registerNotify } from "./notify";
import { registerDiagnostics } from "./diagnostics";
import { registerStrategy } from "./strategy";
import { registerWindow } from "./window";

/** Defined once in the shared contract; re-exported for existing importers. */
export type { SetupStatus } from "../../shared/ipc-types";
export { safe } from "./safe";

export function registerIpcHandlers(): void {
  /* Vaults first: several domains read credential state during registration,
     and a handler answering before the store is open would report "not
     configured" for a key that is present. */
  credentials.initCredentials(app.getPath("userData"));
  initIntegrationSecrets(app.getPath("userData"));

  registerSetup();
  registerVenue();
  registerMarketdata();
  registerSessions();
  registerPlans();
  registerResearch();
  registerPaper();
  registerInsights();
  registerReadmodels();
  registerSafety();
  registerAgent();
  registerBrowser();
  registerNotify();
  registerDiagnostics();
  registerStrategy();
  registerWindow();
}
