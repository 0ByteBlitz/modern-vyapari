# Design notes

Detailed notes on how specific subsystems work and why. Moved out of `CLAUDE.md`
so agent sessions load only the rules; read the relevant section here before
changing the subsystem it describes.

"Owner" throughout these docs means *the person using the app* — the human who
authors and signs plans. The project began as a single-user tool, and the
decision record is written from that seat.

## Security posture (living notes)

- Credential storage: Ed25519 private key is now encrypted at rest via `safeStorage` (`src/main/security/credentials.ts` — moved out of `revx/` on 2026-07-31, since it holds the Anthropic and Browserbase keys too) — same standard as the API keys, DPAPI-backed on Windows. Legacy plaintext `private.pem` (POSIX chmod 0600, which is largely cosmetic on Windows/NTFS) is transparently migrated to encrypted `private.key.enc` on startup and removed.
- `main.ts` hardening: global `web-contents-created` guard (deny window-open, block navigation) beyond just the main window; `session.defaultSession.setPermissionRequestHandler` denies all permission requests (camera/mic/geolocation/etc. — unneeded); explicit `allowRunningInsecureContent: false` / `experimentalFeatures: false` on webPreferences for auditability. CSP already locked to `default-src 'self'` with no `unsafe-eval` (`src/renderer/index.html`). `contextIsolation`/`sandbox`/`nodeIntegration:false` already in place.
- Packaging: `electron-builder` added (new devDependency — run `npm install` to pick it up) with `npm run package:win` (NSIS installer, unsigned — `forceCodeSigning: false`, no cert configured). `electronFuses` in `package.json`'s `build` key disables `runAsNode` (closes the `ELECTRON_RUN_AS_NODE` living-off-the-land credential-theft vector used against real Electron apps), enables `onlyLoadAppFromAsar` + `embeddedAsarIntegrityValidation` + `cookieEncryption`. **Fuse keys must match electron-builder's `FuseOptionsV1` schema exactly** — `enableCookieEncryption`, `enableNodeOptionsEnvironmentVariable`, `enableNodeCliInspectArguments`, `enableEmbeddedAsarIntegrityValidation`, not the shorter `@electron/fuses` names. The schema sets `additionalProperties: false`, so one wrong key fails the whole build with a misleading "configuration.electronFuses should be one of these: null" (fixed 2026-07-28; the original keys were wrong and packaging had never been run). Owner should run `npm run package:win` and confirm the installer launches correctly (icon path, asar contents) before relying on it.
- **Browserbase fallback (owner decision, 2026-07-28):** `src/main/browser/browserbase.ts` — cloud browser used only when the local fetch fails or returns under 400 chars (shell/consent wall/block page), so free-plan minutes go to the fetches that need them. Driven over CDP with a raw WebSocket, so **no new dependency**. Key stored encrypted via `safeStorage` (`credentials.saveBrowserbaseKey`, file `credentials/browserbase.bin`), main-process only — `setup:status` returns a `hasBrowserbaseKey` boolean and the key itself never crosses IPC, never enters the audit log, never enters a prompt. **Every session sets `solveCaptchas: false`** (Browserbase defaults it to *true*) and leaves stealth mode off: defeating a CAPTCHA means overriding a site's explicit refusal of automated access, so a challenged fetch fails loudly instead. `recordSession`/`logSession` off so pages the agent reads aren't stored on a third party; `blockAds: true`. Sessions are explicitly released after each fetch rather than left to time out.
- **Agent web access (owner decision, 2026-07-28):** `src/main/browser/agent-fetch.ts` gives the agent a `fetch_url` tool — headless page load, text extraction only. Deliberately isolated from the user's browsing: **non-persistent** session partition (`"agent-fetch"`, no `persist:` prefix → in-memory cookie jar, dies with the process), so fetched pages can never see logged-in state from the research browser's persistent profile. http(s) only (file/about/data/javascript schemes refused), 20s timeout, 20k-char cap, images off, downloads blocked, popups denied, no preload/node/webSecurity-off. The window is reused then destroyed after 60s idle, and on `before-quit`. **The real risk is prompt injection**, not scraping: fetched text reaches a model holding `create_strategy`/`manage_alerts`/`write_journal`. Mitigations are (a) results are wrapped in an explicit `source: "untrusted_web_content"` envelope with a reminder field, (b) the system prompt states web content is never a trigger source and instructions inside it must never be followed, (c) structurally the agent has no order-placement tools at all. `navigate_browser` still exists but is now scoped to "put a page on the user's screen"; the agent reads via `fetch_url` so it can't hijack the visible tab. The embedded browser's home is now DuckDuckGo rather than TradingView — Research does the charting now.
- **Owner-accepted risk:** the chat agent can now read (`read_browser_page`) and screenshot (`screenshot_browser`, `src/main/browser/embedded-browser.ts`) whatever page is open in the embedded browser, including TradingView. This directly overrides the plan's original TV-ToS-driven "display-only, never automate" rule — the owner made this call explicitly when asked (2026-07-19), understanding the ToS risk to the TradingView account. Scoped to chat-only/conversational use (system prompt explicitly tells the agent this is not a trigger source and page content is untrusted); no strategy/alert engine reads from it. If TradingView ever flags/restricts the account, this is the first thing to look at.
- Windows Hello app-launch gate: `src/main/security/windows-hello.ts` shells out to PowerShell (zero new dependency) invoking WinRT's `UserConsentVerifier` — the real OS biometric/PIN prompt. Wired through `security:checkWindowsHello`/`security:requestWindowsHello` IPC → preload → `src/renderer/components/lock-screen.tsx`, gated in `App.tsx` before onboarding/dashboard. Fails open (no gate) on non-Windows platforms or when Hello isn't configured on the device — additive layer on top of credential encryption, not a replacement for it. Gates app launch only, not individual actions (chat/trading stay unlocked for the rest of the session once verified).
- Fixed: Windows Hello prompt appearing behind the app (had to click the taskbar to see it) — Windows' foreground-lock heuristic blocks a background-spawned process's window from stealing focus by default; the actual prompt UI is rendered by a system broker process, not `powershell.exe` itself, so it didn't inherit the "started by the foreground process" exception. Fixed with `AllowSetForegroundWindow(-1)` (`ASFW_ANY`) in the PowerShell script plus `mainWindow.focus()` right before spawning it (`ipc.ts`). Confirmed working by the owner.

## The calibration record: statistics about the planner (S3-6, 2026-08-05)

`plans/calibration.ts`. A plan is a one-shot bet with no sample, so statistical
validation *of a plan* is inapplicable — that is why the strategy path is
frozen. But the **planner** repeats, so everything here is grouped by assumption
**tag**, cross-session, never by plan. With the strategy path gone this is the
only evidence the app accumulates.

**Three ways it could have lied, each closed and each tested:**

- **An unwatched window counted as a miss.** A plan that never fired because the
  laptop was shut records identically to one where price never came — in the
  *flattering* direction. Plans overlapping a `monitor_gap` are excluded and
  reported separately. This is what the heartbeat exists for.
- **A rate from four plans.** Below `MIN_SAMPLE` the rates are **null**; the
  counts stand alone. The UI says "3 of 8 needed for a rate", never "75%".
- **Counting plans that have not finished.** `planned` has not had its chance.

**Captured share is `(exit − entry) / (target − entry)`** — how far the forecast
got, not what it earned. Agent tool `get_calibration` returns the honesty rules
alongside the numbers, because a model handed counts and a null rate will
compute the percentage itself.

**Found while writing it:** the gap query read `audit_log.payload_json`; the
column is `detail`. It would have thrown, been swallowed, returned zero gaps and
marked every plan as watched — the flattering direction, which is the one to
check first.

## Finished plans are the record, not clutter (2026-08-05)

**A plan can only be deleted while it is a `draft`.** An expired-unfired plan is
the **denominator** of the trigger rate: delete the ones that never fired and
the rate counts only the ones that did, so it rises with nothing that would
notice. The refusal now points at the Finished tab instead of just saying no.
**Deletion stays off the agent** — irreversible, and aimed at the owner's own
record.

**A plan that finishes without trading now writes a journal entry.** Review only
ever ran on a *closed position*, so the most common outcome had no written
record — backwards, since it is the most informative case for calibration.
Schema **v18** adds `trade_plans.reviewed`; `reviewResolvedPlan` uses its own
prompt because the question is different (*why did this not happen?*), skips
plans that traded (their position review covers it), and is told whether the
window was **watched throughout** — without that the model reports the trigger
never came when nobody was looking.

**Clutter is a tab, never a delete or a hidden flag.** Active (draft, planned,
triggered) and Finished (closed, expired, invalidated). `triggered` is active: a
plan holding a position is live, and its thesis can still be disproved.

## Simulated and live are app modes (2026-08-09)

`modes/app-mode.ts`, read by `main.ts` **before the database opens** — the mode
decides which file opens. **Two files, never a `mode` column**: a column is the
`source = 'binance'` problem again, and the one predicate you forget blends
silently. Switching mode requires a restart, and the UI says so rather than
faking a live swap.

- **Simulated is the default**, and anything unreadable resolves to it. A
  corrupt config must never be why the app comes up pointed at real money.
- **The guarantee is an absence, not a flag.** In simulated mode `venue()`
  returns `paperVenue` *before* the configured id is consulted, and that adapter
  imports no client, no credentials and no HTTP. A test scans its import lines,
  because a flag can be flipped by a careless edit.
- **`mybot.db` is the SIMULATED file.** Live execution has never run, so every
  row in it is paper; naming it the live file would label simulated fills as
  real *and* hide the owner's history from the default mode. The on-disk
  migration test caught this — the first version had it the other way round.
- **Lessons cross modes; the calibration record does not.** Lessons moved to
  `db/shared-store.ts`, keyed by **pair** rather than session — a lesson about a
  market does not stop being true when a session is archived. Pre-existing
  journal lessons are adopted once on first launch, or the change would have
  silently emptied the agent's memory.
- **Distillation is per pair and mode-aware.** It gathers reviews across every
  session on the pair, and the prompt is told `evidence_origin` — the "no real
  slippage" caveat is only true in one mode. `MIN_REVIEWS_FOR_LESSONS` dropped
  5 → 3: five was a per-*strategy* number and a plan is one bet, so the old gate
  meant lessons would in practice never distil at all.

## Lessons are conditional, or they are wrong (2026-08-09)

A lesson used to be an unconditional sentence. *"Exits fire while the move is
still extending"* can be true in a trend and false in a range, so an agent
learning from unconditional lessons learns to trade the market it happened to
see. Three changes, and the first is the crux:

- **`insights/regime.ts` measures the market — ADX for trend, ATR percentile for
  volatility.** Deterministic, never the model's opinion: a model asked "is this
  trending?" always answers, fluently, with nothing to check it, and that answer
  would be stamped onto a memory injected into every prompt. Volatility is a
  percentile of *the pair's own* history — an absolute ATR% threshold means
  different things on BTC and a small alt.
- **Every lesson carries the regime its evidence came from**, computed
  point-in-time at each trade's timestamp. The model attributes lessons to
  regimes, but only to regimes **present in the evidence** — validated, so it
  cannot invent a qualifier. `mixed` requires a genuine spread (≥70% majority
  is that regime, not mixed), because mixed is the most transferable tag there
  is and has to be earned.
- **Retrieval is conditional.** Lessons that match the current regime are shown
  plainly; the rest are shown *labelled* (`[learned in trending_up]`) with what
  they rest on. Unknown on either side is never a match.
- **The calibration record is now evidence.** "Your range-reclaim theses trigger
  3 of 11 times" is exactly what a durable lesson should rest on, and
  distillation never saw it.

**Two fixture lessons, both the same shape as the S3-5 one:** a noise-free ramp
and a perfect zigzag both produce **ADX 100** — pathological for a directional
indicator, and no market produces one. And `computeFromCandles` returns
`{values}`, not an array, and cleans a NaN field to **0** — an ADX of 0 would
have classified as "ranging" with total confidence.

**Not built, and it needs data rather than design:** nothing scores whether a
lesson *helped*. That needs which lessons were in context when a plan was
authored and whether it beat base rate — real feedback, and with one closed
position it would be scoring noise. It is N-2's shape (temporal memory: when a
lesson was formed and what was believed then), not a threshold tweak.

## One paper balance, not one per session (schema v20, 2026-08-09)

`sessions.paper_balance` defaulted to `'10000.00'`, so **every session was
minted ten thousand dollars from nothing** and the portfolio total was their
sum. The arrow ran the opposite way to how it read: portfolio cash was *derived
from* sessions rather than shared among them. Five sessions read **$50,000** — a
figure that looks like capital and is a count. It also made "not enough cash"
unreachable, which is the defect, not the reassurance.

Three competing notions of available capital existed: a plan's `risk.maxQuote`
(absolute, signed at arm time), a session's balance, and the portfolio total.
Only the first was intentional.

- **`paper/account.ts` owns cash now.** One row, one balance per mode. A session
  is a **workspace** — a pair's plans, journal and history. Cash is not a
  property of a workspace. In live mode the venue's balances are the authority.
- **`paper_balance` is off the `Session` type**, not just unused. The column
  stays as history and nothing maintains it, so a caller reading it would get a
  frozen 10,000 — the same silent-wrong-number failure the v10 repair fixed,
  arrived at from the other side. The type is what makes it unwriteable, and it
  caught two readers immediately.
- **`setPaperBalance` upserts.** `UPDATE … WHERE id = 1` against a missing row
  affects nothing and reports success — every fill would settle silently and the
  balance sit frozen for ever. A write path that does not write.
- **The migration preserves P&L and drops the minted money**: each session
  started at 10,000, so its deviation is what its trading did. Summing the
  *deviations* onto one starting balance keeps the P&L; summing the balances
  would keep the mint. Verified on a real v19 file — $29,850 across three
  sessions became $9,850, the true −$150.
- **`canFund` is now reachable**, so a plan that fires without the cash is
  audited as a refusal rather than logged and dropped.
