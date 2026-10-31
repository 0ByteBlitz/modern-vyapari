# CLAUDE.md — Modern Vyapari

Guidance for AI coding agents (Claude Code and others) and a fast orientation for
human contributors. Read this file first; it is deliberately rules, not history.

**Modern Vyapari** is an Electron + TypeScript desktop app: an AI trading partner
for spot crypto. **The user authors a thesis; the agent monitors it and acts on
it.** The agent drafts, the user signs, deterministic code executes.

## Read in this order

1. **`docs/JOURNEYS.md`** — the seven end-to-end journeys the app serves. A change
   should name the journey and the step it lands on. The spine is **J3 — "the plan
   executes without me"**: the problem the app solves is *not sticking to a plan*,
   so it removes the user from the moment of temptation rather than disciplining
   them at it.
2. **`docs/ARCHITECTURE.md`** — the layers, the integration seam (venue + feed),
   and what runs when nobody is typing. Read it before touching a venue, a data
   feed, or adding anything that wakes on a timer.
3. **`docs/ROADMAP.md`** — what is built, what is frozen, and why.
4. **`docs/DECISIONS.md`** / **`docs/DESIGN-NOTES.md`** — the incident behind each
   rule below. **Read the relevant entry before deciding a rule does not apply to
   you** — every one exists because something expensive happened.

`docs/PLAN.md` is the original design; half of it is frozen — read its header first.

## Hard rules — do not violate

These are enforced by structure and tests, and a PR that weakens one will not be merged.

- **AI proposes, code executes.** No AI call may ever be in the order-execution
  path. Orders go `OrderIntent → Risk Engine (pure code) → Execution Engine (pure code)`.
- **The agent has no order, arming or venue tool.** It may research, create level
  references and *draft* plans. It may never arm a plan, place/modify/cancel an
  order, or choose the venue. Those tools do not exist, and a test asserts they
  never appear. A tool that does not exist cannot be reached by a jailbreak, an
  injected web page, or a refactor that forgets a check.
- **The signature is given at arming, not at the fill.** A trigger executes terms
  already signed. The approvals queue is for plans that *cannot* execute as
  signed (drift, refused geometry, risk rejection) — not for confirming fills.
- **Secrets stay in the main process.** Ed25519 private key, venue/Anthropic/
  Browserbase/Telegram keys: never across IPC, never in logs, prompts, the DB,
  or error messages. Credential state crosses IPC as booleans only.
- **Renderer stays sandboxed:** `contextIsolation` on, `nodeIntegration` off, CSP
  `default-src 'self'`, all main-process access through the typed preload bridge.
- **Web content is untrusted and is never a trigger source.** Fetched pages are
  wrapped as `untrusted_web_content`; instructions inside them are never followed.
- **One feed per purpose, never mixed inside one computation.** Binance (public
  data) is the *analysis* feed — charts, indicators, paper fills, triggers — via
  `src/main/data/analysis-candles.ts`. The venue is *execution and
  reconciliation truth*. No FX conversion anywhere; analysis is USD-quote only.
- **Every live position carries a venue-side TP/SL.** The exchange is the source
  of truth; reconcile on startup and start **paused**. Never auto-resume.
- **Money is a string end-to-end.** No float arithmetic on prices or quantities.
- **No vendor lock-in.** The venue, the analysis feed and the AI provider each sit
  behind a port (`integrations/venue/`, `integrations/feed/`, `ai/`). Vendor SDKs and
  clients are imported **only** inside their adapter folder — `vendor-boundary.test.ts`
  enforces it for AI SDKs. Adapters declare capabilities honestly; features degrade
  by capability, never by checking a vendor's name. Setup and UI copy never assume one
  vendor.
- **No state may be ambiguous** — live vs. paper, armed vs. idle, up vs. down.
  This outranks every preference, including theming.

The full safety checklist for order-adjacent code is the
`.claude/skills/trading-safety` skill. Revolut X API details are in
`.claude/skills/revx-api`.

## Working on this repo

- **Verify before reporting.** Run `npm run typecheck` and `npm test` and read the
  output. "Typecheck clean, tests green" must mean you ran them. If a command
  fails, show the output and say so. Never describe expected output as observed.
- **Ask a human first** for: anything that could touch a real exchange account
  (placing, cancelling or amending orders, or a script that could); reading or
  printing credentials (`credentials/`, `*.pem`, `*.key*`, encrypted stores —
  never echo a secret to a terminal); deleting a user's SQLite DB or `userData`;
  anything that leaves the machine (push, publish, posting).
- **Tests:** the suite runs on Node's native runner with no network. New
  logic in `plans/`, `risk/`, `paper/`, `insights/` or `integrations/` should come
  with a test. **A test that certifies nonsense is worse than no test** — don't add
  coverage for logic that is itself wrong. Tests must never hit the network
  (`test-helper` flips the network guard).
- **Dependencies:** prefer zero-dependency solutions (see `node:sqlite` over
  `better-sqlite3`, raw CDP over Puppeteer). A dependency proposal names the
  zero-dep alternative it rejected and why.
- **Keep diffs scoped.** Do the asked-for work; raise unrelated ideas separately.
  Behaviour and the docs describing it change in the same PR.
- **Deletion counts as an improvement**, and is usually the better one.

### The bug class to hunt

*A value or a control presented with more confidence than it earned, with nothing
that would notice if it went wrong.* Past instances: a paper balance read from a
column the SELECT omitted; FX-contaminated candles; alerts built but never
evaluated; a kill switch wired to a button and read by nothing. Finding another
outranks almost any feature.

## Tech conventions

- TypeScript strict. Main + preload: `tsc -b tsconfig.node.json` (composite —
  always `-b`, never `-p`), CommonJS. Renderer: Vite + React + Tailwind v4 + shadcn/ui.
- **IPC contract types live in `src/shared/ipc-types.ts`** — one definition, both
  sides. `src/shared/` compiles into both bundles, so it imports nothing.
- **A channel and its preload method are added together.**
  `test/ipc-surface.test.ts` fails otherwise, in both directions.
- **Any DB write from a tool or engine path broadcasts `data:updated`**, or the
  UI silently shows stale data.
- **Any new main→renderer channel sanitises errors** — use `emitError`; raw API
  errors must never reach the transcript.
- **The renderer describes, main constructs.** Never build engine JSON in the renderer.
- **The credential vault is async** (`security/credentials.ts` and
  `integration-secrets.ts`, both through `security/cipher.ts`). Await every read
  and save: an un-awaited key in `if (!key)` is a Promise, always truthy, and
  TypeScript will not flag it; an un-awaited save reports success before the
  write. Presence checks (`has*`) are synchronous and decrypt nothing — use them
  to ask *whether* a key exists, never a getter.
- DB: `node:sqlite` (`DatabaseSync`), WAL, FTS5 for journal search. Schema in
  `src/main/db/schema.ts` (**v20**), hand-rolled migrations in `db/database.ts`.
- **`SCHEMA_SQL` re-runs on every startup**, including against an old database.
  An index on a column introduced by a migration belongs in the migration block.
  Test migrations against a real on-disk DB of the previous version.
- Timestamps are ms epoch; display in local time.
- Verify KLineChart overlay names against `node_modules/klinecharts/dist/index.esm.js`
  — the library fails silently on unknown names.
- **No comment keys inside `package.json`'s `build`** — `electronFuses` is
  `additionalProperties: false`; one stray key fails packaging with a misleading error.
- Custom titlebar uses `titleBarStyle: "hidden"` + `titleBarOverlay` — **do not
  add `frame: false`**, it kills the overlay buttons on Windows.
- **UI copy says what is true and what to do.** Reasoning lives in code comments
  and `docs/`. Errors: what is wrong, then what to do, in one sentence. Labels are
  nouns. No roadmap or internal vocabulary in user-facing strings. Refusals are
  rendered, never swallowed, and refuse *differently* — tests pin the distinction,
  not the phrasing.

## Map of the code

| Area | Where | Notes |
|---|---|---|
| Entry | `src/main/main.ts` | Hardening: navigation/window-open guards, permission handler denies all |
| IPC | `src/main/ipc/` | One module per domain; `index.ts` registers; `safe.ts` is the internal↔user boundary |
| Preload | `src/preload/preload.ts` | The bridge — separate trust boundary |
| Plans (the product) | `src/main/plans/` | `trade-plan.ts` (falsifiability gate), `plan-service.ts` (arming), `plan-monitor.ts` (per-bar decision), `level-reference.ts` |
| Insights | `src/main/insights/` | 24 indicators, volume profile, anchored VWAP/CVD, level resolver |
| Data feeds | `src/main/data/` | Binance analysis feed, derivatives (Binance + Hyperliquid), basis monitor |
| Venue seam | `src/main/integrations/venue/` | Port, adapters (`revolutx`, `paper`), registry, declared capabilities, `isConfigured()` |
| AI provider seam | `src/main/ai/` | `port.ts`, `registry.ts`, `anthropic.ts` — the only place a model vendor's SDK is imported |
| Paper engine | `src/main/paper/` | Backtester's fill model against the live stream; protective levels intrabar |
| Agent | `src/main/agent/` | `chat.ts` (provider-neutral agent loop), `tools.ts` + `tool-registry.ts`, `context.ts`, `review.ts` |
| Risk | `src/main/risk/` | Pure 8-gate `risk-engine.ts`; `kill-switch.ts` blocks entries, never exits |
| Security | `src/main/security/` | `safeStorage` credential vault, Windows Hello gate |
| Notifications | `src/main/notify/` | Transactional outbox → Telegram |
| Renderer | `src/renderer/` | `components/pages/` = surfaces only; `components/ui/` = shadcn; `lib/` = hooks/api |
| Frozen | `src/main/strategy/`, `src/main/backtest/` | Kept because plans share the evaluator, fill model and risk engine. **Do not build on them.** |

**Not built yet:** live order placement, venue-side protective orders, startup
reconciliation, the approvals queue. `risk/order-pipeline.ts` and `exchange/*`
are scaffolding, unreferenced on purpose, and fail loudly rather than faking success.

Layering contract (the sandbox depends on it): no renderer/preload file imports
from `src/main/`; no main file imports from the renderer; `src/shared/` imports nothing.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Build and launch (dev, unpackaged) |
| `npm run build` | Build main + preload and renderer |
| `npm test` | Build main, prune orphaned compiled tests, run the suite |
| `npm run typecheck` | Typecheck all projects |
| `npm run package:win` | Windows NSIS installer (unsigned) |
| `npm run inspect-db` | Read-only look at the local SQLite DB |
