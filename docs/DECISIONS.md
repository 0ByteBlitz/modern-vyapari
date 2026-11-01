# Decisions and incidents

**Split out of `CLAUDE.md` on 2026-08-05.** That file is loaded into every
session's context and had grown to 158 KB, most of it narrative about work that
had already shipped. The narrative is worth keeping — this project's most
expensive bugs were each found by reading how the last one happened — but it is
reference, not instruction.

**So: `CLAUDE.md` holds the rules an agent needs before touching anything, and
this file holds why they exist.** Nothing was deleted in the move. The standing
rules that came out of these entries are condensed into `CLAUDE.md`'s *Hard
rules*, *Tech conventions* and *The bug class to hunt*; this file holds the
incident behind each. "Owner" throughout means the person using the app.

**How to read it.** Roughly chronological, and the ordering is the point: the
same defect shape recurs. *A value or a control presented with more confidence
than it earned, with nothing that would notice if it went wrong.* The paper
balance read from a column the SELECT omitted; the FX-contaminated candles; the
kill switch that stopped nothing; alerts that were built but never evaluated;
the overfitting warning whose input nothing ever wrote; a CVD indicator that
measured candle colour; a test suite counting tests whose source was deleted.
If you are looking for the next one, this is the shape.

**Frozen content warning.** Entries dated before 2026-07-30 describe the
strategy path — spec authoring, backtesting, the promotion ladder — which is
frozen. They are kept because the engine modules they name are shared with the
plan path and these are still the fastest way in. Do not build on them.

---

## Contents

- [UI redesign (2026-07-28) — implemented from the Claude Design handoff](#ui-redesign-2026-07-28--implemented-from-the-claude-design-handoff)
- [Research surface (2026-07-28) — KLineChart](#research-surface-2026-07-28--klinechart)
- [Agent presence & chat UX (2026-07-29)](#agent-presence--chat-ux-2026-07-29)
- [Logging & the error boundary (2026-07-29)](#logging--the-error-boundary-2026-07-29)
- [Anthropic API contract (fixed 2026-07-29)](#anthropic-api-contract-fixed-2026-07-29)
- [Strategy deletion (fixed 2026-07-29)](#strategy-deletion-fixed-2026-07-29)
- [Type scale, icons, density & brand (2026-07-29)](#type-scale-icons-density--brand-2026-07-29)
- [Exit reasons say WHO decided (2026-07-29)](#exit-reasons-say-who-decided-2026-07-29)
- [Paper cash balance was corrupt (fixed 2026-07-29)](#paper-cash-balance-was-corrupt-fixed-2026-07-29)
- [Session lifecycle: pause / archive / restore (2026-07-29)](#session-lifecycle-pause--archive--restore-2026-07-29)
- [Home surface (2026-07-29)](#home-surface-2026-07-29)
- [Scenario plans & discretionary tooling (design fixed 2026-07-29 — full spec in `docs/PLAN.md` §17)](#scenario-plans--discretionary-tooling-design-fixed-2026-07-29--full-spec-in-docsplanmd-17)
- [Order-flow coverage & history repair (S1-3, 2026-07-30)](#order-flow-coverage--history-repair-s1-3-2026-07-30)
- [Volume profile & CVD on Research (S1-4, 2026-07-30)](#volume-profile--cvd-on-research-s1-4-2026-07-30)
- [Did price move, or did the level move? (S1-5, 2026-07-30)](#did-price-move-or-did-the-level-move-s1-5-2026-07-30)
- [Scenario plans: table and lifecycle (S3-1, 2026-07-30)](#scenario-plans-table-and-lifecycle-s3-1-2026-07-30)
- [Arming a plan is where a draft becomes a commitment (S3-2 service half, 2026-07-31)](#arming-a-plan-is-where-a-draft-becomes-a-commitment-s3-2-service-half-2026-07-31)
- [Drawings are geometry, references are semantics (S2-2, 2026-07-30)](#drawings-are-geometry-references-are-semantics-s2-2-2026-07-30)
- [The renderer describes, main constructs (S2-8, 2026-07-31)](#the-renderer-describes-main-constructs-s2-8-2026-07-31)
- [The analysis feed's identity is one constant (S2-9 feed, part 2, 2026-07-31)](#the-analysis-feeds-identity-is-one-constant-s2-9-feed-part-2-2026-07-31)
- [Symbol mapping has one home (S2-9 feed, part 1, 2026-07-31)](#symbol-mapping-has-one-home-s2-9-feed-part-1-2026-07-31)
- [One entry path, two owners (2026-07-31)](#one-entry-path-two-owners-2026-07-31)
- [A position can be owned by a plan (schema v15, 2026-07-31)](#a-position-can-be-owned-by-a-plan-schema-v15-2026-07-31)
- [The plan monitor's decision layer (S3-3 part 1, 2026-07-31)](#the-plan-monitors-decision-layer-s3-3-part-1-2026-07-31)
- [One typed channel out to the renderer (S2-7b, 2026-07-31)](#one-typed-channel-out-to-the-renderer-s2-7b-2026-07-31)
- [Integrations are a layer now (S2-9, 2026-07-31)](#integrations-are-a-layer-now-s2-9-2026-07-31)
- [Repo cleanup (2026-07-29) — and a packaging config that silently disabled the fuses](#repo-cleanup-2026-07-29--and-a-packaging-config-that-silently-disabled-the-fuses)
- [Bug sweep (2026-07-29) — controls that didn't control, numbers that weren't measured](#bug-sweep-2026-07-29--controls-that-didnt-control-numbers-that-werent-measured)
- [The test suite was counting deleted tests (found 2026-08-01)](#the-test-suite-was-counting-deleted-tests-found-2026-08-01)
- [An armed plan is now actually watched (S3-3 watch-only, 2026-08-01)](#an-armed-plan-is-now-actually-watched-s3-3-watch-only-2026-08-01)
- [Detail views: plans and strategies open the same way (2026-08-01)](#detail-views-plans-and-strategies-open-the-same-way-2026-08-01)
- [An armed plan on the chart is a view, not ink (J-3 geometric half, 2026-08-01)](#an-armed-plan-on-the-chart-is-a-view-not-ink-j-3-geometric-half-2026-08-01)
- [Three owner-reported gaps closed (2026-08-01)](#three-owner-reported-gaps-closed-2026-08-01)
- [A plan is reviewed against its thesis, not a spec (J-2, 2026-08-01)](#a-plan-is-reviewed-against-its-thesis-not-a-spec-j-2-2026-08-01)
- [The agent was still selling the frozen product (fixed 2026-08-01)](#the-agent-was-still-selling-the-frozen-product-fixed-2026-08-01)
- [Web search 400s on models without programmatic tool calling (fixed 2026-08-01)](#web-search-400s-on-models-without-programmatic-tool-calling-fixed-2026-08-01)
- [The agent can see the product now (J-1 awareness half, 2026-08-05)](#the-agent-can-see-the-product-now-j-1-awareness-half-2026-08-05)
- [One object: the trading plan (owner decision, 2026-08-05)](#one-object-the-trading-plan-owner-decision-2026-08-05)
- [The first position this app has ever opened (S1-2, 2026-08-05)](#the-first-position-this-app-has-ever-opened-s1-2-2026-08-05)
- [Simulated and live are app modes, not per-plan flags (owner decision, 2026-08-05)](#simulated-and-live-are-app-modes-not-per-plan-flags-owner-decision-2026-08-05)
- [Going public (2026-10-31) — the kill switch that threw, and four more](#going-public-2026-10-31--the-kill-switch-that-threw-and-four-more)
- [Which session am I in? (2026-10-31) — "idle" plans, a borrowed chat, and a quit box](#which-session-am-i-in-2026-10-31--idle-plans-a-borrowed-chat-and-a-quit-box)

---

## UI redesign (2026-07-28) — implemented from the Claude Design handoff

Source of truth: **the token block at the top of `src/renderer/index.css`**, (the brief the design was built from was removed on 2026-08-09; it is in git history). The handoff prototype (`Desktop app UIUX design-handoff/`) was removed from the working tree on 2026-07-29 after verifying every design decision had landed in code — all 17 palette values, both font stacks, and the semantic colour rules. It remains in git history at **f6e86db** if a pixel needs re-checking. Direction: professional trading terminal — dense, data-first, dark-only.

- **Design tokens** (`src/renderer/index.css` top block) with the semantic colour rules written in: green = up, red = down, orange = caution/live, cyan = interactive/brand, violet = AI-authored. **The logo's amber is deliberately NOT the UI accent** — amber means "warning" in a trading UI and one colour must not mean two things; cyan (the logo gradient's start) is the accent instead. `font-variant-numeric: tabular-nums` is global and `--font-mono` (IBM Plex Mono) is used for every figure.
- **Session-first IA.** Nav moved out of the titlebar entirely. `src/renderer/components/session-rail.tsx` lists sessions, each expanding to its own surfaces (Dashboard / Orders / Workbench / Journal / Research); cross-session surfaces (Portfolio, Markets, Research browser, Approvals, Settings) sit in the rail footer. Surface routing lives in `App.tsx` via the `Surface` union.
- **Four-band shell:** `titlebar.tsx` (32px, identity + drag; native Windows overlay buttons kept, so the prototype's custom ones were NOT copied) → `app-toolbar.tsx` (36px, mode banner + typed `GO LIVE` arming + risk chips + alerts popover) → `context-bar.tsx` (34px, surface title + measured feed health) → stage.
- **New surfaces:** `orders-page.tsx`, `journal-page.tsx` (entries + the lessons pane, which was previously invisible despite being injected into every AI conversation), `portfolio-page.tsx` (real RevX holdings kept visually separate from paper aggregates), `approvals-page.tsx`.
- **Workbench** (`bot-page.tsx`) restructured: the old single-scroll dump became tabs (Spec / Evidence / Paper activity) under a pinned `PromotionLadder` that states the paper gate in numbers (14 days or 20 trades) instead of implying readiness.
- **Chat is global** (`chat-drawer.tsx`) — 380px drawer or 36px collapsed rail, on every surface except the embedded browser (whose WebContentsView owns its own bounds). Previously chat existed only on the dashboard.
- **Read models added for the UI:** `src/main/db/queries.ts` (`listOrders`, `listJournal`, `journalCounts`, `listActivity`, `portfolioSummary`) → IPC `orders:list`, `journal:list`, `journal:counts`, `activity:list`, `portfolio:summary`. SELECT-only by construction.
- **Deliberate deviations from the prototype, both safety-driven:** the live-mode switch is disabled (no risk engine → a working switch would be a lie), and Approvals shows the *contract* — the risk engine's planned checks and a disabled kill switch — rather than a convincing fake queue.
- **Settings** rebuilt to the prototype's 200px section nav (Risk limits / Credentials / Models & cost / Data & feeds / Audit log). The risk-limit values are **read-only on purpose** — an editable limit that nothing enforces would imply a protection that does not exist. The audit log is now viewable in-app for the first time.
- **Lock screen** gained the design's "While you were away" panel, fed from the audit log, so state carries across the lock rather than requiring an unlock to discover what the engines did.
- **Removed as redundant:** old titlebar nav CSS, first-generation session-rail CSS, `.bot-lifecycle-*` track, and `portfolio-dashboard.tsx` (superseded by `portfolio-page.tsx`; deleted 2026-07-29).
- **Regressions caught during the redesign audit and fixed:** the dashboard rewrite orphaned `ChatPanel` (chat would have disappeared from the app entirely) — now the global `chat-drawer.tsx`; and the toolbar's alerts bell was a dead control toggling state nothing rendered — now backed by an in-memory `alertHistory` in `App.tsx` fed from `onAlertTriggered`, with an unread badge.

## Research surface (2026-07-28) — KLineChart

Owner decision: Research is where the time goes, so it needs real charting, not a read-only candle view. **Dependency: `klinecharts` ^10.1.0** (Apache-2.0, zero runtime deps, ~59k gzip).

**v10 pulls data; our data is pushed** (2026-11-01). v10 dropped `applyNewData`/`updateData` for a `DataLoader` the chart calls whenever the symbol, period or loader changes — and `setSymbol` (which now carries price precision) reloads. `lib/chart-feed.ts` keeps the latest window plus live ticks and serves it on every pull, so a precision change cannot rewind the chart to the last fetch. The chart's period must be the real interval: it drives axis labels and where an overlay lands past the last bar.

**`lightweight-charts` has been removed — KLineChart is the only chart library.** Two libraries meant two themes, two precision rules (the axis rendered `0.09100000` while tables showed `0.091`) and every fix applied twice. `candlestick-chart.tsx` is now a KLineChart wrapper with the same props (`candles`, `height`, `markers`, `levels`), so the dashboard and workbench call sites were unchanged; markers are `simpleAnnotation` overlays and levels are `priceLine` overlays.

**KLineChart ships few overlays** — `fibonacciLine`, the straight/ray/segment family, `parallelStraightLine`, `priceChannelLine`, `priceLine`, `simpleAnnotation`, `simpleTag` (v10 adds `rect` and `circle`, which our registrations override). It does **not** ship wave counts, harmonics, triangles, arrows, Gann or fib circle/extension. An earlier version of the toolbar listed them anyway, so those buttons silently did nothing. They are now custom-registered in `chart-tools.ts`: `threeWaves`/`fiveWaves`/`eightWaves`/`abcd`/`xabcd` (polyline + labelled pivots), `anyWaves` (free count to 12), `rect`/`circle`/`triangle`/`arrow`, `fibonacciExtension`, `fibonacciCircle`, `gannBox`. **Verify overlay names against `node_modules/klinecharts/dist/index.esm.js` before adding a tool** — the library fails silently on unknown names.

Indicators carry editable `calcParams` (`IndicatorDef.params`/`defaults` in `chart-tools.ts`), edited inline in the indicator menu and applied via `chart.overrideIndicator`.

- `src/renderer/lib/chart-tools.ts` — registers what KLineChart doesn't ship: **VWAP** (resets each UTC day), **AVWAP** (anchored, `calcParams: [anchorTs, endTs]` — pass an end for fixed-range), a **position tool** (3 clicks: entry/stop/target; draws risk/reward boxes, R multiple, and an *advisory* size from the session's paper cash at 1% risk), and a **measure tool** (Δprice, Δ%, bar count). Also exports the tool catalogue driving the toolbar.
- `src/renderer/components/pages/research-page.tsx` — left icon rail with flyout groups (Lines / Channels / Fib & Gann / Waves / Shapes / Tools), timeframe strip, indicator menu (price overlays + sub-panels), bar replay, magnet snap, per-drawing lock. Elliott counts (`threeWaves`/`fiveWaves`/`eightWaves`/`anyWaves`) and harmonics (`abcd`/`xabcd`) are KLineChart built-ins.
- **Drawings persist** — schema **v9** `chart_drawings`, keyed by symbol. `interval_min` NULL means "every timeframe" (horizontal/price levels); other tools are anchored to the interval they were drawn on. IPC `drawings:list|save|delete|clear`. Saved on draw-end, on drag-end, deleted on overlay removal — all via per-overlay callbacks in `overlayOptions()`, since KLineChart has no chart-level draw event.
- Data is `getAnalysisCandles` (Binance) plus the live WS stream, so the chart you draw on is the history the engine decided from. Replay freezes live updates while active.
- The position tool's size is **advisory only** — nothing downstream reads it; execution (when it exists) sizes from the compiled spec.

## Agent presence & chat UX (2026-07-29)

The agent now *shows* what it's doing instead of only reporting it afterwards. Three IPC channels from main → renderer drive this; all are fire-and-forget and none can block a tool call.

- **`agent:navigate`** — every tool is mapped to a surface in `TOOL_SURFACE_MAP` (`chat.ts`); calling one switches the UI to that surface so you watch the agent work. `App.tsx` validates the surface name against the `Surface` union before applying it — a bad name from main must not wedge the router.
- **`agent:acting`** — toggles the "agent is working" visual state.
- **`data:updated`** — broadcast after a tool writes (`write_journal` → `journal`, `create_strategy`/`run_backtest` → `strategy`, `manage_alerts` → `alert`). Journal, Workbench, Alerts and Research subscribe and re-query. This replaced polling for agent-written data; **if you add a tool that writes to the DB, add its broadcast too or the UI silently goes stale.**
- **`research:view`** (renderer → main, `agent/research-view.ts`) — Research reports its symbol, interval and chart bounds on mount/change/resize. Without it the agent's chart tools were lying: `read_research_chart` hardcoded 4H while claiming to read "what the user is looking at", and `screenshot_research` captured the whole window including the chat transcript (feeding the model its own words back as an image). Both now mirror the real view and say so when Research was never opened.

**Chat surface additions:** `chat:clear` wipes a session's history; `chat:compact` summarises all but the last 4 messages via a cheap model, writes the summary to the journal as a `strategy_note` tagged `checkpoint,compacted`, deletes the compacted rows and leaves one checkpoint message in their place. Compaction is lossy by design — the journal keeps the durable record.

**Model resolution is dynamic.** `resolveFastModel()` queries `/v1/models` and prefers Haiku → Sonnet → first available, rather than hardcoding a model string that ages badly. It returns `null` (and the caller degrades) if the API can't be reached; `review.ts` uses it unless the `review_model` settings key overrides.

**New surfaces/actions:** per-session **Alerts** page (list/filter/remove, live-updating via `data:updated`), and `deleteStrategy` — the eleven-draft problem needed a way to prune.

## Logging & the error boundary (2026-07-29)

**Rule: the renderer never receives an internal error message.** It gets a stable `code` and one plain sentence; everything else goes to the log file.

- **`src/shared/errors.ts`** — `ErrorCode` union, `AppError` (throw when the user-facing wording is deliberate), `toUserFacing()` (classifies anything else by inspecting it), `UserFacingError = { code, message, hint? }`. Type-only + pure, so it compiles into both bundles.
- **`src/main/logger.ts`** — leveled, scoped, file-backed (`userData/logs/vyapari.log`, rotates at 2 MB, keeps 5). **Redacts on write, not on read**: `sk-ant-*`, `bb_*`, 64-char RevX keys, PEM blocks and auth headers are stripped before the line is written, because a log file outlives the process and ends up in bug reports. Also captures `uncaughtException` and `unhandledRejection` — an unattended app that dies silently is the worst case.
- **`safe()` in `ipc.ts`** is the boundary. It used to return raw `err.message`, so SQLite text, absolute paths and venue API bodies rendered straight into the UI. It now logs the full error tagged with its channel name (all 57 handlers pass one) and returns `toUserFacing(err)`.
- **`Result<T>` changed shape** — `T | UserFacingError` instead of `T | { error: string }`. `isError()` narrows to `UserFacingError`; use **`errorText(e)`** to render (message + hint). Engine files (`paper-exchange`, `review`, `basis-monitor`, `binance-ws`, `analysis-candles`, `indicators`, `agent-fetch`, `database`) log through `createLogger(scope)` rather than `console.*`.
- **Settings › Diagnostics** shows the tail of the log with an errors-only filter, the file path, and an "Open file" button. That's the deliberate route to internals — nothing is pushed at the user through an error message.

**Streaming channels bypass `safe()`.** Chat streams over its own `chat:error` channel, so it never went through the IPC boundary and rendered raw API errors straight into the transcript — the exact leak `safe()` exists to prevent. `chat.ts` now logs the full error and sends `toUserFacing(err)` (message + hint, plus `code`). **Any new channel that pushes main → renderer must sanitise the same way**; the boundary is per-channel, not global.

**Not the audit log.** `audit_log` records what the engines *did* (evidence, order-affecting); the log file records what the process *saw* (diagnostics). Keeping them separate means HTTP noise can't bury the record of a real order.

## Anthropic API contract (fixed 2026-07-29)

The chat request was being built as `requestParams: any`, which is how three invalid requests shipped without failing the build. It is now typed `Anthropic.MessageStreamParams`, so the SDK's own types police it.

- **`effort` is not a top-level parameter.** It lives in **`output_config: { effort }`** (`low|medium|high|xhigh|max`). The old `requestParams.effort = params.effort` sent an unknown field and the API rejected the whole request — this was the error appearing in the chat transcript.
- **`thinking.budget_tokens` must be strictly less than `max_tokens`.** `max_tokens: Math.min(budget + 2048, 8192)` produced 8192/8192 at effort "high" (the default) and was rejected. Now `budget + 4096`.
- **Effort and extended thinking are alternatives, never both** — `output_config.effort` for models whose `capabilities.effort.supported`, `thinking` for `capabilities.thinking.supported`.
- **Never persist an empty assistant message.** The API rejects empty content, so one failed turn used to poison every later turn in that session with a 400 unrelated to what the user typed. `sendChatMessage` now skips empty writes and filters empty rows out of the history it sends.
- **Model listing goes through the SDK** (`anthropic.models.list({ limit: 100 })`), not a hand-rolled `fetch`: the old call pinned `anthropic-version` by hand and took the default page size, silently truncating the list the model picker is built from.
- The `prompt-caching-2024-07-25` beta header is removed — caching is GA and `cache_control` on the system block is sufficient. Pinning a stale beta on every request ages badly.
- **Server-side `web_search` tool (2026-07-29).** Anthropic's `web_search_20260318` — runs on Anthropic's side and returns results with citations. Added because the agent had **no search primitive at all**: asked for "ARB news", it had to invent a URL like `duckduckgo.com/html/?q=…` and feed it to `fetch_url`. Search-results pages are exactly the kind that return a JS shell or a block page, which then triggered the Browserbase fallback — burning cloud-browser minutes on a *search* rather than on content. `max_uses: 5` per turn (cost cap — each search is billed on top of tokens, and a 15-round agentic loop could otherwise run many). System prompt updated: "search to find, fetch to read" — `web_search` for discovery, `fetch_url` for reading a specific page. `fetch_url` is deliberately NOT in `TOOL_SURFACE_MAP` — it was mapped to the Browser tab, so the UI switched there while the actual fetch happened in an invisible headless window; the user was looking at DuckDuckGo's home page, not at anything the agent did. It now stays put and signals through the acting badge. Server-side tool execution is surfaced in the chat transcript via `content_block_start` / `server_tool_use` → same `[[tool:web_search]]` marker the local tools use, so the user sees the search happening. **Safeguard:** there is no capability flag for server tools in `/v1/models`, so support can't be checked up front. If a model refuses the tool, `rejectedWebSearch()` catches it, adds the model to `noWebSearch` (an in-memory `Set`), and tells the user plainly — the next message works without search rather than failing identically forever.

## Strategy deletion (fixed 2026-07-29)

`deleteStrategy` deleted `backtests` then `strategies` and stopped, but `orders.strategy_id`, `journal.ref_strategy_id` and `paper_positions.strategy_id` are foreign keys into `strategies` and the DB runs `PRAGMA foreign_keys = ON`. Any strategy that had journalled or traded therefore raised "FOREIGN KEY constraint failed"; the Workbench discarded the error and re-listed the same rows, so **deleting looked like a no-op**. Now: journal entries and order rows are *unlinked* (the session's permanent record survives), backtests go with the strategy, and a strategy that has recorded paper trades is **refused** with a message telling you to retire it instead — deleting it would quietly rewrite realised PnL. The refusal is rendered in the sidebar rather than swallowed, and a deleted armed strategy triggers `paperEngine.reloadStrategies()` so it also leaves the running engine.

Also fixed there: `useState` for the filter chips sat *below* the `if (!activeSession) return` early return — a hook after a conditional return, which throws as soon as a session is selected.

## Type scale, icons, density & brand (2026-07-29)

The original scale topped out at **12px body / 11px table figures / 9.5px micro labels**, which is below comfortable reading size for a surface you stare at for hours. Everything moved up ~2px, and the scale is now switchable.

- **`data-density` on `<html>`** swaps the `--text-*` and `--icon-*` tokens: `compact` (the original scale), `default` (new baseline), `comfortable`. `src/renderer/lib/density.ts`, chosen in **Settings › Appearance**, applied in `main.tsx` **before first paint** so the app never renders at one size and visibly resizes. Stored in `localStorage` — a per-machine display preference no engine reads; an IPC round trip would just guarantee the wrong first paint.
- **Density changes size only.** Never colour, never what's on screen. A density control that hid columns or rows would be a different feature wearing the same label.
- **Icons scale without touching a single call site.** Components author numeric lucide `size` props; CSS maps each authored size onto a density token (`svg[width="13"] { width: var(--icon-sm) }`). CSS beats presentation attributes, so this wins — and unlike a blanket `.lucide { … }` rule it **preserves the hierarchy the components intended** (a 12px badge icon vs an 18px empty-state icon) instead of flattening everything to one size.
- The Settings specimens carry `data-density` themselves, so each renders at *its own* scale rather than the applied one — hence `[data-density="default"]` restates the `:root` values, and the selectors are unscoped rather than `html[data-density]`.
- **`--titlebar-h` is now 40px**, matching `titleBarOverlay.height` in `main.ts`. The CSS bar was 32–36px while Windows reserved 40px for its own buttons; they had silently disagreed since the redesign.

**Brand.** Logo 18px → **24px** in the titlebar (at 18px it read as a favicon, and that bar is the only place the mark appears in normal use), paired with the tagline as a stacked lockup. Full lockup (Devanagari + romanisation) on the lock screen and onboarding, where there's room.

- Tagline: **जानेर मात्र, किनबेच** — *jaanera matra, kinbech*, "trade only knowingly" (Nepali, owner's choice 2026-07-29). It's the product thesis: the app exists to make you know before you act, which is why strategies must earn their way through backtests and paper trades.
- Constants live in `src/renderer/lib/brand.ts` — one definition for every surface that shows identity.
- `--font-deva` (`Nirmala UI` → `Noto Sans Devanagari` → `Mangal` → sans) gives Devanagari its own stack; the Latin UI font has no glyphs for it and would otherwise fall back to whatever the OS picks.
- The titlebar tagline hides below 1000px width — it's the first thing to go when the window narrows.

Roadmap for the rest (themes, accent choice, light mode, colour-blind-safe mode, chart palette binding, fonts, locale, per-session accent) is **`docs/PLAN.md` §16**, scheduled after Stage A/B — theming before the surfaces settle means re-theming twice. The constraint recorded there outranks every preference in it: **no theme may make a state ambiguous.** Live vs. paper, armed vs. idle, up vs. down must stay distinguishable in every theme, including without colour. A customisation that lets "live" look like "paper" is a safety bug, not a preference.

## Exit reasons say WHO decided (2026-07-29)

`ExitReason` is now `exit_signal | stop_loss | take_profit | manual | session_archived`, and the split that matters is **strategy-decided vs. operator-decided** (`isAdministrativeExit()` in `paper-exchange.ts`).

- **Strategy exits are evidence.** Signal, stop and target are the strategy's own decisions and count toward the paper-promotion gate.
- **Operator exits are interruptions.** A manual close or an archive wind-down says nothing about the setup. Counting one as a loss would slander the strategy for something it didn't do; counting it as a win would flatter it. The Workbench gate now **excludes them from the trade count** and says how many were interrupted; the paper-activity table renders them as a deliberately colourless italic badge rather than red/green.
- **The review agent is told explicitly** — the payload carries `exit_decided_by: "operator" | "strategy"` and the system prompt instructs it not to score an administrative exit or draw conclusions about edge from it, while still noting where price sat relative to stop/target when the trade was cut (the one thing the interruption does tell you).

Realised PnL still counts everywhere it should: the money moved, so cash, fees and portfolio aggregates include it. Only the *evidence* interpretation changes.

## Paper cash balance was corrupt (fixed 2026-07-29)

**`getSessionById` didn't SELECT `paper_balance`.** TypeScript believed the field was a `string`; at runtime it was `undefined`. The paper engine resolves the session through that function on **every candle**, so:

- `openPosition` did `parseFloat(session.paper_balance || "10000")` — every entry was sized off the starting balance forever, regardless of what the session had actually made or lost.
- `closePosition` did `parseFloat(session.paper_balance || "0")` — each close rewrote cash to just the sale proceeds, discarding the rest of the balance.

Realised PnL per position was still correct (it's computed from entry/exit, not from cash), but `sessions.paper_balance` — and anything reading it, including sizing — was fiction. The column is now in the SELECT.

**Schema v10 repairs the stored balances** rather than resetting them, because cash is derivable from the position history: `cash = 10000 + Σ realised_pnl (closed) − Σ (entry cost + entry fee) (open)`. A closed round trip's net cash effect is exactly its realised PnL; an open position has only paid out its cost. Both are recorded per row.

This is the same failure mode as the FX-contaminated candles: a value presented with more confidence than it earned, with nothing checking it. The general defence is now a standing rule in `CLAUDE.md` — **every field a decision depends on needs something that would notice if it went missing.** A SELECT that silently omits a column is indistinguishable, at the type level, from one that doesn't.

## Session lifecycle: pause / archive / restore (2026-07-29)

`setSessionStatus` and the archived-sessions list existed since Phase 1, but **nothing in the UI ever called it** — the archived section could only ever be empty. Now there's an overflow menu (⋯) on each rail row. The semantics, which are the whole point:

- **paused = "no new entries", not "stop watching".** `reloadStrategies` used to drop every strategy whose session wasn't `active`, so pausing a session with an open position stopped its stop-loss and take-profit being checked while the UI still displayed them — believing you're protected when you aren't is worse than no protection. Strategies on a paused session now stay loaded **if they hold an open position**, and `entryAllowed` re-reads the session status per candle (a session can be paused between reload and candle) and refuses entries.
- **archived is terminal and is refused while any position is open**, because an archived session's strategies never load — the position would never stop out, never take profit, and stay permanently unrealised in every aggregate. The refusal points at pause instead.
- **restore is refused if the pair already has a live session** — `idx_sessions_live_pair` is a partial unique index over `status != 'archived'`, so without the check SQLite raises a bare UNIQUE error that means nothing to the reader.
- **Archived sessions are selectable** (the `selectSession` throw was removed) — otherwise archiving is a black hole and the journal you kept becomes unreachable. They're read-only by construction instead: the paper engine skips them, and `setStrategyState` now refuses to arm a strategy on a non-active session (a strategy sitting in `paper` state on an archived session reads as "armed" everywhere while being incapable of trading).
- Every status change calls `paperEngine.reloadStrategies()`; without it a paused session keeps trading until restart and a restored one stays dormant.
- Renderer: `onSessionsChanged` → `App.syncSelectedSession()` re-reads the main-process selection, because archiving the open session clears it in main. The context bar now appends `· paused` / `· archived` to the pair — the pair alone looks identical either way.

### Archive is a wind-down, not a status flip (`src/main/sessions/archive.ts`)

`planArchive(id)` computes what archiving *would* do — the actual open positions with their mark-to-market PnL, how many strategies retire, how many alerts clear, and how much journal/trade history is **kept** — so the confirmation states facts instead of a generic warning. `archiveSession(id, report)` then runs five ordered steps, emitting a real progress event per step over `sessions:archiveStep`:

1. **close positions** — while the session is still active, through the engine's own `closePositionForShutdown` → `closePosition`, so fees, slippage, order/trade rows and the review-agent listener all behave exactly as a normal exit. A second fill model here would drift from the first; that is the bug class this codebase keeps paying for.
2. **retire strategies** → nothing can arm afterwards. 3. **clear alerts** (in-memory first, so stream subscriptions are released, then a DB sweep for rows the engine never loaded). 4. **release streams** via `reloadStrategies`. 5. **flip the status**, last.

A failed step **stops the sequence** and leaves the session as it was — a half-archived session is worse than an un-archived one, because you'd believe it was wound down while something is still running. If a position has no recent cached price the archive is **blocked rather than filled at the entry price**: inventing a flat trade would quietly corrupt the performance record the app exists to produce.

The UI (`archive-session-dialog.tsx`) renders the steps from those events, not from a timer. The only cosmetic element is a 260ms minimum display time per step — SQLite finishes some of these in under a millisecond, and a tick you can't see is useless.

## Home surface (2026-07-29)

`src/renderer/components/pages/home-page.tsx`, `Surface = "home"` (a `GlobalSurface`), and **the app now launches here instead of the last session's dashboard**. Opening into a session answered "what is ARB-USD doing" before the owner had asked it, and hid everything that happened in the other sessions while the app was closed.

Four bands, ordered by urgency: **Needs your attention** (derived, not stored — missing credentials, strategies that exist but none armed, sessions holding an open paper position; the section disappears entirely when empty, because a permanent nag list trains you to ignore it) → **paper performance across all sessions** + **While you were away** (audit-log activity) → **session cards** (pair, armed/idle, realised PnL, closed/open counts, strategy count, last activity) → **biggest 24h movers** (filtered to >$5M volume so the list isn't dominated by illiquid noise).

Read-only by construction: every card is a doorway into a session, no control on Home changes engine state. Reads `portfolio:summary`, `activity:list`, and the Binance ticker snapshot; refreshes every 60s. The rail gained a **Home** button above the session list (not in the global footer) — it's the way back "up", not one more page.

## Scenario plans & discretionary tooling (design fixed 2026-07-29 — full spec in `docs/PLAN.md` §17)

**The gate assumed the wrong thing.** §6's lifecycle treats *backtested* as the only evidence, which assumes every strategy is a repeating rule. A discretionary trader also plans **one-shot bets on a path** ("above 72k held 4h → long to 78k; rejection → retest 68k; below 66k the thesis is dead"). For those, statistical validation is **inapplicable, not merely unavailable** — a 2-trade sample dressed as a backtest launders a guess into a metric. So: **do not loosen the backtest gate.** A separate `trade_plans` table (owner decision — a `type` flag would make `backtested` meaningless for half the rows) with its own gate.

**What replaces the backtest is falsifiability**, and a plan cannot arm without all four: explicit **assumptions**; **invalidation separate from the stop** (a stop is where the *trade* is wrong, invalidation is where the *thesis* is wrong — it can fire while the position is green); a **hard expiry** (a stale conditional firing weeks later into a different market is the worst failure mode of scenario automation); and a **separate, smaller risk allowance** — unvalidated conviction gets less capital. Branches are OCO by default or a triggered plan is silently double-sized. Scenario plans may reach `live_supervised` but **never `live_auto`** — the justification for unattended automation is a validated edge, and there isn't one.

**Statistics move from the plan to the planner.** Per scenario tag: trigger rate, invalidation-before-target rate, captured share of the move. After ~30 plans that is a real calibration record, and `review.ts`/`distillLessons` is already the machinery — it needs assumption-vs-outcome alongside PnL.

**`PriceLevel` replaces "a number".** Levels are **static**, **frozen-derived** (closed window — deterministic forever), or **developing** (moves every bar). Developing levels carry `resolvedAtArm`, a `driftTolerance` and `onDrift` (**default `invalidate`**: a stale plan asking for approval gets approved reflexively at 3am). The danger being guarded: a plan armed against VAH at 71,800 fires three days later at 74,200 — same words, different trade, geometry the trader never agreed to. The review payload must also answer **"did the trigger fire because price moved, or because the level moved toward price?"** — an anchored profile's POC migrates toward price as volume accumulates, and no PnL figure will ever reveal that.

**Drawings are geometry; references are semantics.** `chart_drawings` holds KLineChart overlay points — screen coordinates, not definitions — so a fib drawn on the chart is invisible to the engine. Same rule as candles and KLineChart: **one definition, two consumers.** The chart renders from the reference, the engine resolves from it, and "promote drawing → plan reference" keeps drawing as the authoring gesture. Shared extension point for all of it: **`Condition.value` must accept a `PriceLevel`.**

**The seven required tools sit in three tiers.** Tier 1 computed (Ichimoku, VWAP/AVWAP, volume profile, CVD) — valid triggers. Tier 2 anchored-computed (Fibonacci) — deterministic arithmetic, discretionary anchors. Tier 3 interpretive (Elliott) — **no automated counting will be built**; an auto-labeller that revises itself is repainting in its purest form and would backtest wonderfully while losing money live. Instead Elliott's own rules (wave 2 not beyond wave 1's origin; wave 3 not shortest of 1/3/5; wave 4 not into wave 1's territory) become a **mechanical invalidation source**, with targets as fib projections off the human-labelled pivots.

**All four volume tools are one abstraction** — anchored path-dependent accumulators (AVWAP, anchored profile, fixed-range profile, CVD), so one resolver serves them. Notes that matter: **POC jumps, VWAP glides** (so POC's drift guard is `binChange`, not a percentage); **value-area % and bin width are per-reference parameters, never module constants, and never "auto"** (auto means the level moves as history grows); **profile from OHLCV is an approximation** (default distribution: uniform across the bar's range, rule persisted, displays label it candle-derived).

**CVD is nearly free and you were discarding the field.** Binance sends taker-buy base volume on both paths already in use — kline index `9` (REST, `indicators.ts`) and `k.V` (WS, `binance-ws.ts`) — and both dropped it. `delta = 2×takerBuy − volume`, CVD = running sum, exact at bar resolution. **`taker_buy_volume` is nullable and means "unknown"** — reading a missing value as `0` yields `delta = −volume`, a bar of pure selling that never happened (the paper-balance/FX bug again). Both backfill paths use `ON CONFLICT DO UPDATE`, so **history heals whenever refetched** — no purge. Footprint/delta-at-price is **deferred**: it needs `@aggTrade` plus trade-level storage. CVD is Binance *spot* flow — analysis only, never a claim about Revolut X's book.

**Non-negotiable implementation constraints:** point-in-time correctness (bar *i* sees only bars ≤ *i* — computing a value area over the full range then replaying is look-ahead, and an anchored-profile strategy would backtest beautifully on levels that didn't exist yet); incremental accumulation (path-dependent from an anchor → O(n²) across a replay if recomputed); and **one implementation in main** with the chart rendering main's values. Ichimoku's Senkou spans are the one legitimate "known future" (computed from past data, plotted forward — reading them is *not* look-ahead); the trap there is off-by-`displacement` indexing, which needs a test pinning each of the five lines to its bar offset.

### Built so far (§17 steps 1–2, 2026-07-29)

- **`src/shared/levels.ts`** — `PriceLevel` (static | derived), `DriftTolerance`, `ProfileDistribution`, `VolumeProfileParams`, plus `formatLevel`/`describeThreshold`. Type-only + pure, so it compiles into both bundles.
- **Schema v11** — `candles.taker_buy_volume TEXT` (nullable), `ALTER TABLE` migration in `database.ts`. Captured at **both** ingest points: `KLINE_UPSERT_SQL` + `takerBuyOf()` in `indicators.ts` (kline index 9, and the two duplicated upsert SQL strings are now one constant so they can't diverge again) and `takerBuyFromWs()` in `binance-ws.ts` (`k.V`). Both validate the split is within `[0, volume]` — a wrong delta is worse than a missing one — and the upsert uses `COALESCE(excluded…, candles…)` so a live tick without the field can never erase a known value.
- **`insights/indicator-types.ts`** — `CandleNumeric.takerBuyVolume?: number | null` and `barDelta()`, which returns `null` for an unknown split rather than a number.
- **`insights/volume-profile.ts`** — binned profile, POC/VAH/VAL, contiguous value-area expansion, three distribution rules, `suggestBinWidth()`. Refuses to run without an explicit `binWidth`/`binCount`. One unknown aggressor split nulls the whole per-bin buy breakdown rather than reporting a total short by the bars it couldn't read.
- **`insights/anchored.ts`** — anchored VWAP with σ bands (West's incremental weighted variance, because the naive `E[x²]−E[x]²` form goes slightly negative at crypto price scales and the band then vanishes into `NaN`), and CVD. Both single-pass and point-in-time.
- **`strategy-spec.ts`** — `ConditionThreshold` now accepts a `PriceLevel`; `makeLevelKey`, `extractRequiredLevels`, `isPriceLevel`; `evaluateConditionGroup` takes an **optional** 4th `levels` map, so all existing 3-arg callers are untouched. Validation refuses a live developing level with no drift guard and one missing `resolvedAtArm`, but does **not** order-check two derived `between` bounds (they can legitimately cross as the market moves).
- **`describeThreshold` replaces five copies** of `Array.isArray(v) ? v.join() : v` (alert journal text, alert toast, alerts page, research chart, workbench spec view) — each of which would have rendered `[object Object]` the moment a threshold became a level.
- **Arming a spec with derived levels is refused** (`setStrategyState`). An unresolvable threshold evaluates false by design (fail closed), which is right for safety but would leave an armed strategy looking active and never trading. **Remove that guard when the paper engine resolves levels per bar.**
- Tests: `volume-tools.test.ts`, `price-level.test.ts` — including the two properties that matter (point-in-time prefix stability; unknown-stays-unknown) rather than only the arithmetic.

**Not yet built:** Research rendering of profiles/CVD from main's values, fib ratio sets as data, the Elliott rule-checker, and the `trade_plans` table. `create_strategy` in `tools.ts` still rejects non-numeric thresholds, deliberately — the agent should not author drift-guarded levels before the plan UI exists.

### Level resolver (S1-1, 2026-07-30)

`src/main/insights/level-resolver.ts` turns a `PriceLevel` back into a number every bar. Wired into `paper-exchange.evaluateStrategy` (`resolveLevels`), which passes the map to `evaluateConditionGroup`'s 4th argument. Resolves `vwap` (session, re-anchored each UTC day), `avwap` (+ `upper_N`/`lower_N` σ bands), `volume_profile` (`poc`/`vah`/`val`) and `cvd`. `ichimoku` and `fib` are **not** resolvable yet (S2-4 / S2-1) and say so.

- **Point-in-time.** A resolution `asOf` bar *i* fetches only bars ≤ *i*, including for a closed window — so replaying a fixed-range profile shows it filling up rather than arriving complete on bar one.
- **Incremental**, via new accumulators — `AnchoredVwapAccumulator` / `CvdAccumulator` (`anchored.ts`) and `VolumeProfileAccumulator` (`volume-profile.ts`). The one-shot functions are now loops over the same accumulators, so there is still exactly one implementation of VWAP, CVD and POC/VAH. Each bar is read from the candle source once (asserted by test); recomputing from the anchor per bar is the O(n²)-across-a-replay trap §17 names.
- **Rewinding is explicit.** An accumulator cannot un-see a bar, so a resolution asking for an *earlier* bar than the last one folded in discards the state and rebuilds from the anchor. Without that, a replay restarting mid-run silently carries forward the future it had already seen.
- **`dbCandleSource` selects `taker_buy_volume`** and filters `source = 'binance'`. The `CandleSource` is injectable so tests (and, later, a backtest) can feed their own series.
- **Unresolvable is a value.** `price: null` → condition false (fail closed), never a substitute number. An ATR drift tolerance that can't be measured **nulls the level** rather than proceeding with the guard inoperative.
- **`paper-exchange.seedBuffer` was missing `taker_buy_volume`** from its SELECT — every seeded bar read as an unknown aggressor split, so a CVD condition would have been permanently false on restart while looking armed. Same shape as the `paper_balance` bug.
- **Drift is evaluated, and `onDrift` is real.** Past tolerance with the default `invalidate`, the level resolves to null and the strategy stops trading on it; `reconfirm` keeps trading and reports, pending the operator queue in S3-2. Unresolvable/drifted levels are logged **once per strategy per distinct reason** (`levelNotices`) — per bar would bury the log, never would leave an armed strategy silently incapable of triggering.
- **Arming guard narrowed, not deleted** (`strategy-service.setStrategyState`): only levels whose *source* is unimplemented are refused now.

**Volume-profile bins are now on an absolute grid** when `binWidth` is given: bin *i* is `[i·w, (i+1)·w)`, independent of the window's contents. They used to be anchored to the window's lowest low, so a developing profile's entire grid shifted the moment a new low printed — every edge moved and the POC could jump to a different price with **no volume having changed**. That is the "never an automatic bin width" failure arriving through the origin instead of the width, and it also made the profile un-accumulable. `binCount` mode stays window-anchored and is now **refused for developing profiles**, since it derives the grid from a range that would keep growing. The existing profile tests moved to the new bin edges (POC 100.6 → 100.5 on the fixture).

## Order-flow coverage & history repair (S1-3, 2026-07-30)

`taker_buy_volume` arrived with schema v11, so every bar cached before it is `NULL` — correctly meaning *unknown* — and CVD plus the profile's buy/sell split are unavailable over that history until it is refetched. Nothing looked broken: the chart drew, indicators computed, CVD was simply absent. `src/main/data/candle-repair.ts` makes the gap visible and closes it.

- **Measure first.** `listCandleCoverage()` / `getCandleCoverage()` report bars, known bars, coverage and the span of unknowns per symbol/interval. The list is sorted worst-first so it reads as a work queue. An empty-string `taker_buy_volume` counts as unknown alongside NULL, because `toNumericCandle` reads it that way — a report that disagreed with its consumer would claim CVD should work while CVD said it doesn't.
- **Then heal.** `repairCandleHistory()` refetches only the span containing unknowns. The kline upsert is `COALESCE(excluded.taker_buy_volume, candles.taker_buy_volume)`, so a refetch can only add knowledge, never erase it — safe to re-run. `repairAllCandleHistory()` is **sequential on purpose**: a burst of parallel 1000-bar requests across every cached pair is the shape that earns a temporary Binance IP ban, and a repair that gets the app blocked from its analysis feed has made things worse.
- **It reports measured before/after and never claims success.** `stillUnknown` is surfaced rather than rounded away — Binance stops serving very old history for some symbols. Tested offline precisely so the "fetch achieved nothing" path is exercised.
- **Unrepairable rows say why**: a non-USD quote (fetching BASEUSDT and storing it under a GBP symbol is the FX contamination v8 had to purge) or an interval outside the REST mapping.
- **`fetchKlineRange` in `indicators.ts` is now the single forward-fetch implementation**; `syncRecentFromBinance` is a thin call to it. Both the catch-up and the repair page, upsert and detect stalls identically.
- **UI:** Settings › Data & feeds → `candle-coverage-pane.tsx`, per-row and bulk repair, live progress over `candles:repairProgress`. IPC `candles:coverage` / `candles:repair`.
- **`seedTestCandles` was omitting `taker_buy_volume`** from its INSERT, so no CVD or coverage test could express a *known* split. It now writes it when the fixture supplies one. Same omitted-column shape as the `paper_balance` and `seedBuffer` bugs — the test helper is not exempt.

## Volume profile & CVD on Research (S1-4, 2026-07-30)

**Main computes, the chart renders.** `src/main/insights/orderflow-service.ts` (`getCvdSeries`, `getVolumeProfile`; IPC `insights:cvd` / `insights:volumeProfile`) is the only place these are calculated, reading the analysis feed through the level resolver's `dbCandleSource`, so a profile drawn on Research and a level resolved by the paper engine come from one cached history and one implementation.

- **The registered `CVD` chart indicator was fake.** It computed `delta = close >= open ? +volume : −volume` — "the bar closed green, so call all of it buying". That measures candle colour, not the aggressor split; it produced a value for *every* bar (so it never looked absent), and a trader would have read divergences off it. It is now a **lookup, not a calculation**: `calc` joins main's values by timestamp and returns `{}` for a bar main couldn't compute, so the line breaks at a gap instead of drawing through it. `setCvdSeries()` returns a version counter passed as `calcParams` — KLineChart caches on params, so without it the previous symbol's series stays on screen after a switch.
- **Research states CVD coverage** when it is below 100%, with the unbroken-from date, and points at Settings › Data & feeds. A CVD line with holes is saying the aggressor split is unknown there, not that aggression went flat.
- **`volume-profile-overlay.tsx`** is an SVG layer over the price pane (KLineChart v9 has no profile primitive, and its overlays anchor to *drawn points* whereas a profile anchors to a price axis and a window). Price→pixel goes through the chart's own `convertToPixel`, so the histogram stays registered through zoom and scroll. POC/VAH/VAL lines, value-area shading, and a buy-share bar drawn **only when every contributing bar's split is known** — a partial proportion would look precise and be wrong by exactly the bars that couldn't be read. Toggle is the bar-chart icon in the left rail; off by default. The label always says candle-derived.
- **`binWidth` is suggested once, then belongs to the caller.** Omit it and the service proposes one and sets `binWidthWasSuggested`; anything persisting a profile must send that width back, or the level moves as history grows.

## Did price move, or did the level move? (S1-5, 2026-07-30)

**Schema v12** adds `paper_positions.entry_levels_json`: what each derived `PriceLevel` was worth when the position opened, against what it was worth when the strategy was armed (`armed`, `atEntry`, `driftPct`, `drifted`). Captured in `openPosition` and **nowhere else** — it is only true at that instant, and by the time the review agent runs a developing level has moved on and the comparison is unrecoverable.

It exists for the question no PnL figure can answer (plan §17.6): **did the trigger fire because price moved to the level, or because the level moved to price?** An anchored profile's POC migrates toward price as volume accumulates, so a strategy can look like it is catching setups while the setups walk into it — and it would show up as a perfectly respectable win rate. `review.ts` carries the snapshot as `derived_levels_at_entry` and the prompt instructs the model to compare `armed` against `atEntry`, to treat a materially moved level as weaker evidence *whether the trade won or lost*, and to say so when the levels barely moved (the case that makes an entry trustworthy). NULL for specs with purely numeric thresholds, which is every spec written before §17.

**Not yet covered by a test:** the v11→v12 migration path on an existing database, and an end-to-end paper roundtrip that actually populates the snapshot. The column is additive and nullable so the failure mode is a missing field rather than a wrong one, but this is the half of S1-5 that is asserted only by typecheck.

## Scenario plans: table and lifecycle (S3-1, 2026-07-30)

**Schema v13** — `trade_plans` + `plan_branches`. Separate tables rather than a `type` flag on `strategies`, for the reason §17 already gave: a flag would make `backtested` meaningless for half the rows. A plan is never backtested, because statistical validation of a one-shot bet on a path is *inapplicable*, not merely unavailable.

- **`src/main/plans/trade-plan.ts`** is pure — types, `PLAN_TRANSITIONS`, `validatePlan`. No DB, no engine, no IO, so the authoring UI (S3-2), the monitor (S3-3) and the tests all judge a plan by one set of rules.
- **The gate has no bypass.** `validatePlan` refuses a plan missing any of: at least one assumption; a thesis invalidation; a hard expiry that is in the future and under `MAX_PLAN_HORIZON_MS` (180 days — "a thesis that far ahead is a forecast, not a plan"); its own `maxQuote` risk budget.
- **Invalidation must not merely restate the stop.** If the thesis invalidation is the same level as *every* branch stop, it is refused — otherwise the thesis has nowhere to be wrong except by losing the trade, and the plan has quietly become an ordinary trade with extra words.
- **`PlanState` lives in `shared/ipc-types.ts` and has no `live_auto` member.** A plan's licence comes from falsifiability, never a validated edge; the state not existing beats a check that can be forgotten. **`expired` and `invalidated` are deliberately distinct** terminal states — collapsing them would destroy the calibration record's most useful distinction, plans that never fired vs. plans that fired and were wrong. `triggered → invalidated` is reachable, because a thesis can be disproved while its position is still green.
- **Branches are a child table, not JSON.** The monitor asks per-branch questions (which fired, which OCO cancelled), and an answer inferred from a blob is one nothing can index or audit. OCO is on by default; disabling it warns rather than refuses, and OCO branches share one budget so their shares cannot exceed 100%.
- **No `direction` field.** The venue is spot-only, so every branch is a long. Modelling a short that cannot be placed would be a control that does not control.
- **Migration note, corrected while writing this:** `SCHEMA_SQL` is re-run on **every** startup, not only at creation, so its `CREATE TABLE IF NOT EXISTS` already covers existing installs. The `currentVersion < 13` block is belt-and-braces (same shape as v9's `chart_drawings`) and is commented as such — an earlier draft of that comment claimed SCHEMA_SQL ran only at creation, which is false.
- **Tested:** the four refusals, the two structural rules, drift-guard requirements on developing levels, the transition table, and — closing the gap S1-5 left open — a real **v12 → v13 migration on an existing on-disk database**, asserting the tables appear, the version reaches 13, and pre-existing session data is untouched.

## Arming a plan is where a draft becomes a commitment (S3-2 service half, 2026-07-31)

`plans/plan-service.ts` is CRUD plus `armPlan`, which is the only interesting operation.

- **The gate runs at ARM, not at save.** A draft is where you think, and refusing to save an incomplete thought would push authoring back into a text file. `createPlan` therefore stores anything; `armPlan` runs `validatePlan` with no bypass.
- **Arming resolves every derived level to a number and writes it to `resolvedAtArm`** — the baseline every later drift check measures against. New `levelResolver.resolveAtArm()` exists for exactly this: `resolve()` deliberately refuses to recompute a `snapshot_at_arm` level (it hands back what the trader agreed to), but arming is the one moment that value does not exist yet.
- **A level that cannot be computed refuses the arm.** No placeholder is written. A fabricated baseline would make every later drift answer fiction — the `paper_balance` failure wearing a new hat. Tested: a plan with an unresolvable AVWAP stays `draft` and its level still has no `resolvedAtArm` property.
- **`armPlan` returns the resolved values**, which is what makes S3-2's "diff of concrete numbers before arming" possible: "VAH resolves to 71,842 right now" is the difference between approving a thesis and approving a geometry.
- **The UI does not re-implement the gate.** `plans-page.tsx` (per-session **Plans** surface) calls `armPlan` and renders whatever errors come back; it never pre-judges armability. A renderer copy of `validatePlan` would be a second definition of the rule deciding whether unvalidated conviction reaches real money, and the two would drift. Levels are authored as either a typed price or a **promoted reference** from S2-2, which is where the reference layer finally pays off.
- **An armed plan cannot be edited or deleted.** Editing would mean the plan that fires is not the plan that was approved; deleting would erase the calibration record. Re-authoring means invalidating and writing a new one — deliberate friction.

## Drawings are geometry, references are semantics (S2-2, 2026-07-30)

**Schema v14** adds `level_references`. `chart_drawings` stores KLineChart overlay points — where ink sits on a canvas. That says nothing about what the trader *meant*, so a fib drawn on the chart was invisible to the engine and a level the engine resolved could not appear on the chart: two definitions of one idea, the bug class this codebase keeps paying for. A reference holds a `PriceLevel` definition; the chart renders from it and the engine resolves from it.

- **`plans/level-reference.ts` is the pure mapping**, `plans/level-reference-service.ts` is persistence — so the mapping is testable without a database and the DB layer holds no interpretation.
- **Promotion emits a `LevelDraft` — a `PriceLevel` *without* `resolvedAtArm`.** A drawing is promoted long before any plan is armed, so there is no "value at arm" yet; writing `0` or `NaN` there would put a fabricated number in the exact field every drift check measures against. Arming fills it in. Asserted by test.
- **What promotes:** horizontal drawings (`horizontalStraightLine`, `horizontalRayLine`, `horizontalSegment`, `priceLine`, `simpleTag`) → a static level; `rect` → a **fixed-range** volume profile, whose closed window resolves to one value forever.
- **A rectangle without an explicit `binWidth` is refused.** Never an automatic width — it changes as history grows, so the level would move for a reason unrelated to the market.
- **Everything else is refused with its own reason**, and the refusals are the substance: sloping lines (a price that varies with time is not a level any `PriceLevel` source expresses), fib and Gann (not resolvable until S2-1 — promoting one now yields a level that evaluates false forever while looking armed), wave counts (a human reading; no auto-counter will be built), and advisory tools. An unknown kind is refused rather than guessed at.
- **Erasing the ink must not erase the meaning.** `detachDrawing()` nulls the pointer when a drawing is deleted and the reference survives, because a plan may already be armed against it. Regression-tested.
- **Renderer half (same day).** IPC `levels:list` / `levels:promote` / `levels:delete`, bridged through preload and `@/lib/api`. `level-references-panel.tsx` floats over the Research chart (bookmark icon in the left rail): it lists references, offers promotable drawings that are **not already promoted** (promoting twice would create two definitions of one level), and prompts for the bin width when promoting a rectangle so that choice stays the trader's. **Refusals are rendered, never swallowed** — a promote button that silently did nothing is how a trader ends up believing in a level the engine cannot see.
- **Static references are drawn as locked price lines; derived ones are not.** A derived level's value depends on a window the resolver owns, so drawing a line for it in the renderer would be the chart computing its own answer — the exact failure the fake CVD indicator already cost this project once. They appear in the panel instead.
- **`drawings:delete` now calls `detachDrawing` first**, so the ordering guarantees the reference is orphaned rather than left pointing at a deleted row.

## The renderer describes, main constructs (S2-8, 2026-07-31)

`plans-page.tsx` was assembling `ConditionGroup` JSON by hand — the clearest instance of the "features glued by frontend" problem the owner named. It now sends a **`ConditionIntent`** (`{subject:"price", operator, value}`) and `plans/condition-intent.ts` compiles it.

- **The risk was never only coupling.** A caller that got the shape slightly wrong produced a group the engine would store and then evaluate as *nothing* — and `validatePlan` reads an empty invalidation as a **missing** one, so a silently-dropped condition surfaced as "this plan has no thesis invalidation" three steps from the mistake. `compileIntent` therefore returns a **refusal with a reason**, never an empty group, and `createPlan` returns a result envelope rather than a plan.
- **The realistic failure it catches:** the price field left blank, so the renderer sends `Number("")` — `NaN`. Previously stored as a condition that could never trigger while looking armed.
- **Authored and stored branch shapes are deliberately different types.** `PlanInputView.branches[].trigger` is an intent; `PlanBranchView.trigger` is the compiled group. The renderer never constructs what the engine evaluates.
- A `PriceLevel` value passes through untouched, so a plan can be authored against a promoted reference without the renderer knowing what a reference *is* structurally.

## The analysis feed's identity is one constant (S2-9 feed, part 2, 2026-07-31)

**All 18 `source = 'binance'` predicates**, across 10 files, now read `${FEED_SCOPE_SQL}` from `integrations/feed/symbols.ts`. The feed's identity was a string literal repeated through the query layer, so a second feed could not be introduced without finding every one — and missing one would not fail, it would **silently blend two sources inside one computation**, which is the failure schema v8 had to purge a candle table over.

- **Source is identity, not metadata.** Switching feeds does not migrate history; it starts a new cache, exactly as archiving starts a new session epoch.
- **A SQL fragment, not a bound parameter, deliberately.** These predicates sit inside larger hand-written queries with their own placeholder ordering, and threading one more parameter through eighteen call sites is exactly the mechanical edit that goes wrong once and is never noticed. The value is a module constant, not user input.
- **`feed-scope.test.ts` is the guard, and it was written and run BEFORE the change**, so its expected values describe the old behaviour. It works by **decoy**: every fixture seeds a second candle from a different source at an absurd price (9999). If the scope ever widens — a predicate dropped, a helper that forgets its filter, a future feed writing to the same table — the decoy is included and the assertions move. A test that merely checked "the right rows are present" would pass in that world. One test asserts the decoy rows exist, so a broken fixture cannot make the others pass for the wrong reason.
- Verified three ways beyond the suite: no literal `${FEED_SCOPE_SQL}` survives into the compiled JS (which is what a `${…}` in a *quoted* string would produce), no raw predicate remains, and the compiled query executes against a real database.

## Symbol mapping has one home (S2-9 feed, part 1, 2026-07-31)

`integrations/feed/symbols.ts` replaces **five** hand-written copies of `${base}USDT` (`indicators.ts` ×2, `binance-ws.ts`, `binance-derivatives.ts`, `basis-monitor.ts`) and **five** copies of the non-USD guard.

- **The guard is the point, not the concatenation.** `toFeedSymbol` returns **null** for a non-USD quote — never a best-effort string. Synthesising `BASEUSDT ÷ QUOTEUSDT` is precisely what schema v8 had to purge: the FX rate defaulted to 1 until its first tick, so raw USD prices were stored under a GBP symbol, while the REST backfill applied no conversion at all and one symbol's history carried both scales with a ~1.3x step between them.
- **Null means "this pair has no analysis feed"** — a fact callers handle, not an error. A GBP session can exist (RevX trades them); it just cannot be charted or backtested. `noFeedReason()` gives one wording for saying so.
- `fromFeedSymbol` is deliberately strict, because the `!ticker@arr` firehose carries cross pairs and leveraged tokens, and letting one through yields a symbol that looks tradable and is not.

## One entry path, two owners (2026-07-31)

`paper-exchange.persistEntry()` now holds the order + trade + position + balance write, and is **owner-agnostic**: `{kind:"strategy", id}` or `{kind:"plan", branchRowId}`. `openPosition` delegates to it, and the existing round-trip, fill-equivalence and dynamic-position tests prove strategy behaviour is unchanged.

- **Why extract rather than add a second path:** the fill model, the fee, the balance arithmetic and the protective-level rule are exactly the things that must never fork. A second entry path is how a backtest and a paper run start disagreeing — a failure this project has already paid for once.
- **`orders.strategy_id` stays NULL for a plan-opened position.** That column is a foreign key into `strategies`, and inventing a row to satisfy it is the synthetic-strategy shortcut v15 rejected. `paper_positions.plan_branch_id` is the authoritative link.
- It now uses `withTransaction` rather than hand-rolled BEGIN/COMMIT, so it composes with any outer transaction instead of silently opening a second one.

**Deliberately stopped here.** The plan side is *not* wired to open positions yet, and the reason is not effort: **the paper engine has never executed a single position** (`paper_positions` is empty, S1-2 unrun). Extending an execution path that has never run once would be building on unverified ground, and the first thing to discover would be whether the *strategy* path works — not the plan path. **Run S1-2 first**, then wire plan entries onto the proven core.

## A position can be owned by a plan (schema v15, 2026-07-31)

`paper_positions.strategy_id` became nullable, `plan_branch_id` was added, and a **`CHECK ((strategy_id IS NULL) <> (plan_branch_id IS NULL))`** enforces exactly one owner.

- **The rejected alternative was a synthetic strategy row per plan.** It would have kept the column `NOT NULL` at the cost of putting plans inside the strategy lifecycle — corrupting the promotion states and the calibration record. A second `plan_positions` table was rejected for a stronger reason: it would be a second execution path, and "no second fill model, ever" is what the whole plan monitor is built around.
- **Ambiguous ownership is refused at the database.** Owned by both would double-count in aggregates; owned by neither leaves the review agent unable to tell which intent to judge the trade against. Both are tested.
- SQLite cannot drop `NOT NULL` in place, so this is a **rebuild** — create, copy, drop, rename, in a transaction, with `foreign_keys` toggled *outside* it (SQLite ignores the pragma while a transaction is open). The copy is column-explicit so a future column added on one side only fails loudly instead of shifting values silently.

**A rule this nearly cost us, worth remembering:** `SCHEMA_SQL` is re-executed on **every** startup, including against a database still on the *old* shape. The first version of v15 added `CREATE INDEX … ON paper_positions(plan_branch_id, …)` to `SCHEMA_SQL`; on an existing database the `CREATE TABLE IF NOT EXISTS` skips, the column does not exist yet, and the whole statement fails — **crashing the app at launch, before the migration that would add the column could run.** Caught by running the migration against a real v14 database rather than trusting the suite, which only builds fresh schemas. **Any index over a column introduced by a rebuild belongs in the migration block, not in `SCHEMA_SQL`.**

## The plan monitor's decision layer (S3-3 part 1, 2026-07-31)

`plans/plan-monitor.ts` answers "what should this armed plan do on this bar?" and nothing else. Pure — no DB, no clock, no engine; the bar, the condition evaluator and the level resolver are all injected, so a dry run (S3-5) and a replay judge a plan by the same implementation the live monitor does.

- **The precedence is the design, and it is fixed: expiry → invalidation → drift → triggers.** A bar can satisfy several at once, and which one wins is what gets written into the calibration record — the only evidence a plans-only product accumulates. Expiry beats a trigger because a stale conditional firing weeks later into a different market is the worst failure mode of scenario automation. Invalidation beats a trigger because recording a bar that both fired *and* disproved the thesis as a trigger would flatter the thesis.
- **Drift disqualifies a branch before its trigger is even evaluated**, and an unresolvable level does the same — fail closed, but **loudly**: the reason goes into `notices` rather than being swallowed, because a plan that silently cannot fire looks armed and is not.
- **Targets are drift-checked too**, not just entry and stop. Entering against an approved stop toward a target that moved is not the trade that was approved.
- **A drifted branch does not block a healthy sibling**, and OCO cancellation is decided here — the first branch to fire cancels the rest, or a plan describing two ways the market might resolve takes both and is silently double-sized.
- **`triggered` plans stay watched.** A thesis can be disproved while its position is green; a naive "only watch un-triggered plans" filter would miss exactly that case.

**Not done yet, and it matters:** a triggered branch does **not** open a position. It cannot until schema v15 — `paper_positions.strategy_id` is `NOT NULL REFERENCES strategies(id)`, so a plan-opened position has nowhere to live. And when it is wired, the monitor must be a **direct call from the paper engine**, not a second `binanceWS.onCandle` subscriber: the two share `session.paper_balance`, and `EventEmitter` fan-out has no ordering guarantee between listeners.

## One typed channel out to the renderer (S2-7b, 2026-07-31)

`events/outbound.ts` replaces twelve `webContents.send` calls scattered across six modules. The point is not tidiness: `safe()` in `ipc.ts` guards every *request* handler, and **nothing guarded the pushes** — so the internal↔user boundary was per-call-site rather than per-process. That is why chat streaming once rendered raw Anthropic API errors straight into the transcript.

- **`emitError` is the only way to put a failure on a channel.** It takes `unknown`, runs `toUserFacing`, and constructs the payload. There is deliberately no overload accepting a pre-built string — that shape is exactly what let an unsanitised message through.
- **Deliberate wording goes through the same path**, as an `AppError`, rather than an escape hatch. The three hand-written chat errors were converted; their text is unchanged.
- **`OutboundMap` enumerates every channel and its payload**, so a shape cannot drift from what the renderer expects without the compiler noticing.
- **The destroyed-target guard lives in one place.** Each old site had its own `isDestroyed()` check, and the WS candle ingest — which can outlive a window and keeps ticking — is exactly the writer that forgets one.
- **`emit` broadcasts to every window, not "the main window"**: `data:updated` is a statement about the world, and resolving a single window would silently drop it for any other.
- **Still not an event bus.** One-way, no request/response, no `once`, no `waitFor` — the last is how a bus starts being used for sequencing. The S2-7 rule holds: notifications of things that already happened, never a step in a sequence that decides money.

## Integrations are a layer now (S2-9, 2026-07-31)

Venue access goes through `integrations/venue/` — `port.ts` (the interface), `revolutx.ts` (the adapter), `registry.ts` (which one is active). **Nothing outside that folder imports `revx/client` any more**; `ipc.ts` and `basis-monitor.ts` call `venue()`. Full measurement and the security review are in `docs/ARCHITECTURE.md`.

- **The vault moved first, and that ordering mattered.** `revx/credentials.ts` → `security/credentials.ts`. It holds the **Anthropic and Browserbase** keys as well as the venue's, so moving Revolut X behind an adapter without extracting it first would have dragged every consumer of the Anthropic key into the venue adapter's dependency graph. *(An earlier draft of ARCHITECTURE.md claimed `agent/chat.ts` imported the exchange **client** and called it a security finding — it imports **credentials**. Corrected; only 3 modules ever touched the client.)*
- **Capabilities are declared and deliberately pessimistic.** `canPlaceOrders: false` until S4-1 exists; `venueSideProtectiveOrders: false` until S4-2 verifies it against the real API. The plan's hard rule is that every live position carries a venue-side stop, so **an adapter that cannot rest one must refuse live trading rather than emulate it locally** — a local stop is not a stop if the app is closed. Claiming the capability before it is verified is how a position ends up unprotected.
- **Adapters are a compile-time map.** No dynamic `require`, no plugin directory, no path from configuration to code — a pluggable venue that could load arbitrary code with vault access would be a credential stealer with a config file.
- **Choosing the venue is privileged**, in the kill-switch class: audit-logged, refused while anything is open (switching underneath a position strands it), and **no agent tool may call it**. There is no `set_venue` tool and there must never be one.
- **`getCandlesForReconciliation` is named that way on purpose.** Venue candles are execution truth, never charts or indicators; the port makes the rule harder to break rather than easier.
- The switch decision is extracted as pure `evaluateVenueSwitch` so every branch is testable — with one adapter registered, a real `setActiveVenue` call can never reach the open-commitments guard, and adding a runtime registration hook to make it reachable would be exactly the config-to-code path forbidden above.

### Per-integration secrets (same day)

`security/integration-secrets.ts` is the shape that admits a second auth scheme — `ed25519_signed | api_key | hmac | none`, with declared fields, so a venue signing by HMAC has somewhere to live instead of reusing fields that mean something else.

- **The existing Revolut X keys were deliberately NOT migrated.** They stay at `private.key.enc` / `public.pem` / `apikey.bin`, and `REVOLUTX_AUTH.legacyStorage: true` records that in code rather than folklore. Migrating buys tidiness and risks the one value that cannot be re-derived — a private key the venue already knows about — with no backup routine yet (L-3). New integrations use the new store from the start.
- **No plaintext fallback.** If `safeStorage` is unavailable the write is *refused*, because a credential written in plaintext during a brief keychain outage stays in plaintext forever and nothing would notice.
- **Ids and field keys are validated before touching the filesystem** (`^[a-z0-9_]+$`). An integration id is the kind of value that eventually comes from configuration, and `../..` in a filename is how a credentials directory stops containing only credentials.
- **`secretStatus()` returns presence booleans only** — the general form of the rule `setup:status` already followed.
- **The cipher is reached lazily and is injectable**, which is why this is the first credential code in the project with tests: `credentials.ts` imports `safeStorage` at module load, so importing it in a plain Node test process throws.

### The venue name leaves the contract (same day)

IPC channels renamed `revx:*` → `venue:*` (balances, candles, tickers, pairs). **The preload method names were already venue-neutral** (`getBalances`, `getTickers`, `getPairs`), so the renderer API surface did not change at all — the rename was confined to `ipc.ts` and `preload.ts`, which is smaller than the architecture doc estimated.

- **New `venue:info`** returns the active adapter's capabilities plus the available list — ids, a display name and booleans. No credential material, and nothing that could be mistaken for it.
- **`context-bar.tsx` reads the venue's name from the adapter** instead of the literal "RevX". That bar reports *execution* health, so labelling it with a venue that isn't running would be a status line about the wrong system. Fixed while doing it: the poll effect closed over `venueName` with an empty dependency array, so it would have shown the placeholder forever.
- `candles-card.tsx`'s bid/ask annotation is now "Venue bid/ask" — it means "where orders would execute", not "Revolut X specifically".
- Remaining "Revolut X" strings in `credentials-panels.tsx` are **correct as literals**: they instruct the owner on setting up that specific venue's API key, and a generic label there would be less useful, not more.

## Repo cleanup (2026-07-29) — and a packaging config that silently disabled the fuses

**`electron-builder.yml` was overriding the hardened `build` key in `package.json`.** electron-builder resolves a dedicated config file **in preference to** `package.json`'s `build` key, and the YAML contained no `electronFuses` block at all — so every fuse documented in the security notes above (`runAsNode: false`, `onlyLoadAppFromAsar`, `embeddedAsarIntegrityValidation`, `enableCookieEncryption`) was inert, along with `forceCodeSigning: false`. It also declared mac/dmg and linux/AppImage targets for a Windows-only app whose launch gate is Windows Hello, and a narrower `files` list (two assets instead of `assets/**/*`). Its own header comment said it was "inert until electron-builder is installed" — which stopped being true the moment `electron-builder` became a devDependency and `package:win` was added, and packaging has never been run, so nothing surfaced it. **The YAML is deleted; `package.json`'s `build` key is the single source of truth.** Verify at launch-week L-1 that `npm run package:win` produces an installer whose fuses are actually applied — the fix is unproven until then.

**Deleted as dead code** (all confirmed unreferenced by an import scan; git history keeps them):

- `src/renderer/components/portfolio-dashboard.tsx` — superseded by `portfolio-page.tsx`.
- `src/main/agent/proactive-trader.ts` + its test — referenced only by its own test, and actively wrong: it picked `activeStrategies[0]` regardless of session or symbol, hardcoded a $1000 buy with ±5/10% levels, and evaluated no strategy conditions at all despite a comment claiming to. A passing test over that logic is worse than no test — it certifies nonsense. If proactive trading returns it must go through `OrderPipeline` and evaluate real specs.
- `src/main/event-bus.ts` + its test — referenced only by its own test. **A bus is genuinely needed, but not that one** (scheduled as roadmap S2-7). There are four hand-rolled listener registries repeating the same pattern (`binance-ws`, `alert-engine`, `paper-exchange`, `kill-switch`) and seven scattered `webContents.send` sites that must each remember to sanitise — the outbound side is where a typed bus pays, because the boundary is per-channel today and chat streaming already leaked raw API errors past it once. What was deleted was the wrong shape: it sat *beside* the direct wiring instead of replacing it, logged every payload at `debug` on a per-second hot path, and its event map carried `order:intent`/`order:executed`. **The rule for the replacement: the bus carries notifications of things that already happened, never a step in a sequence that decides money.** The paper engine's per-candle order (protective levels every tick → closed-bar signals exactly once) is load-bearing and `EventEmitter` gives no ordering guarantee between listeners; execution stays direct calls, for the same reason the review agent is a downstream listener rather than a subscriber.

**`.gitignore` rewritten** with sections and reasons. Now also covers `*.tsbuildinfo` (`src/renderer/tsconfig.tsbuildinfo` had been tracked, producing a diff on every build), local databases (`*.db`/`*.sqlite`/`data/`/`backup/` — a trading DB is personal financial history), broader secret patterns (`*.key`, `*.p12`, `.env.*`), and editor/OS noise — with `.vscode/settings.json` deliberately kept, since its two CSS-lint suppressions are needed by every checkout for Tailwind v4's at-rules.

**Kept despite being unreferenced** (re-confirmed by an import scan on 2026-07-31, which found exactly three: `exchange/revolutx-exchange.ts`, `exchange/reconciliation.ts`, `risk/order-pipeline.ts` — all Sprint 4 scaffolding, all deliberate): `src/main/exchange/revolutx-exchange.ts` and `reconciliation.ts`. They are Sprint 4 scaffolding (roadmap S4-1/S4-3), and both now throw or report honestly rather than fabricating success — deleting and re-creating them would be churn, and the loud-failure comments in them are the record of what they nearly cost.

## Bug sweep (2026-07-29) — controls that didn't control, numbers that weren't measured

A codebase-wide audit after Stage C. The recurring theme is the one named in the paper-balance and FX entries: **a value or a control presented with more confidence than it had earned, with nothing that would notice.** Every fix below is that shape.

**The kill switch didn't stop the engine that trades.** `killSwitch` was exposed over IPC and wired to a real button on Approvals, and *nothing in the running system read it* — tripping it flipped an in-memory flag while the paper engine carried on opening positions. Only `orderPipeline.submitIntent` consulted it, and nothing in production calls that yet. Now checked in `entryAllowed()` (the single choke point for opening), audit-logged once per strategy per trip rather than once per bar, and audit-logged at the IPC boundary so the record shows *why* entries stopped. **Deliberately not checked on the exit path:** stops and targets must keep firing while tripped. Freezing everything would strand every open position with no stop-loss — the same failure the pause semantics were fixed to avoid. Kill switch means "take no new risk", not "stop watching the risk already taken". The Approvals copy claimed it "cancels pending intents, halts strategy evaluation" and now says what it does. Regression-tested both halves in `kill-switch-engine.test.ts`.

**The overfitting early warning was unreachable code.** `getStrategyComparisons` regex-scraped its backtest expectation (`/win rate ([\d.]+)%/`) out of a `backtest_review` journal entry — a `kind` **nothing in the codebase ever writes**; only the chat agent could, in free prose, via `write_journal`. So `expectedWinRate` was null in every real installation, the card rendered "—", and `overfittingWarning` could never be true. Stage B's divergence detector had never once been capable of firing. It now reads the strategy's latest completed backtest from `backtests.result_json`, preferring **out-of-sample** metrics (in-sample is the number the spec was shaped against, so comparing paper to it flatters or damns the strategy for the wrong reason). Paper trade count and win rate there now also exclude operator exits, per the "exit reasons say WHO decided" rule — realised PnL still counts every exit, because the money moved.

**Trailing and breakeven stops were never written down.** `checkProtectiveLevels` ratcheted `pos.stopPrice` in memory only, so `paper_positions.stop_price` kept the entry-time level: the Workbench, the archive preflight's mark-to-market and the review agent's payload all reported a stop the engine was no longer using, and a restart reverted the ratchet. The moved stop is now persisted on change, and `toPosition` reconstructs `highestPriceSeen` from the candle cache (`highWaterSince`) instead of resetting it to the entry price — otherwise a position 30% up resumed trailing as if just opened.

**Offline alert catch-up couldn't detect a cross.** `evaluateHistoricalCandles` called `evaluateAlert(..., [c, c])` — the same candle as both current and previous. Every `crosses_above`/`crosses_below` alert compares the two, so with them identical no cross was detectable; indicator alerts were worse, since an RSI computed from two copies of one bar could fire on a number that never existed. Now replays bar by bar over a growing window.

**Risk Gate 2 could be bypassed by omission.** `estimatedQuote` fell back to `0` for a market intent carrying only `quantity` (no price, no `quoteAmount`), so an unbounded order passed the cap whose entire job is to bound it. A gate that cannot measure the thing it caps now **fails closed**. Also added `GATE_0_SESSION_ACTIVE`: a non-active session was being reported as a `GATE_4_MAX_OPEN_POSITIONS` failure, so the audit trace blamed a position cap that was never the reason.

**`tradesTodayCount` counted the wrong day's wrong event.** The order pipeline counted `closed_at >= startOfDay`, so a position opened this morning and still running counted for nothing (`NULL >= x` is never true) while a trade opened yesterday and closed today spent today's budget. Now counts `opened_at`.

**Hourly equity snapshots were both wrong and contaminating.** The scheduler marked open positions at their **entry price**, so equity stayed pinned at open-time value — an hour of drawdown recorded as a flat line, in the one series meant to tell you what happened while you were away. Now marked to the last cached close, saying so when a position has no recent price. Separately, those 24-a-day `observation` rows were being fed to `distillLessons`, which counted them toward `minReviews` (five snapshots is not five trade reviews) and let them crowd real reviews out of the 40-row window — so the model was asked to distill durable lessons, injected into *every future conversation*, from a list of hourly cash balances. Distillation now gates on `trade_review` rows only and filters machine-generated observations by an `automated` tag.

**The review agent's price window could miss the trade entirely.** `tradeWindowCandles` had no `interval_min` filter: it read every cached timeframe for the symbol, then took the first 60 rows ascending. On a pair with 1m candles cached, the window was consumed by the hour *before* the entry — so "how much of the favourable move was captured" was answered from bars that predate the position. Now scoped to the strategy's own `eval_interval`.

**The feed watchdog fought the reconnect it triggered.** `checkFeedHealth` ran `if (!isConnected()) reconnect()` every 30s. `readyState === CONNECTING` also reads as not-connected and `reconnect()` force-closes first, so on a slow link every handshake was killed at the 30s mark; each forced close fired `onclose`, scheduling the socket's own 5s backoff, which then raced the watchdog. And with nothing subscribed there is no socket *by design*, so an idle app dialled Binance every 30 seconds. Now it only intervenes when something wants data, nothing is connected or connecting, and no retry is pending (`hasSubscribers`/`isConnecting`/`isReconnectPending`).

**`listOrders` duplicated multi-fill orders.** `LEFT JOIN trades` emitted one row per fill, each showing that fill's fee as the order's total, and the duplicates counted against `LIMIT` — silently truncating history. Invisible under paper (one trade per order); it would have surfaced the first time a live order filled in pieces. Fee is now a correlated `SUM`, cast back to TEXT because money crosses IPC as a string.

**Not fixed, flagged:** `src/main/agent/proactive-trader.ts` and `src/main/event-bus.ts` are referenced only by their own tests. `proactive-trader` as written picks `activeStrategies[0]` regardless of session or symbol, hardcodes a $1000 buy and a ±5/10% stop/target, and ignores the strategy spec entirely — it evaluates no conditions despite its comment claiming to. It is harmless while unwired, and must not be wired to a candle stream in that state.

## The test suite was counting deleted tests (found 2026-08-01)

`npm test` runs the **compiled** suite (`dist/main/test/**/*.test.js`), and `tsc -b` never removes an output whose input was deleted. So deleting a test file left its `.js` behind and the runner kept executing it — silently, because a passing test looks identical whether or not its source still exists.

**It had already happened.** `event-bus.test.ts` and `proactive-trader.test.ts` were deleted as dead code on 2026-07-29 (commit `5360720`). Their compiled output survived, and every count reported afterwards — **including the "196 tests green" this file recorded** — included 5 tests from those two suites. `proactive-trader` is the file deleted *precisely because* a passing test over wrong logic certifies nonsense; it then went on certifying it for three days. Found when a `npm run clean` before a hand-off build dropped the count from 248 to 243 with no source change.

**This is the recurring bug class landing on the one mechanism whose job is to notice it** — a number trusted with more confidence than it earned, with nothing checking it. Same shape as the paper balance read from a column the SELECT omitted.

Fixed by `scripts/prune-orphan-tests.mjs`, wired into the `test` script: it deletes any compiled test with no corresponding source, and **says so on stdout** rather than pruning silently. It compares against source rather than wiping the directory because `tsc -b` is incremental — deleting outputs without invalidating `.tsbuildinfo` would leave the build believing they are current and emitting nothing. Verified by planting an orphan and watching it be pruned and excluded.

**The honest count is 243.** Any figure in this file dated before 2026-08-01 is inflated by 5.

## An armed plan is now actually watched (S3-3 watch-only, 2026-08-01)

**`plan-monitor.ts` was imported by nothing but its own test.** Every armed plan in the database read "armed" and no code path evaluated its trigger, invalidation, drift or expiry. Found the only way it could be: the owner armed a plan and went looking for what it was doing. A control that does not control, with the state label hiding it — the recurring bug class.

**The wire splits along the risk line, not the feature line: watching protects you, acting risks something.** Expiry, thesis invalidation and drift are evaluated on every closed bar and genuinely transition the plan. A trigger is **recorded with a null `position_id` and opens nothing**, because S1-2 has never proven the paper engine executes. A fired branch with no position is a real state, not a placeholder, and it is what lets S3-6 measure trigger rate before a single position has existed. `plan-watch.test.ts` asserts that boundary, so wiring entry without deliberately deleting the assertion fails.

- **A direct call from `paper-exchange.handleCandle`, never a second candle subscriber.** They share `session.paper_balance` and `EventEmitter` fan-out has no ordering guarantee — a plan monitor racing the paper engine on one bar could act while caps were still being checked.
- **`lastPlanBar` is keyed by plan row id, deliberately not by stream.** `lastEvaluatedBar` is keyed `symbol:interval` and is consumed by the first strategy on that stream. *(That is also a latent bug on the strategy side: a second strategy sharing a pair and interval never evaluates. Flagged, not fixed here.)*
- **Two defects surfaced the moment it ran, both invisible while the monitor was unreachable:**
  - **`compileIntent` emitted price conditions with no `field`.** `evaluateCondition` keys on `makeIndicatorKey(indicator, params, field)` and the engine only ever publishes field-qualified price keys (`price::close`). An unqualified condition builds `price:`, matches nothing, and reads **false for ever** — so every plan trigger and invalidation ever authored was incapable of being true, while the plan displayed as armed. Now `field: "close"`, which is also correct: plans evaluate on closed bars.
  - **`armPlan` did not reload the engine**, so a plan armed mid-session stayed unwatched until restart — the same "armed but nothing is looking" state in miniature.

## Detail views: plans and strategies open the same way (2026-08-01)

Owner request. `detail-modal.tsx` is the shared shell; `plan-detail.tsx` and `strategy-detail.tsx` are the contents. Opened from the plans list, the dashboard's plan panel and its armed-strategies rows.

- **The header states the kind** — "Plan" or "Strategy" — rather than implying it through styling. They are different objects with different rules (falsifiability vs. backtests) and a reader must never have to guess which is open.
- **Levels are labelled by the role they play**, not by what they are made of: trigger, entry, stop, target, invalidation. Those five format identically and mean opposite things, so the role carries the colour and the source ("POC (developing) · at arm") is secondary.
- **A strategy's protective levels are percentages, a plan's are prices** — a strategy repeats so its stop is a distance; a plan is one bet so its stop is a specific number. The sections differ where the objects differ.
- Neither view resolves a level. Derived levels show `resolvedAtArm` labelled as at-arm, same rule as `plan-watch-panel.tsx`.

## An armed plan on the chart is a view, not ink (J-3 geometric half, 2026-08-01)

The Research bookmark panel listed only **references** — the authoring layer, drawing → meaning — and the owner opened it looking for plans: *"shouldn't it list active plans, and when I click, add drawings based on the plan?"* Showing the ingredients above the thing they are for is backwards. The panel now leads with armed plans.

- **`renderer/lib/plan-overlay.ts`** draws a plan's trigger, entry, stop, targets and thesis invalidation as locked price lines, **labelled by role** with the same colours the detail views use.
- **Nothing is persisted to `chart_drawings`.** That answers "does the drawing reset if I turn it off?" — nothing was saved, so there is nothing to reset. Writing them would create a second definition of a level the plan already owns: stale the moment the plan changed, and outliving the plan if it were deleted. Same rule as candles, KLineChart and references — one definition, two consumers.
- **Derived levels draw at `resolvedAtArm`, labelled `at arm`.** That is the chart rendering a value main already committed to, not the chart computing its own — the distinction that made the fake CVD indicator wrong. A derived level with no `resolvedAtArm` belongs to a draft and is skipped rather than drawn at zero.
- **Indicators are removed on hide only if the overlay switched them on.** `addIndicatorByName` returns false when the indicator was already active, so the plan never claims — and therefore never removes — one the trader enabled themselves.
- **Symbol/interval changes clear the bookkeeping**: the drawings effect calls `chart.removeOverlay()` with no argument, wiping every overlay, so the panel would otherwise report plans as drawn when their lines were gone.
- Also fixed: the panel sat at `top: 8px`, directly over the chart's own OHLC legend, so its header read as part of the legend.

## Three owner-reported gaps closed (2026-08-01)

**Agent tools are a menu now** (`agent/tool-registry.ts`, `components/tools-menu.tsx`). The capabilities were a hardcoded array in `chat.ts` — invisible from the app and editable only in source, which is why the web-search fallback felt arbitrary. **Every tool is switchable, because nothing in the catalogue can cause harm**: no order tool, no arming tool, no `set_venue` tool, by construction. Two flags mark the switches with a real consequence — billed-per-use, and pulls untrusted outside text into a model holding write tools. A tool the *model* refuses shows as unavailable with the reason, never as an unchecked box. Stored as a **disabled** list, so a tool added later is on by default rather than silently missing for anyone who saved a preference first; read per request, so a toggle applies to the next message rather than the next restart.

**The monitor records when it was NOT watching** (`paper/monitor-heartbeat.ts`). A closed laptop watches nothing — obvious. What was not: the gap was **indistinguishable from a real answer**. A plan that never triggered because nobody was looking recorded identically to one that never triggered because price never came, and S3-6's calibration record measures exactly that. An unwatched window counted as a non-trigger flatters the owner's own hit rate with nothing that would notice — the paper-balance shape again. The gap is read at startup **before the first beat of the run** (the only moment the previous run's end is readable), audit-logged as `monitor_gap`, and shown on Home in caution colour. Threshold is three missed beats, not one; a first-ever run reports nothing. **This is the honest accounting of the app being closed, not a fix for it** — for an open position the answer remains the hard rule that every live position carries a venue-side stop.

**Settings › Integrations replaces Credentials** (`components/integrations-pane.tsx`). Venues have been a port with a registry and declared capabilities since S2-9, but Settings still showed one venue's key status. The page now states what is connected and **what it can actually do**, with the capability rows read from the adapter rather than asserted — so it currently says live trading is off and why. `CredentialsPanels` is embedded, not reimplemented: one implementation for anything writing a private key the venue already knows.

## A plan is reviewed against its thesis, not a spec (J-2, 2026-08-01)

`review.ts` declared `strategy_id: number` and called `getStrategy(pos.strategy_id)`. Schema v15 made ownership exclusive — a position belongs to a strategy **or** a plan branch — so the first plan-opened position would have closed and **never been reviewed**, silently, taking S3-6's only input with it.

- **`resolveOwner()` walks position → branch → plan** and returns the payload plus the prompt to judge it with. Exactly one owner exists; the database enforces it, and a position resolving to neither is logged and skipped rather than reviewed against nothing.
- **The prompt is split, not parameterised.** A strategy is a repeating rule judged against the spec it was meant to execute; a plan is a one-shot bet judged against **the assumptions it was authored on**. `REVIEW_SHARED_RULES` holds what is genuinely common (the arithmetic, the exit-reason rule, the did-price-move-or-did-the-level-move question) so those cannot drift; the two tails ask different questions because the questions *are* different.
- **The plan prompt enumerates all four right/wrong × profit/loss cases**, because the diagonals are the informative ones — especially *wrong thesis, profitable trade*, which is the case most likely to be misread as success. A reviewer left to its own devices scores the PnL and calls the assumptions vindicated, which is exactly the self-flattery the calibration record exists to prevent. It is also told the invalidation is not the stop: stopped out with the thesis intact is trade management, not a disproved thesis.
- **Schema v16 — `journal.ref_plan_id`.** The review *is* the record S3-6 derives from, so a plan's review has to be findable by plan; searching tag text would break on a shared word and orphan history on a rename. A plain `ALTER` (additive, nullable) rather than a rebuild, and **tested against a real on-disk v15 database** per the v15 lesson.
- `planTradeHistory` reports the honest empty set for a one-shot plan rather than borrowing another plan's trades to populate the field.

## The agent was still selling the frozen product (fixed 2026-08-01)

Asked to "paper trade the armed plan", the agent replied that order execution *"won't [exist] until a risk engine is built and tested (a later phase)"* and offered to **convert the plan into a strategy spec and backtest it** — the exact path the 2026-07-30 scope cut removed. It was answering correctly from a stale system prompt: `BASE_SYSTEM_PROMPT` never mentioned plans, and its capability section walked through `create_strategy` and the `DRAFT → … → LIVE_AUTO` ladder as the thing to do.

**A model that only knows the frozen product will keep recommending it**, however many times the docs say otherwise. Rewritten:

- **The agency model is stated as a design decision, not a missing feature** — the agent drafts, the owner signs, code executes; no capability it gains will ever include arming. The old wording implied arming was coming later.
- **"Paper trade this" now has a true answer.** An armed plan *is* monitored on every closed bar (expiry, invalidation and drift all act); what it does not do yet is open a position on a trigger. The agent is told to say that rather than to offer a strategy.
- **A plans section that states what a plan is** — thesis, assumptions, invalidation separate from the stop, hard expiry, own budget, OCO branches — and that **a plan is never backtested**, with the reason, so the agent stops offering to "formalise it as a strategy so we can validate it".
- **The strategy path is labelled frozen**, with the 90-backtest measurement included so the agent can explain the decision if asked rather than treating it as an arbitrary restriction.
- It also states plainly that it **cannot create or arm a plan** (no tool yet — that is J-1) and should say so, instead of substituting the nearest thing it can do.

## Web search 400s on models without programmatic tool calling (fixed 2026-08-01)

`claude-haiku-4-5` rejected the whole request: *"does not support programmatic tool calling. The following tools have `allowed_callers` that require it: web_search."* Recent `web_search` versions default to permitting the **code-execution** caller so the model can filter results in code before they reach context; that needs programmatic tool calling, which Haiku does not have.

The 400 named its own fix and it is the one taken: **`allowed_callers: ["direct"]` on the tool**. Set unconditionally rather than per model — `/v1/models` publishes no capability flag for this, the same reason `noWebSearch` exists, and the failure mode is a dead request rather than a missing feature. **The cost is real and accepted:** on models that do support it, results now arrive unfiltered and spend more context. Worth it for search that works on every model the owner might pick, including the cheap one the review agent runs on.

The `noWebSearch` degrade path stays as a genuine last resort, and now retries the turn automatically rather than asking the owner to resend.

## The agent can see the product now (J-1 awareness half, 2026-08-05)

**The agent had sixteen tools and not one of them could observe a plan.** `buildSessionContext` injected the pair, trade stats, journal and lessons — nothing about what was armed. That is the real reason "paper trade the armed plan" produced an answer about strategies: not missing vocabulary, **missing sight**. Yesterday's system-prompt fix taught it the words; this gives it eyes.

**Read before write, and the owner was right to reorder it.** Write tools without read tools are worse than neither — an agent that can author a plan but cannot list the ones already armed drafts a duplicate of the plan it cannot see.

- **`list_plans` / `get_plan` in `agent/tools.ts`** (new `PLAN_TOOLS` array, wired into `chat.ts` and the tools menu). Session-scoped like every other tool: `get_plan` refuses a plan belonging to another session, because reading across sessions lets an archived pair's context leak into a live conversation.
- **Read-only, structurally.** There is no `arm_plan`, `create_plan`, `update_plan` or `delete_plan`, and a test asserts the array contains exactly the two readers. A tool that does not exist cannot be reached by a jailbreak, an injected page, or a refactor that forgets a check — the same argument as `PlanState` having no `live_auto` member.
- **Armed plans go into the session context unprompted.** Tools alone do not fix blindness: a tool is only called when the model already suspects there is something to look at. `planned` and `triggered` both appear (a thesis can be disproved while its position is green).
- **Both surfaces state the execution boundary in words**, because "armed" alone left the model to infer execution and it inferred wrong: expiry, invalidation and drift act; a triggered branch records and opens nothing; only the owner can arm.
- **Derived levels report `resolvedAtArm` labelled as the value at arming**, never as live. The renderer's rule applies to the model too — it is a reader, and a stale number presented as current is how a reader concludes the wrong thing. Resolving live in the tool would also be a second definition of a value the resolver owns.

**Write half landed the same day (J-1 complete).** `create_level_reference`, `list_level_references`, `draft_plan`, plus two tools that closed the remaining blind spots.

- **`draft_plan` saves as `draft` and can never arm.** The guarding test pins the **invariant, not the tool list**: no `arm_plan`, `update_plan`, `delete_plan`, `transition_plan`, `set_venue` or `place_order` may ever appear, so the guarantee survives additions. A second test arms an agent-authored draft through the owner's own path — a tool producing plans that look real and cannot run would be worse than no tool.
- **`create_level_reference` makes static levels only.** A derived level carries a window, a drift tolerance and an `onDrift` policy that decide whether an armed plan keeps trading as the level moves — real money behind them, and not choices to infer from a sentence in chat. Those stay a promotion from a drawing on Research, where the window is visible.
- **Found while building it: a plan cannot be stored without a thesis invalidation.** `createPlan` compiles conditions up front and refuses a non-numeric one rather than storing an empty group (the S2-8 fix — an empty group later reads as a *missing* invalidation, three steps from its cause). So `draft_plan` requires it and **refuses with the distinction spelled out**: a stop is where the trade is wrong, an invalidation is where the thesis is. A storage constraint became the question the gate exists to force.
- **`get_order_flow`** — CVD and the volume profile. The app has computed both since S1-4 and the agent could see neither, despite §17 existing so a thesis could be written in that vocabulary. Carries the two honesty rules with it: CVD coverage below 100% is *unknown*, not flat; the profile is candle-derived and approximate.
- **`get_app_capabilities`** — read from the venue adapter, never asserted. The agent had no way to check what the app can actually do and would otherwise answer from assumption; assuming a position is protected when it is not is the most expensive thing it could get wrong.

## One object: the trading plan (owner decision, 2026-08-05)

**The scope cut froze the strategy path in July; it never left the screen.** Workbench sat in the rail, the agent held `create_strategy` / `run_backtest`, the dashboard showed "Armed strategies", and the prompt carried the `DRAFT → … → LIVE_AUTO` ladder with a note saying not to use it. So the app still presented **two answers to the same question**, and both the owner and the agent kept reaching for the wrong one. The owner's words: *"telling the agent to build a strategy is asking a horse to win the race without a rider, and it keeps on just wasting tokens and backtesting generic strategies."*

That is correct and the measurement already said so — 90 backtests, one clearing the gate at +0.03%. The agent draws from that same distribution; the tokens buy a re-derivation of a known-negative result. **A soft guard (the prompt) against a hard affordance (the tool) loses.**

**Deleted from every surface:** the Workbench page, `strategy-detail.tsx`, `paper-comparison-card.tsx`, the "Armed strategies" dashboard panel, the rail entry and its badge (now counts *watched plans*), the `workbench` surface id, and the agent's `create_strategy` / `run_backtest` / `list_strategies` tools plus their implementations and registry entries. The system prompt now states there is one object and that proposing a generic indicator strategy is a **known-negative action**, with the measurement, so the model can explain the rule rather than treat it as arbitrary.

**The engine code stays frozen and untouched** — fill model, condition evaluator, level resolver, paper engine, risk engine, `strategy-service`, `backtest-service`. They are shared with the plan path and ripping them out before launch is churn with real regression risk. What was removed is the *second object on screen*, not the machinery.

**Fixed on the way past:** `draft_plan` and `create_level_reference` shipped earlier the same day **with no `data:updated` broadcast**, so the Plans page would have kept showing the list from before the agent wrote to it. The rule is in this file — *if you add a tool that writes to the DB, add its broadcast too* — and it was still broken within hours of being restated. Both now broadcast, and the Plans page subscribes.

## The first position this app has ever opened (S1-2, 2026-08-05)

`paper_positions` had **zero rows** in this project's life. The plan monitor
deliberately recorded triggers that opened nothing, with a test asserting that
boundary; it failed on the first run of this change, which is what it was for.

Entry goes through `persistEntry` (owner-agnostic since v15) and `closePosition`
became owner-agnostic the same way — the owner decides which foreign key the
exit order carries, which map is cleared and what the log says, **nothing else**.
The fill model, fee and balance arithmetic stay the backtester's.

**Where a plan differs from a strategy is where it differs by design, not by
convenience:**

- **A plan's stop does not ratchet.** `checkProtectiveLevels` now takes an
  **optional** `spec`, and its absence means a plan owns the position. A strategy
  repeats, so its stop is a *distance* and breakeven/trailing are part of the
  rule being tested. A plan is one bet and its stop is a price the owner signed;
  moving it would be trading a geometry they never approved.
- **The fill is the bar's close with the usual slippage, never the approved entry
  level.** If price gapped through the level, filling there would invent a price
  the market never offered — refusing that is the fill model's whole job. The
  divergence from the approved entry is recorded in the audit instead.
- **Size is the plan's own absolute budget × the branch share**, never a
  percentage of balance, with the fee taken *out* of the budget rather than on
  top. A plan cannot spend more than the figure it was authored with.
- **Two entries are refused, both derived from the owner's own numbers** rather
  than an invented tolerance: at or below the branch's stop (a trade already
  dead), at or above its target (paying for a move that has happened). The branch
  is still recorded as **triggered** — a trigger that fired and could not be
  acted on is a different fact from one that never fired, and S3-6 has to keep
  them apart.
- **A plan whose last position closes and which has nothing left to fire moves to
  `closed`.** With OCO off, pending branches keep it alive.

**Two defects fixed on the way past, both invisible until a plan could own a
position:**

- **`closePositionForShutdown` read `strategies` unconditionally** and bailed
  when the lookup missed. The archive wind-down would have silently declined to
  close a plan position — leaving an archived session holding a live position
  with nothing checking its stop, which is the exact state archiving is refused
  for.
- **The dashboard's open-positions table would have shown an empty owner.** The
  plan is the only thing that explains why the position exists, so
  `positions-service` joins both owners and the column says "Opened by".

**`emit()` in `events/outbound` now returns quietly when there is no window
layer.** These are notifications that something already happened; a failure there
must never abort a write that had every right to succeed. Plan transitions and
closes now broadcast `data:updated` — without it the Plans page and the watch
panel keep showing "planned" after a trigger.

**Still unproven:** all of this has run against seeded bars, never the live
stream. The remaining question is a real armed plan on a real feed.

## Simulated and live are app modes, not per-plan flags (owner decision, 2026-08-05)

Proposed as per-plan; the owner improved on it and the improvement is real. A per-plan flag means the app holds a **mixture** at all times, and every list, aggregate, badge and notification has to carry the distinction correctly forever — the ambiguous-state failure the design rules already forbid, enforced in fifty places instead of one.

**App-level mode makes it structural.** In simulated mode the venue registry returns a paper adapter: `canPlaceOrders: false`, no credentials needed, no signing path — there is physically no route to a real order. Same class of guarantee as `PlanState` having no `live_auto` member: an absence, not a defence.

Design decided, **not yet built**:

- **Two database files, not a `mode` column.** A column is the `source = 'binance'` problem again — 18 predicates, and the one you forget blends silently rather than failing. Separate files make cross-mode contamination unwriteable.
- **Simulated is the default and needs no credentials.** Live requires explicit entry, credentials, Windows Hello, and an unmissable mode marker in the titlebar and toolbar.
- **Lessons cross modes; the calibration record does not** (owner decision). What you learned about how a range reclaim behaves is market knowledge and transfers. A hit rate must never blend simulated fills with real ones — simulated fills are optimistic by construction, and a blended record flatters the owner with nothing that would notice. So distilled lessons live in a small shared store both modes open; sessions, plans, positions and the calibration record stay inside their own mode's database.
- **No promotion ladder.** Each plan is armed simulated or real — one decision at arm time. Simulation exists so a broken monitor is found without cost, not as a probation period.

---

## Going public (2026-10-31) — the kill switch that threw, and four more

The first run by a second pair of eyes, on the day the repo went public. Every one
of these had a green suite and a clean typecheck.

**The kill switch threw (and so did the unlock).** Splitting `ipc.ts` into
`ipc/` (2026-08-05) moved handlers one directory deeper, and ten lazy `require()`
calls kept their old relative paths — `./main`, `./risk/kill-switch`,
`./db/database`. TypeScript does not check `require` strings, and no test executed
those handlers, so `killSwitch:trip`, `reset` and `status`, the Windows Hello
unlock, the window controls, showing the browser and two database reads all threw
"Cannot find module" at runtime and surfaced as "Something went wrong". Found
because the maintainer was locked out of the app. **The kill switch displayed as
working and did nothing — the same shape as the 2026-07-29 bug sweep.**
`lazy-require-paths.test.ts` now resolves every relative lazy `require`/`import`
under `src/main` and `src/preload`; it fails on the old code with all ten listed.

**A rejected key looked like loading.** `getAnthropicModels` swallowed the error
and returned `[]`, and the picker rendered an empty list as "Loading models…" —
for ever, while chat silently fell back to a hard-coded, most-expensive model.
The picker now uses a throwing lister, so a 401 crosses `safe()` as CREDENTIALS
with a Retry; saving the key broadcasts `credentials` and the panel reloads. The
error copy had also pointed at "Settings › Credentials", which no longer exists.

**A presence check that threw.** The basis monitor guarded with
`if (!credentials.getApiKey()) return;` — but the getter throws when no key is
saved, so the guard *was* the crash: an unhandled rejection on every fresh install.
It also decrypted the key once a minute to answer a yes/no question. Now
`hasApiKey()`.

**A race only CI could see.** Electron 43 stopped downloading its binary at
install; the first `require("electron")` fetches it. `node --test` runs files in
parallel, so on a fresh runner several processes extracted into the same
directory and one failed with "File exists" — a random test, on a random OS.
Reproduced (4 of 6 parallel requires failed), then fixed by
`scripts/ensure-electron.mjs` before the suite runs (6 of 6).

**The vault went async before Electron 46 removes the sync API.** Moving
`safeStorage` to its async methods found the trap the compiler cannot: an
un-awaited key in `if (!key)` is a Promise, always truthy, and an un-awaited save
reports success first — `setup:saveAnthropicApiKey` would have told the chat panel
to reload with the key being replaced. Every call site was audited, not just the
ones TypeScript flagged; the main vault got its first tests (mutation-checked);
and `CLAUDE.md` now carries the rule.

## Which session am I in? (2026-10-31) — "idle" plans, a borrowed chat, and a quit box

Three defects of one shape, found in one evening by looking at the UI rather
than the code: **the screen answered a question about state with a value from
somewhere else.**

**"Armed" counted strategies.** Home and Portfolio read the armed count from the
`strategies` table, frozen since 30 July, so it was always 0. A session with two
armed plans and an open position was badged **IDLE**, and Home said "0 armed
strategies" — the armed-vs-idle ambiguity, in the direction that hides risk. It
now counts plans in `planned`, and the card says *in position*, *armed*, both, or
*idle* — never idle while either exists. The same pass found "nothing open" on
Portfolio inferred from zero unrealised P&L, so an unpriced position read as
nothing open beside a Cash cell saying the opposite; and a titlebar version
hard-coded to "0.1.0" on an alpha.5 build.

**The agent borrowed the last session's chat.** The selection was persisted and
restored, so the app opened on Home with the agent drawer showing a pair's
conversation; going back to Home or Portfolio from a session kept it there too.
Now the selection is cleared at launch, a session's chat lives only on its own
surfaces, and everything else talks to the **global agent** — its own history,
its own context, and only the tools that need no session (a session tool called
from it would have written a journal row against session 0). Chat events gained a
conversation id on the way: a reply streaming across a session switch had been
landing in the next session's transcript. Design: `ARCHITECTURE.md` §12.

**The quit box was true of no phase.** The native dialog said *"In later phases,
open positions will remain on the exchange…"* — on a build where nothing reaches
an exchange and an armed plan simply stops being watched. It is now the app's own
dialog and says what actually stops, with counts read at the moment of asking;
unreadable counts say so rather than "nothing". **A themed dialog that fails to
appear would be a close button that does nothing**, so main falls back to the
native box when the renderer is loading, crashed, or silent for 1.5 s, and the
dialog acknowledges only after it has rendered.

