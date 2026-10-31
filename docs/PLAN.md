# AI Crypto Trading Bot — Architecture & Build Plan

Personal-use Electron app · Revolut X · Spot only · Approval-first autonomy · Claude Agent SDK

> **Public readers:** this was written as a single-user plan. "Owner" means the
> person using the app; current status is the top of `docs/ROADMAP.md`.
>
> **Read this before the rest of the file.** This is the original architecture
> plan (July 2026) and it is still the reference for how the system is built —
> the risk engine, the security model, the data-feed roles, the session model
> and **§17, the scenario-plan design**, all remain current.
>
> **Two parts of it are frozen and must not be built on** (owner decision,
> 2026-07-30; see `docs/ROADMAP.md` §1 and §5):
>
> - **§6 Strategy Lifecycle** — spec authoring, backtesting, the
>   `DRAFT → … → LIVE_AUTO` ladder, auto-strategies. Frozen after 90 backtests
>   produced one that cleared the gate, at +0.03%. Frozen rather than deleted
>   because the fill model, condition evaluator, level resolver, paper engine
>   and risk engine are shared with the plan path.
> - **§10's promotion framing** — a plan is never backtested. What it earns
>   instead is falsifiability (§17).
>
> **The product is one object: the trading plan.** The owner authors a thesis;
> the agent monitors it and acts on it. `docs/JOURNEYS.md` is where a change
> should find the journey and step it serves; `docs/ROADMAP.md` is the live
> plan. Surfaces described here as "Workbench" no longer exist.
>
> This file is **not being retrofitted wholesale** — sections are corrected as
> they are touched. Where it disagrees with ROADMAP or JOURNEYS, those win.

---

## 1. Core Design Principle

**The AI never touches money directly.** Claude analyzes, proposes, and explains. A deterministic, non-AI execution engine validates every order against hard-coded risk rules and places it. This separation is the single most important safety decision in the whole design:

```
Claude (analysis/strategy)  →  proposes OrderIntent (JSON)
Risk Engine (pure code)     →  validates against limits, rejects or passes
Execution Engine (pure code)→  signs & submits to Revolut X, records result
```

If Claude hallucinates a price, misreads a chart, or gets prompt-injected by web content, the risk engine still blocks anything outside your configured limits.

---

## 2. Platform Constraints (researched, verified July 2026)

| Constraint | Implication |
|---|---|
| Revolut X REST API only — **no WebSocket** | Venue data via polling. Analysis uses the Binance WS feed (§9); Revolut X is the execution venue. |
| **Exchange-side TP/SL + conditional orders supported** (confirmed in API docs) | Stops can live at the venue → protection survives local crashes/offline periods. Use for every position. |
| **Rate limit: 1,000 limit orders/day** | Fine for swing/DCA; constrains dense grid strategies and aggressive order replacement. Risk engine tracks a daily order budget. |
| `client_order_id` (UUID) on placement; replace-order endpoint; `post_only`/`allow_taker` instructions; GTC time-in-force | Native idempotency for duplicate suppression; order amendment without cancel-recreate. |
| Market orders by base or quote size; per-pair min/max sizes + step sizes in `/configuration/pairs` | Sizing validation must respect venue steps/mins — fetch config at startup. |
| **No testnet/sandbox for Revolut X** | Paper trading must be a locally simulated exchange (fill simulation against live data). |
| Ed25519 request signing (`timestamp+method+path+query+body`) | Private key on disk (`chmod 600`); reuse Revolut's open-source signing code (MIT `api/` package — embed it, don't rewrite). |
| Candles: minute-based intervals, `since`/`until` (ms); order book snapshot up to configurable depth | Candle cache + depth snapshots for the execution venue side. |
| Endpoint: `https://revx.revolut.com` only | Firewall the app's network access to this + Anthropic API + analysis data feed. |
| API reference | https://developer.revolut.com/docs/api/revolut-x-crypto-exchange · Security policy: https://github.com/revolut-engineering/revolut-x-api/blob/master/SECURITY.md |

---

## 3. High-Level Architecture

```
┌─────────────────────────── Electron App ───────────────────────────┐
│                                                                    │
│  Renderer (UI)                     Main Process (Node)             │
│  ┌──────────────────┐   IPC   ┌──────────────────────────────┐     │
│  │ Chat interface   │◄───────►│ Session Manager              │     │
│  │ Charts (TV/light-│         │ Agent Runtime (Claude SDK)   │     │
│  │  weight-charts)  │         │ Strategy Engine              │     │
│  │ Session switcher │         │ Risk Engine   ◄─ hard limits │     │
│  │ Trade journal    │         │ Execution Engine ─► RevX API │     │
│  │ Approval dialogs │         │ Data Layer (Binance WS +     │     │
│  │ Memory browser   │         │  RevX REST) + Insights Engine│     │
│  │ Backtest reports │         │ Backtester / Paper Exchange  │     │
│  └──────────────────┘         │ Memory Store (SQLite)        │     │
│  ┌──────────────────┐         └──────────────────────────────┘     │
│  │ BrowserView      │                                              │
│  │ (research tabs)  │                                              │
│  └──────────────────┘                                              │
└────────────────────────────────────────────────────────────────────┘
```

**Tech stack:** Electron + TypeScript, React + Tailwind v4 + shadcn (renderer), `node:sqlite` (`DatabaseSync`, storage — zero native deps, chosen over `better-sqlite3` to avoid native builds on Windows), **KLineChart** (charting — Apache-2.0, zero deps; replaced `lightweight-charts`, see §9), a custom Revolut X client with Ed25519 request signing (exchange), `@anthropic-ai/sdk` with a hand-rolled agentic tool-call loop (AI runtime — not the higher-level Claude Agent SDK). IPC payload types are defined once in `src/shared/ipc-types.ts` and imported by both processes.

**Schema versions:** v6 `paper_positions` · v7 `basis_samples` · v8 purge of FX-contaminated candles · v9 `chart_drawings`. Migrations are hand-rolled in `database.ts`.

**Process placement:** everything with money or keys lives in the **main process**. The renderer only displays state and sends user intent over typed IPC. `contextIsolation: true`, `nodeIntegration: false`, keys never cross IPC.

### 3.1 UI — Must-Have Surfaces

> **Superseded by the 2026-07-28 redesign — see §14.** The seven surfaces below are still the right *content*; what changed is the navigation model. The app is now **session-first**: each session in the left rail expands to its own surfaces (Dashboard / Orders / Workbench / Journal / Research / Alerts), and cross-session surfaces (Portfolio, Markets, Research browser, Approvals & safety, Settings) sit in the rail footer. The original model had global nav tabs plus an invisible "active session" mode, which meant you could never tell which session a screen belonged to. The agent can also drive this navigation itself (§14), so you see the surface it's working on.

Seven core surfaces. Layout: left rail for session switching, tabbed center stage, chat dockable right.

1. **Session selector** — left rail: create/open/pause/archive pair sessions; per-session status badge (paper / supervised / auto / paused) and today's PnL at a glance.
2. **Chat interface** — dockable panel, always available in any tab: strategy discussion, snapshot paste (TV images add context here), approval prompts for supervised orders, inline backtest/analysis results.
3. **Integrated browser** — center-stage tab: TradingView (persistent login) + research tabs. Human-only surface; a "Snapshot to chat" affordance reminds you it feeds the bot via *you*.
4. **Bot working area** — center-stage tab, the bot's "glass cockpit": live strategy state (which specs are armed, last evaluation, next scheduled check), pending OrderIntents with reasoning, active alerts from the insights engine, in-app charts (own data, volume/depth), running backtests with progress. This is where you watch the bot think.
5. **Dashboard** — per-session and portfolio views: equity curve, PnL (realized/unrealized, fee-adjusted), win rate, max drawdown, exposure vs. risk limits, paper-vs-live comparison per strategy, Claude API spend.
6. **Trading journal** — chronological feed merging structured trades with AI journal entries and your own notes; filterable by strategy/tag/outcome; each closed trade links its post-trade review.
7. **Memory browser** — view/search what the bot knows per session: distilled lessons doc (editable — you can correct a wrong lesson), journal search, stored snapshot analyses. Transparency surface: nothing the bot "remembers" is hidden from you.

---

## 4. Session Model (per trading pair)

A session = one pair (e.g., `BTC-USD`) + its complete isolated context.

```
Session
├── pair, created_at, status (active/paused/archived)
├── strategies[]        — versioned strategy specs for this pair
├── trades[]            — every execution with full context snapshot
├── memories[]          — AI-written notes, lessons, observations
├── backtests[]         — results with parameters + data range
├── analytics           — pair-specific stats (win rate, PnL, drawdown)
└── risk_config         — per-pair limits (subset of global limits)
```

Rules:

- Opening a session loads only that pair's context into Claude's prompt. No cross-pair bleed.
- Global config (total capital limits, kill switch, API keys) lives outside sessions.
- One optional **portfolio view** aggregates read-only across sessions — but strategy reasoning always happens inside a session.

---

## 5. Memory Design

Three layers, all in SQLite per session:

1. **Structured facts (tables)** — trades, orders, fills, backtest runs, strategy versions, daily PnL snapshots. Queryable, exact, never summarized away. This is the ground truth.
2. **Journal (append-only)** — AI-written entries at defined moments: after each closed trade ("what was the thesis, what happened, deviation from plan"), after each backtest, after each strategy discussion. Each entry tagged (strategy_id, trade_id, outcome, tags like `stop-too-tight`, `news-event`).
3. **Distilled lessons (curated)** — periodically (weekly or every N trades), an agent run compresses the journal into a short "lessons for this pair" document (~1–2k tokens). This is what gets injected into every conversation, plus recent journal entries on demand.

**Retrieval:** lessons doc always in context; structured facts via SQL tools Claude can call; journal via keyword/tag search tool (full-text search in SQLite FTS5 — no vector DB needed at personal scale).

**Post-trade review loop (the part most bots skip):** when a position closes, automatically trigger an agent run: compare execution vs. strategy spec, record slippage, note whether stop/target logic behaved as intended, write journal entry. This is how the bot "learns what went wrong."

---

## 6. Strategy Lifecycle

Strategies are **formal JSON specs**, not prose. Claude discusses in natural language, then compiles the agreement into a spec the deterministic engine can run.

**Delivered** (`src/main/strategy/strategy-spec.ts`) — the actual shape, refined during Phase 2 build-out from the sketch below into fully nestable AND/OR condition groups (needed for real strategies like "RSI < 30 AND volume above its 20-bar average"):

```json
{
  "id": "btc-rsi-dip",
  "pair": "BTC-USD",
  "type": "signal",
  "entry": {
    "logic": "and",
    "conditions": [
      { "indicator": "rsi", "params": { "period": 14 }, "operator": "below", "value": 30 }
    ]
  },
  "exit": {
    "logic": "or",
    "conditions": [
      { "indicator": "rsi", "params": { "period": 14 }, "operator": "above", "value": 70 }
    ]
  },
  "sizing": { "mode": "fixed_quote", "amount": 100 },
  "schedule": { "eval_interval": "5m" },
  "risk": { "max_open_positions": 2, "max_daily_trades": 6, "stop_loss_pct": 2, "take_profit_pct": 4 }
}
```

Each `Condition`: `{ indicator, params, field? (for multi-output indicators like MACD), operator (above/below/crosses_above/crosses_below/between), value }`. `indicator: "price"` or `"volume"` read raw candle fields instead of a computed indicator. `ConditionGroup`s nest arbitrarily via `{ logic: "and"|"or", conditions: [...] }`.

Lifecycle with graduation gates:

```
DRAFT ──backtest──► BACKTESTED ──paper──► PAPER ──your approval──► LIVE-SUPERVISED ──earned──► LIVE-AUTO
```

- **Backtest gate (delivered):** the backtester warns below 90 days of data and below 30 trades (plan minimums), and flags overfitting when in-sample return diverges sharply from out-of-sample — but these are warnings surfaced in the report for you/Claude to weigh, not a hard block on the DRAFT→BACKTESTED transition. `run_backtest` auto-advances a DRAFT strategy to BACKTESTED once it has completed and produced at least one trade.
- **Paper gate:** minimum 2 weeks or 20 trades on the local paper exchange with live data. *(Not yet built — Phase 3.)*
- **Live-supervised:** every order shown to you for approval in the chat UI with the reasoning attached. Orders auto-expire if unapproved in N minutes. *(Not yet built — Phase 4.)*
- **Live-auto:** earned per-strategy after M supervised approvals with no interventions; still bounded by the risk engine; any manual intervention demotes it back to supervised. *(Not yet built — Phase 4/5.)*

Strategy specs are versioned; edits create a new version that restarts at DRAFT (delivered — `updateStrategy()` in `strategy-service.ts`).

---

## 7. Risk Engine (non-negotiable, pure code)

Checked on **every** order, no AI involvement, config changes require typing a confirmation phrase in the UI:

- Max % of total capital per pair (e.g., 20%)
- Max position size per order (quote currency)
- Max daily loss per pair and global → auto-pause session on breach
- Max daily trade count (runaway-loop protection) + daily order budget against the venue's 1,000 limit-orders/day cap
- Every position must carry a venue-side TP/SL order (verified before the entry is considered complete)
- Price sanity: order price within X% of current mid (fat-finger/hallucination guard)
- Balance check before submit; duplicate-order suppression (idempotency keys)
- **Global kill switch:** one button → cancel all open orders, pause all strategies, no new orders until manually re-armed
- Auto-pause triggers: API errors > threshold, stale market data (> 2 polling intervals), app crash recovery (restart always resumes in PAUSED state — never auto-resume trading after a crash)
- **Startup reconciliation:** on every launch, fetch open orders + balances from the exchange and diff against local DB before anything else runs. The exchange is the source of truth; orphaned or unknown orders surface as alerts requiring manual resolution.

### 7.1 Unattended Operation (trading while you're away)

Autonomous trading is done by **compiled strategy specs, not live AI judgment**. A LIVE-AUTO strategy executes entries, exits, and stop-losses in milliseconds via deterministic code within risk-engine bounds — no approval loop, no Claude call at order time. That's what makes 3am trading both possible and safe: code doesn't hallucinate and doesn't read overnight news it shouldn't trust. Claude's overnight role is journaling fills and preparing the morning review.

- **Escalation notifications (Telegram):** fills, closed positions, risk-limit hits, auto-pauses, and anomalies push to your phone. Severity tiers: info (fill) / warning (limit approached) / critical (auto-pause, reconciliation mismatch — repeated until acknowledged).
- **Fail-safe default is always "stop and hold, then tell you":** anything outside the spec's script — ambiguous order state, data divergence, API errors — pauses the strategy and notifies. The bot never improvises with money; unattended supervised-mode orders simply expire unapproved.
- **Per-strategy away-policy, set in advance by you:** on auto-pause, either hold positions (default) or flatten (market-exit everything). Chosen when arming the strategy, not decided by AI at 3am.
- **Optional time-windowed autonomy:** a strategy can be supervised while you're available and auto within defined hours — a useful intermediate rung on the graduation ladder.
- **Uptime reality:** unattended trading requires the machine awake and online (disable sleep; UPS/laptop battery helps). **Exchange-side TP/SL orders are confirmed supported** — every unattended position carries a venue-side stop, so downside protection survives a local crash or outage. The local engine manages/updates these stops; it is never the only stop.
- **Remote kill switch:** a Telegram command (`/pause`, `/flatten`) lets you stop everything from your phone. Inbound commands are allowlisted to your chat ID and limited to safe operations (pause/cancel/flatten only — nothing that opens risk).

---

## 8. AI Layer (Claude Agent SDK)

- **Agent runtime in main process** with tools: `read_candles`, `read_orderbook`, `read_session_memory`, `query_trades` (SQL, read-only), `run_backtest`, `propose_order`, `write_journal`, `web_research`.
- `propose_order` creates an OrderIntent record — it never executes. Execution requires risk-engine pass + (in supervised mode) your click.
- **Model tiering to control cost:** Haiku for routine periodic chart summaries and journal writing; Sonnet/Opus-class for strategy discussions and post-trade reviews. Scheduled strategy *evaluation* (does RSI < 30?) is pure code, not AI — the AI designs strategies; code runs them. This keeps API costs to dollars/month rather than dollars/hour.
- **Prompt-injection defense:** content fetched from the web (news, tweets) is untrusted. It is summarized in a separate agent call whose output is data-only (no tool access), then passed to the trading agent. Web content can never directly reach `propose_order`.

---

## 9. Market Data, Insights Layer & TradingView

**Principle: own the insights stack; rent nothing in the money path.** The bot builds its own analysis layer from public market data. TradingView remains your personal research surface (its ToS §3 prohibits automated/non-display use of its data — originally the reason the bot never read TV programmatically; see §9c for the owner's since-amended decision on that point for chat-only reads).

**a) Data layer (machine ground truth).**

- **Analysis feed (Binance only, decided 2026-07-26):** free public market-data APIs, no account, built for programmatic use. WebSocket streams + deep REST candle history. **Everything analytical goes through one entry point, `getAnalysisCandles`** — charts, indicators, backtests, paper fills, strategy triggers — so a chart can never disagree with the engine that traded on it. Coinbase was dropped from the plan: a second analysis source reintroduces exactly the divergence this rule exists to prevent.
- **No FX conversion anywhere.** Binance quotes USDT, so analysis is USD-quote only. Synthesized cross pairs (`BASEUSDT ÷ QUOTEUSDT`) were writing mixed-scale history into one symbol's cache; a non-USD pair now raises a clear error instead. Sessions on GBP pairs can exist (RevX trades them) but cannot be charted or backtested.
- **Cache integrity is checked, not assumed.** `getAnalysisCandles` verifies the requested window is both fresh *and* contiguous before serving it, re-syncing from REST when it isn't, and the UI flags a stale window. Two production bugs came from skipping this — see §13.
- **Execution feed:** Revolut X REST (balances, order book at the actual venue, order state). Never charted from. Prices differ from the analysis feed; the price-sanity check in the risk engine bridges the gap — every order validates against *Revolut X* prices at submit time — and the basis monitor (§14) now measures that gap continuously instead of assuming it.
- All candles cached in SQLite per pair for backtesting and offline work.

**b) Insights engine.**

- **Delivered:** 24 indicators via `technicalindicators` (pure JS, chosen over TA-Lib specifically to avoid a native/C build dependency — same reasoning as `node:sqlite` over `better-sqlite3`) computed from the Binance candle cache, with automatic REST backfill when local history is short. Covers trend (SMA/EMA/WMA/WEMA, MACD, Bollinger Bands, PSAR, Ichimoku, VWAP), momentum (RSI, Stochastic/StochRSI, Williams %R, CCI, ROC, MFI, ADX, TRIX, Awesome Oscillator), volatility (ATR, Keltner Channels), and volume (OBV, Force Index). `list_indicators`/`compute_indicators` chat tools expose the full catalog with parameter schemas.
- Derived metrics TV doesn't give you cheaply: order-book imbalance, depth heatmap, volume profile, spread tracking, cross-venue basis. **Cross-venue basis is delivered** (basis monitor, schema v7 — §14); order-book imbalance, depth heatmap and volume profile are *still open*.
- **Delivered ahead of schedule:** cross-venue derivatives (open interest, funding rate, mark price) from Binance (CEX, USDT futures) and Hyperliquid (DEX, on-chain perps) via a `get_derivatives_metrics` chat tool, including a cross-venue predicted-funding comparison across Binance/Bybit/Hyperliquid sourced from Hyperliquid's public API. CEX/DEX funding divergence is itself a positioning signal. This is an early, tool-based instance of the local insights engine's "derived metrics" concept (above), delivered in Phase 1 rather than waiting for the Phase 2 insights engine build-out. Replaced an earlier Coinglass integration, which had no free API tier.
- **Local alert engine (delivered):** conditions on the live Binance stream (same `Condition` format as strategy specs — indicator thresholds, price levels, crosses — so alerts are fully replayable in backtests). Each alert is scoped to a specific symbol/interval and keeps its own Binance subscription alive independent of whatever the UI happens to have open, so it fires whether or not you're looking at that pair. Triggers push live to the renderer as a dismissible toast from any page. `manage_alerts` chat tool (add/remove/list). Not yet wired into a Strategy Engine (that's LIVE_AUTO territory, Phase 4+) — today alerts notify, they don't act.
- In-app charts render this same data via **KLineChart** (Apache-2.0, zero deps) — you and the AI look at literally the same numbers. `lightweight-charts` was trialled and removed: two chart libraries meant two themes and two precision rules, and the price axis disagreed with the tables. One library, one `priceDecimals()` rule, one data adapter. Research adds the full drawing layer (§14); the small charts use the same component read-only.

**c) TradingView (human research surface).**

- **Embedded browser tab** (delivered — `src/main/browser/embedded-browser.ts`), logged into your paid account: full indicator suite, drawings, saved layouts, community ideas.
- **Amended (owner decision, see CLAUDE.md security posture notes):** originally spec'd as strictly display-only with the bot never navigating or capturing it (TV ToS §3). That's been intentionally relaxed — the chat agent can now call `read_browser_page` (page text) and `screenshot_browser` (image, vision-readable) against whatever's open in the embedded browser, including TradingView, when the user asks it to look. This is a knowing ToS-risk tradeoff, not an oversight. The manual snapshot-paste flow below still works and remains ToS-safest if you'd rather not rely on the automated path for TV specifically.
- **Manual snapshot → chat (still available):** when you want Claude's read on a TV chart, you can take the snapshot (TV's Snapshot button embeds the ToS-required attribution) and paste it into the session chat instead of using `screenshot_browser`. Claude analyzes structure/patterns/confluence and journals the observation. Pixel reads are approximate either way, so **chart reads (manual or automated) inform thinking; the insights engine's numbers fire triggers** — this distinction is unchanged and still enforced (see design rule below).
- **Optional bolt-on (deferred):** TV webhook alerts (paid plan + 2FA, listener behind a Cloudflare Tunnel with shared-secret payloads) are the officially sanctioned way to push a Pine Script condition into the bot, if a community script ever proves irreplaceable. Usually porting the Pine logic into a local indicator is cleaner — and backtestable.

**Design rule:** ideas come from anywhere (your snapshot discussions, community scripts, the insights engine); triggers come only from the local insights engine; orders validate only against Revolut X data — always through the risk pipeline. Stop-losses live locally, never in any external alert service.

- **Research browser (delivered, then re-scoped):** the embedded tab is now a general-purpose browser (home: DuckDuckGo, not TradingView — Research does the charting). **The agent no longer researches through it.** It has its own `fetch_url` tool running in a separate, non-persistent, cookie-less session, so pages it reads can never see your logged-in state, and it can't hijack the tab you're looking at. `navigate_browser` survives, re-scoped to "put a page on the user's screen when asked". Optional Browserbase cloud-browser fallback for pages that won't render locally, with CAPTCHA solving and stealth explicitly off.
- **Screenshot-to-Claude:** available both ways now: manual (you paste a snapshot directly from your OS clipboard into the chat UI, which is automatically sanitized and downscaled via HTML5 Canvas to protect privacy and save API costs) and automated (`screenshot_browser` tool call against the embedded browser).

---

## 10. Backtester & Paper Exchange

Shared fill-simulation core, two frontends:

- **Backtester (delivered — `src/main/backtest/backtester.ts`):** replays cached Binance candles through a strategy spec. Models: taker fee rate (flat bps — Revolut X's actual maker/taker schedule not yet wired in; today it's a configurable flat rate, not fetched from the venue), flat-bps slippage estimate (not yet derived from real order-book depth snapshots — that's a simplification vs. the original spec). Reports equity curve + drawdown, Sharpe, win rate, profit factor, per-trade log, and a walk-forward in-sample/out-of-sample comparison with automatic overfit warnings. `run_backtest` chat tool + full report UI on the Bot page.
- **Paper exchange:** same fill model running against *live* polled data, maintaining a virtual balance. Identical interface to the real execution engine, so a strategy is promoted to live by swapping the engine pointer — zero code-path differences. *(Not yet built — Phase 3; the backtester's `simulate()` core is written to be reusable here.)*

Honesty caveat baked into UI: backtests are simulations of the past, not predictions; overfit detection (walk-forward split: optimize on 70%, validate on held-out 30%, both configurable) is built into the backtest report and surfaced as an explicit warning when in-sample materially outperforms out-of-sample.

---

## 11. Security

**Delivered:**

- Ed25519 private key and both API keys (Revolut, Anthropic) encrypted at rest via `safeStorage` (OS keychain — DPAPI on Windows); never in SQLite, never over IPC, never in prompts or logs. An earlier plaintext-PEM-plus-`chmod 0600` approach for the private key was replaced — POSIX chmod bits are largely cosmetic on Windows/NTFS, so this was a real gap, not just theoretical. Legacy installs auto-migrate on startup.
- Renderer hardening: `contextIsolation`, `sandbox`, `nodeIntegration: false`, CSP locked to `default-src 'self'` (no `unsafe-eval`), all permission requests (camera/mic/geolocation/etc.) denied, global navigation/window-open guards applied to every `webContents` Electron creates, not just the main window.
- Packaged builds (`electron-builder`, `npm run package:win`) apply Electron Fuses: `runAsNode` disabled — closes `ELECTRON_RUN_AS_NODE`, a known technique for hijacking a legitimately-signed Electron binary into running arbitrary Node code — plus ASAR integrity validation. Currently unsigned (no code-signing certificate yet).
- Optional Windows Hello app-launch gate (`src/main/security/windows-hello.ts`, PowerShell shell-out to WinRT `UserConsentVerifier` — zero new dependency). Additive layer on top of the credential encryption above, not a replacement; fails open if Hello isn't configured or the platform isn't Windows.

**Still open:**

- Outbound network allowlist: `revx.revolut.com`, `api.anthropic.com`, Binance/Hyperliquid public data APIs, chart CDN — currently relies on the code simply not calling anywhere else, not an enforced network-layer allowlist. Log every outbound host in dev.
- All order-affecting actions written to an append-only audit log (separate SQLite file) before submission — the audit log exists today (setup/session/security events) but no order-affecting code exists yet to log (Phase 4 gate).
- Auto-update off, or signature-verified only — a compromised update channel is a compromised wallet. No auto-update mechanism exists yet.
- Rotate the Revolut API key immediately if the machine is ever compromised (Profile → API Keys).

---

## 12. Build Phases

**Phase 0 — Foundations (1–2 wks):** Electron + TS scaffold, secure IPC, SQLite schema, Revolut X client integration (read-only), API key setup flow. *Exit: balances and candles displayed in-app.* — **✅ complete & verified** against the live Revolut X API.

**Phase 1 — Sessions + Chat + Data layer (2 wks):** session CRUD (UI surface 1), Claude chat with session context (surface 2), Binance WebSocket feed + candle cache, read-only tools (candles, memory, SQL), in-app charting with volume. Embedded privacy focused lightweight browser tab with TV login (surface 3) — cheap to add early since it's display-only. *Exit: discuss a pair with Claude referencing live data; paste a TV snapshot into chat.* — **✅ complete.** Sessions, agentic chat with session-scoped tools, Binance WS feed + candle cache, in-app charting (candles + volume), Market page, cross-venue derivatives (§9), and the embedded browser tab (surface 3 — isolated session, tracker blocklist, no scraping/automation, defaults to TradingView) are all built.

**Phase 2 — Insights engine + Backtester (2–3 wks):** indicator library integration, local alert engine, strategy spec format, fill simulation, fee model, backtest reports with walk-forward validation. Bot working area (surface 4) starts here. *Exit: Claude proposes a spec, backtests it, and critiques the result.* — **✅ complete.** 24-indicator library (`technicalindicators`), formal strategy spec with nested AND/OR condition groups and full lifecycle validation, backtester with fee/slippage simulation + walk-forward overfit detection, local alert engine (wired to live Binance stream), Bot working area UI. Also includes agentic web navigation tools (`navigate_browser`, `read_browser_page`) and manual image-paste chat inputs with canvas sanitization.

**Phase 3 — Paper trading + Memory loop (2 wks):** paper exchange on live data, journal writing, post-trade review agent, lessons distillation, journal UI (surface 6) and memory browser (surface 7), dashboard v1 (surface 5) on paper results. *Exit: a strategy runs on paper for 2 weeks and the bot writes coherent reviews.* — **⏳ built, not yet proven.** All the code exists: paper exchange with backtest-parity fills (schema v6 `paper_positions`), post-trade review agent, lessons distillation, journal UI with the lessons pane, orders surface, portfolio aggregate, dashboard. **What has NOT happened is the part that matters** — no strategy has yet completed a full paper round trip (entry → stop/target → review), so the exit criterion is unmet. See §15.

**Phase 4 — Live supervised (1–2 wks + patience):** risk engine (build and test this *before* any live order), execution engine, approval UI, kill switch, audit log. Start with tiny sizes (e.g., USD 10–20 orders). *Exit: 20+ supervised live trades with zero risk-engine surprises.*

**Phase 5 — Earned autonomy (ongoing):** graduation logic, auto-pause triggers, portfolio view, weekly lessons digest, cost dashboard for Claude API usage.

Realistic total to Phase 4: **~2–3 months** of part-time work. Resist compressing Phase 3 — the paper-trading period is where design flaws surface for free.

---

## 13. Known Risks & Open Questions

- **Execution latency:** analysis is now real-time (Binance WS), but execution is still Revolut X REST — order placement and state polling take seconds. Strategy design must assume this; no strategies that depend on reacting inside seconds at the venue.
- **Cross-venue divergence:** in fast markets the Binance→Revolut X price gap can spike beyond basis points. The risk engine's price-sanity check at submit time is the guard; log divergence and auto-pause if it exceeds a threshold. **Now partly measured** — the basis monitor records spread and basis per pair (§14), and backtests use the measured figure. What it still does *not* capture is depth: it samples top-of-book only, so a large order will fill worse than the median suggests.
- **Data that looks right:** the worst bugs so far have all been silent — FX-contaminated candles, stale/gappy history rendered as current, and an agent tool that read 4H data while telling the model it was reading the user's on-screen chart. None threw an error; all would have produced confident, wrong analysis. Two rules fall out of this: every data path needs an "is this fresh, contiguous, and the thing I claimed?" check, and **a tool's description is a contract** — if it says 50 candles and SMA-200, it must return exactly that, because the model has no way to verify.
- **Prompt injection:** the agent can now fetch arbitrary web pages while holding tools that write strategies, alerts and journal entries. Content is wrapped as untrusted and the system prompt forbids following instructions found in it — but those are mitigations, not boundaries. The only structural protection is that no order tool exists. That protection expires in Phase 4, so the risk engine must be what makes this safe, not the prompt.
- **Rate limits:** limit orders capped at 1,000/day (confirmed); read-endpoint limits (429 responses documented) unspecified — build a token-bucket client-side limiter with backoff; multiple sessions share one budget.
- **API terms:** verify Revolut X ToS permits automated trading via personal API keys in your jurisdiction (it ships an official API + grid bots, so almost certainly yes, but confirm).
- **Fee drag:** spot fees make high-frequency strategies net-negative quickly; the backtester must always show fee-adjusted PnL prominently.
- **Overfitting:** the biggest real risk isn't a bug — it's a beautifully backtested strategy that memorized the past. Walk-forward validation and minimum-trade-count gates are the defense.
- **Claude API cost:** with model tiering and code-based strategy evaluation, expect roughly USD 10–50/month depending on chat volume; without tiering, easily 10× that.
- **Vision imprecision:** Claude reading a pasted chart snapshot estimates values from pixels — fine for structure and confluence, unreliable for exact levels. The "snapshots think, numbers fire" rule (§9) exists because a vision misread that reaches execution is a silent money bug.
- **TV ToS compliance:** The original plan prohibited automated scraping/navigation of TV to strictly comply with ToS §3. This has been explicitly relaxed by owner decision: the agent can now call `screenshot_browser` or `navigate_browser`. If you prefer maximum safety, you can bypass the embedded TV entirely and use the newly built feature to copy-paste screenshots from your own external browser straight into the bot's chat.
- **If the TV webhook bolt-on is ever added:** confirm tier includes webhooks + enable 2FA; webhooks fire once with no retry, so they can never be the only exit mechanism.

---

## 14. Additions Beyond the Original Plan (as built, July 2026)

Things that weren't in the plan but exist now, and why. Recorded here so the plan stops disagreeing with the codebase.

**Data-feed roles — one feed per purpose (§9 amended).** Binance is the *analysis* feed for everything: charts, indicators, backtests, paper fills, triggers, all through `getAnalysisCandles`. Revolut X is *execution and reconciliation truth* only — balances, orders, fills — and is never charted from. FX conversion was removed entirely: synthesized non-USD pairs (`BASEUSDT ÷ GBPUSDT`) were producing mixed-scale history, so analysis is USD-quote only and a GBP pair now errors rather than lying. Schema v8 purged the contaminated rows.

**Basis monitor (schema v7).** Samples Revolut X bid/ask against Binance every 60s and stores spread and basis in bps. `measuredSlippageBps()` feeds the *measured* cost into backtests instead of a guessed 5bps, returning null below 30 samples so a thin sample can't masquerade as fact. This closes the plan's biggest unquantified assumption: strategies validated on one venue's prices, executed on another's.

**Candle integrity.** Two bugs, both of the same shape — data that *looked* right. Backfill only ever filled backwards, so a cache could be days stale while passing a row-count check; and neither check guaranteed the returned window was *contiguous*, so WS-written islands rendered as consecutive candles. `getAnalysisCandles` now checks window coverage and re-syncs; the UI shows a stale badge rather than drawing old bars as live.

**Research surface + KLineChart.** Research became a real charting workspace (drawing tools, wave counts, Fib/Gann, position tool with R:R, anchored/fixed-range VWAP, indicator parameters, bar replay, per-symbol persisted drawings in schema v9). `lightweight-charts` was removed — one library, one theme, one precision rule.

**Agent web access.** Two tools: `web_search` (Anthropic's server-side `web_search_20260318`, up to 5 per turn) for discovery, `fetch_url` for reading a specific page in an isolated cookie-less session with an optional Browserbase cloud-browser fallback. The split matters: search-results pages are the kind that return a JS shell to a headless fetch, and routing them through `fetch_url` burned Browserbase minutes on searches rather than content. `fetch_url` is deliberately *not* mapped to a UI surface — it was mapped to the Browser tab, causing the UI to switch there while the actual fetch happened in an invisible window. Web content is wrapped in an untrusted-data envelope; prompt injection is the live risk, and the only real *boundary* is that the agent has no order tools. Models that reject the server-side tool degrade gracefully: the tool is dropped for that model and the user is told.

**UI redesign.** Session-first navigation, four-band shell, terminal-density design system derived from the logo. Two deliberate non-implementations: the live-mode switch is disabled and Approvals shows the risk engine's *contract* rather than a fake queue. A control that looks functional but isn't is the most dangerous thing this UI could contain.

**Shared IPC contract (`src/shared/ipc-types.ts`).** Payload types were declared twice and drifted. Now defined once, imported by both sides.

**Agent presence.** The agent navigates the UI to whatever surface its current tool targets (`agent:navigate` + a tool→surface map), signals an "acting" state, and broadcasts `data:updated` after any tool that writes, so Journal/Workbench/Alerts/Research refresh without polling. Research reports its symbol, interval and chart bounds back to main (`research:view`) so the agent's chart tools read the same view the user sees — before that, `read_research_chart` claimed to read the on-screen chart while hardcoding 4H, and `screenshot_research` captured the whole window including the chat transcript. **Rule: a tool that writes to the DB must also broadcast, or the UI silently goes stale.**

**Chat management.** `chat:clear` and `chat:compact` — compaction summarises all but the last four messages with a cheap model, files the summary in the journal as a `checkpoint` note, and replaces the compacted rows with a single marker. Lossy on purpose: the journal is the durable record, the transcript is working memory. Model IDs are resolved dynamically from `/v1/models` (Haiku → Sonnet → first) rather than hardcoded.

**Per-session Alerts surface** and **strategy deletion** — eleven drafts on one pair made pruning necessary.

---

## 15. Next Stages (planned, in order)

**Stage A — Prove the paper loop (COMPLETE 2026-07-29).**
1. **Fill-model equivalence test.** Built `fill-equivalence.test.ts` asserting `backtester.simulate()` and `paperEngine` produce identical fills, fees, slippage, net PnL, and intrabar TP/SL exits.
2. **One complete paper round trip.** Built `paper-roundtrip.test.ts` testing entry -> exit -> DB balance reconciliation -> position closed listener.
3. **Candle-coverage regression test.** Built `candle-coverage.test.ts` asserting non-USD rejection, gap/staleness detection, and ascending timestamp contiguity. Run all via `npm test`.

**Stage B — Make paper results legible (COMPLETE 2026-07-29).**
4. **Equity curve on the dashboard**, drawn from `paper_positions` via `PaperEquityChart` and `getPaperEquityCurve`.
5. **Paper-vs-backtest comparison per strategy** — built `PaperComparisonCard` and `getStrategyComparisons` to compute `divergenceWinRate` and flag `Overfitting Risk` when paper win rate drops below backtest expected win rate.
6. **Phase 1 Dynamic Position Management** — implemented Trailing Stop-Loss (`trailing_stop_pct`), Move SL to Breakeven (`breakeven_trigger_pct`), and Multi-Target Position Trimming (`targets`) in `strategy-spec.ts`, `backtester.ts`, and `paper-exchange.ts`.

**Stage C — Phase 4 groundwork (COMPLETE 2026-07-29).**
7. **Risk engine**, pure functions, exhaustively unit-tested against the eight checks listed in the Approvals surface (`risk-engine.ts`, `risk-engine.test.ts`).
8. **OrderIntent plumbing**, routing order intents through RiskEngine and database `orders` logging before paper or live execution (`order-pipeline.ts`).
9. **Real kill switch**, emergency manual circuit breaker (`kill-switch.ts`).
10. **Research Chart Alert Overlays**, interactive horizontal alert price lines on KLineChart (`research-page.tsx`).

**Deliberately not next:** live trading, more strategies, more indicators. The bottleneck isn't capability, it's evidence — eleven strategies exist and none has produced a single verified paper trade.

---

## 16. Theming & Customisation (planned)

Scheduled deliberately *after* Stage A/B: a theme system built before the surfaces settle means re-theming every surface twice. Density landed early only because unreadable type blocks daily use.

**Already built (2026-07-29)**

- **Interface density** — `Compact | Default | Comfortable`, swapping the `--text-*` and `--icon-*` tokens off `data-density` on `<html>` (`src/renderer/lib/density.ts`, Settings › Appearance). Stored in `localStorage`: it's a per-machine display preference no engine reads, and an IPC round trip would mean the first paint happens at the wrong size.
- Icons scale without touching call sites — CSS maps each *authored* lucide `size` onto a density token, and CSS beats presentation attributes, so the intended hierarchy (12px badge vs 18px empty state) survives instead of flattening to one size.
- **Brand:** logo at 24px in the titlebar (was 18px, reading as a favicon), with the Nepali tagline **जानेर मात्र, किनबेच** — *jaanera matra, kinbech*, "trade only knowingly" — as a lockup beside the name, and in full (Devanagari + romanisation) on the lock screen and onboarding. Constants live in `src/renderer/lib/brand.ts`; `--font-deva` gives Devanagari its own stack so the OS doesn't pick a fallback for it.

**Planned, in rough order of value**

1. **Theme tokens split from semantic tokens.** Today `--up`, `--down`, `--accent`, `--caution`, `--ai` are literal hex values in `:root`. A theme should supply a *palette*; the semantic layer maps palette → meaning. Until that split exists, "a new theme" means editing meaning, and the rule that one colour must not mean two things (see §14) gets lost.
2. **Accent choice.** Cyan is the current interactive colour; the logo's amber is deliberately excluded because amber means *caution* in a trading UI. Any accent picker must enforce that constraint rather than offer a free colour wheel — the whole point is that colour carries meaning here.
3. **Light theme.** Genuinely hard for this app: the semantic colours are tuned for dark, and green/red on white needs different saturation to stay distinguishable at 11px. Worth doing properly or not at all.
4. **Colour-blind-safe mode.** Up/down currently rely on green/red alone in several places (rail PnL, stat cells, movers). Deuteranopia-safe pairs plus a shape or sign cue would make the app readable without colour at all. Arguably a correctness fix, not a preference.
5. **Chart palette bound to the theme.** KLineChart is configured separately from the CSS tokens today, so a theme change would leave the chart on the old colours — the same two-sources-of-truth failure mode as the old two-chart-library situation.
6. **Font choice.** Sans is `Segoe UI`; mono is IBM Plex Mono and should stay mono-by-rule (tabular figures are non-negotiable — a price must not shift horizontally as it ticks). A font picker should therefore offer *sans* alternatives only.
7. **Language / locale.** The tagline is Nepali; the UI is English. Full localisation is a much larger commitment (number and date formatting are already locale-aware via `toLocaleString`, but copy is not extracted). Worth scoping honestly before starting.
8. **Per-session accent.** Optional: a colour per session so ARB-USD and BTC-USD are distinguishable at a glance in the rail and on Home. Cheap, and it fits the session-first IA.

**Constraint that outranks all of the above:** no theme may make a state ambiguous. Live vs. paper, armed vs. idle, up vs. down, AI-authored vs. human-authored must remain distinguishable in every theme — including to someone who cannot see colour. A customisation that lets the user make "live" look like "paper" is a safety bug, not a preference.

---

## 17. Scenario Plans & Discretionary Tooling (planned, 2026-07-29)

### 17.1 The category error this fixes

§6's lifecycle treats **backtested** as *the* evidence gate. That assumes every strategy is a repeating rule whose edge is a statistical property. A professional discretionary trader also works in a different mode: a **one-shot bet on a path** — "if BTC clears 72k and holds 4h, long to 78k; if it rejects and retests 68k, long there instead; below 66k the thesis is dead."

For that, statistical validation is not *unavailable*, it is **inapplicable**. Backtesting a single-shot plan over 30 days yields a 1–2 trade sample, and a 2-trade sample presented as a backtest is worse than no backtest — it launders a guess into a metric. The current gate therefore pushes the owner to either fake a spec until it produces enough trades to pass, or trade the thesis manually outside the app. The second is the worst outcome available: the app then has no record of the reasoning, and the journal/lessons loop goes blind exactly when it would be most useful.

**Resolution: a second artifact with a different gate.** Don't loosen the backtest gate; add `trade_plans` alongside `strategies`. A separate table, not a `type` flag, because `backtested` is meaningless for half the rows otherwise (owner decision, 2026-07-29).

### 17.2 What replaces the backtest: falsifiability, not nothing

A scenario plan cannot be armed unless it declares four things. This is the structural equivalent of the backtest gate — it does not claim the plan is good, it guarantees the plan can be *proven wrong*.

- **Assumptions, explicit.** The behavioural claims the plan rests on, as text plus machine-checkable conditions where possible. This is what makes post-trade review meaningful: *right thesis + bad execution* and *wrong thesis + lucky money* are opposite outcomes that PnL alone cannot distinguish.
- **Invalidation, separate from the stop.** A stop is where *the trade* is wrong. Invalidation is where *the thesis* is wrong, and they are not the same price — "the ETF headline was denied, I'm out regardless of price" can fire while the position is green. Mechanical systems lack this concept entirely; it is the single biggest gain here.
- **Expiry, hard and required.** A thesis has a shelf life. Without expiry, a stale conditional fires three weeks later into a market its assumptions no longer describe. This is the most dangerous failure mode of scenario automation and the cheapest to prevent.
- **A risk budget from a separate, smaller allowance** than validated strategies. Unvalidated conviction gets less capital — that is the honest price of skipping the backtest.

Plus: **branches are mutually exclusive by default** (OCO). If path A triggers, path B cancels, or both fire and the position is silently double-sized.

### 17.3 What can still be checked mechanically

None of these approve a plan. They make its assumptions legible, which is the product thesis (*trade only knowingly*).

1. **Base rates / precedent search.** Price the assumption against history: *"you assume a 4h hold above a 30-day high; on this pair 31 of the last 44 such breaks failed within 4h."* Calibration, not validation — and the most valuable single number the app can hand a discretionary trader.
2. **Structural dry-run.** Replay the trigger logic over history to prove the plan is *well-formed*: does it ever fire, does it fire 400 times (too loose), is a branch unreachable, are branches genuinely exclusive. Catches a **broken** plan without claiming a **profitable** one.
3. **Cost feasibility.** Against the measured RevX spread (`data/basis-monitor.ts`): a 0.4% target on a pair costing ~25bps a side is dead before arming.
4. **Reachability.** ATR-scaled distance to the assumed levels versus the expiry window.

### 17.4 Validation moves from the plan to the planner

Statistics don't disappear, they relocate. Per scenario tag, track trigger rate, invalidation-before-target rate, and captured share of the move when direction was right. After ~30 plans that is a real calibration record: *"your breakout-hold theses hit invalidation 70% of the time; your VWAP-reversion theses reach target 60%."* `agent/review.ts` + `distillLessons` is already the right machinery — it needs assumption-vs-outcome as an input alongside PnL.

### 17.5 Lifecycle

```
DRAFT ──► PLANNED (armed, awaiting trigger) ──► TRIGGERED ──► CLOSED
                    ↘ EXPIRED          ↘ INVALIDATED
```

Carried over unchanged from §1/§7:

- Triggers compile to the **same `ConditionGroup` primitives** and evaluate through the same path. One evaluation engine is a hard-won property of this codebase; a second one drifts (paid for twice already — paper-vs-backtest fill model, FX-contaminated candles).
- The **risk engine gates scenario entries identically**. No exemption from the stop-loss gate, position caps, or the kill switch.
- **Scenario plans may reach `live_supervised`, never `live_auto`.** The justification for unattended automation is a validated edge; there isn't one here, so a human signs the entry. This falls out of the design rather than being bolted on.
- The AI **drafts** plans and never arms one. The compiled plan is shown as a diff of concrete numbers for confirmation before arming — authoring is precisely where a persuasive thesis could arrive from untrusted web content.

**Loophole guard:** file the same thesis six times and you have built an unvalidated strategy one plan at a time. A repeated thesis *is* a pattern, so the system says so — *"you've filed this setup 6 times; that's a strategy, backtest it."* The loophole becomes the on-ramp.

### 17.6 `PriceLevel` — levels are references, not numbers

Scenario price points come in three flavours, and conflating them is what makes scenario automation dangerous:

| Flavour | Example | Behaviour |
|---|---|---|
| **Static** | `72,000` | Fixed at authoring. |
| **Frozen-derived** | VAH of a *closed* fixed range; AVWAP with a fixed end | Deterministic — the window can never change, so it resolves to one stable number forever. |
| **Developing** | Session VWAP, anchored-profile POC, CVD, VWAP bands | **Moves every bar.** |

```ts
type PriceLevel =
  | { kind: "static"; price: number }
  | { kind: "derived";
      source: "vwap" | "avwap" | "volume_profile" | "cvd" | "ichimoku" | "fib";
      params: Record<string, unknown>;   // incl. bin width, distribution rule, value-area %
      window: { from: number; to: number | "developing" };
      field?: "poc" | "vah" | "val" | string;
      resolve: "snapshot_at_arm" | "snapshot_at_trigger" | "live";
      resolvedAtArm: number;             // always recorded, even for `live`
      driftTolerance: { pct?: number; atr?: number; binChange?: boolean };
      onDrift: "reconfirm" | "invalidate";
    };
```

**Why the drift guard is safety-critical.** A plan says "long above VAH" with VAH at 71,800. Three days later the developing profile has VAH at 74,200. The plan fires — but not in the price region the trader reasoned about, and with a stop/target geometry they never agreed to. The thesis silently became a different trade. `onDrift` forces that to surface.

**Related detection, required in the review payload:** *did the trigger fire because price moved, or because the level moved toward price?* An anchored profile's POC migrates toward current price as volume accumulates, so this is a live trap. Comparing price displacement against level displacement since arming answers it in one line, and no PnL figure will ever reveal it.

**Default `onDrift` is `invalidate`** (decision 2026-07-29). A stale plan that quietly asks for approval gets approved reflexively at 3am; one that expires forces deliberate re-authoring. Exception: anchored-profile POC uses `binChange` rather than a percentage (see §17.8) and `reconfirm`.

### 17.7 Drawings are geometry; references are semantics

`chart_drawings` stores KLineChart overlay points — main can read the rows, but they are screen coordinates with timestamps, not definitions. A fib drawn on the chart is therefore invisible to the engine.

Same principle already enforced for candles and settled for KLineChart: **one definition, two consumers.** Persist the semantic reference (anchors, ratios, basis, window, params); the chart *renders from* it, the engine *resolves from* it. A **promote drawing → plan reference** action keeps drawing-on-the-chart as the authoring gesture — the natural workflow for a chart-first trader, and nothing gets typed twice.

Second, smaller, and the shared extension point for everything below: **`Condition.value` must accept a `PriceLevel`**, not only a number/array, so "price crosses VAH" or "close above Kijun" is expressible.

### 17.8 Required tooling (non-negotiable, owner 2026-07-29)

Three tiers, because these are not the same kind of object:

- **Tier 1 — computed:** Ichimoku, VWAP/AVWAP, volume profile, CVD. Deterministic from candles. First-class indicators, valid triggers.
- **Tier 2 — anchored-computed:** Fibonacci. The arithmetic is deterministic, the *anchors* are discretionary. Becomes a valid trigger once anchors are data rather than screen geometry.
- **Tier 3 — interpretive:** Elliott waves. No deterministic count exists; competing counts coexist and get revised.

**Volume-based tools** — anchored VWAP, fixed-range volume profile, anchored volume profile, CVD. All four are **anchored path-dependent accumulators**, so one resolver serves them all:

| Tool | Accumulates from anchor | End |
|---|---|---|
| Anchored VWAP | Σ(price×vol) / Σvol | developing |
| Anchored volume profile | volume histogram at price | developing |
| Fixed range volume profile | volume histogram at price | **closed** |
| CVD | Σ(2×takerBuy − volume) | developing |

- **POC jumps; VWAP glides.** AVWAP is effectively non-repainting (it only appends). Anchored-profile POC sits in one bin until another overtakes it, then teleports — so a percentage drift tolerance is the wrong guard and `binChange` is the right event.
- **Value-area % is a parameter** (70% is convention, not law), stored per reference — never a module constant. Same rule as the fib ratios.
- **Volume profile from OHLCV is an approximation, not a measurement.** True profile needs trade/footprint data. From candles, each bar's volume must be distributed across its high–low range, and the rule materially moves POC. **Default: uniform across range** (most defensible, no hidden weighting), with the rule and bin width persisted in `params` so a plan armed today cannot silently resolve differently later. **Never "auto" bin width** — auto means the level moves as history grows. Displays must label it candle-derived.
- **CVD is exact at bar resolution and nearly free.** Binance supplies taker-buy base volume on both paths already in use — kline index `9` (REST) and `k.V` (WS) — and both currently discard it. `delta = 2×takerBuy − volume`; CVD is the running sum. **CVD's absolute value is meaningless** (cumulative from an arbitrary origin), so it is inherently anchored; only slope and divergence-against-price carry information.
- **`taker_buy_volume` must be nullable and mean "unknown".** Reading a missing value as `0` computes `delta = −volume`: a bar of pure selling that never happened — the paper-balance/FX failure again. Existing cached candles have no taker figure; both backfill paths use `ON CONFLICT DO UPDATE`, so **history heals whenever it is refetched** (no purge, decision 2026-07-29), and CVD reports coverage rather than drawing across unknown bars.
- **Footprint / delta-at-price deferred** (decision 2026-07-29). That needs the `@aggTrade` stream plus trade-level storage — a different tool with a different storage bill. Bar CVD is what a CVD pane shows anyway.
- **Feed roles:** CVD is Binance *spot* order flow — an analysis signal. It says nothing about Revolut X's thin, entirely different book, and must never be read as a claim about the execution venue.

**Ichimoku** — already computed in `insights/indicators.ts`. Worth naming: Senkou Span A/B are computed from *past* data and plotted 26 forward, so the future cloud is **genuinely known in advance** — reading it is *not* look-ahead bias. That makes a **kumo twist** a scheduled, forecastable future event, ideal for a scenario branch. The trap is indexing, not validity: Senkou displaces forward, Chikou backward, and an off-by-`displacement` error compares a projection to the wrong bar, producing a signal that backtests beautifully and is fiction. Needs an explicit test pinning each of the five lines to its bar offset.

**Fibonacci** — currently drawing-only with **hardcoded ratios in four places**: `FIB_EXT_LEVELS`, `FIB_CIRCLE_LEVELS`, `GANN_RATIOS` in `chart-tools.ts`, plus KLineChart's baked-in set for `fibonacciLine`. "Customisable values" is therefore not met at all. Must become data:

```ts
interface FibReference {
  anchors: Array<{ ts: number; price: number }>;  // 2 retracement, 3 extension
  ratios: number[];                                // user-defined, per reference
  basis: "linear" | "log";                         // log matters on crypto's % ranges
  anchoredFrom: "manual" | "swing";                // provenance, for the review agent
}
```

One ratio-set editor, one persisted default, per-reference overrides. **Log basis is not optional** — on a pair that ran 3×, linear and log retracements are materially different levels and the thesis is about one of them. Auto-anchoring from swing detection (ZigZag/fractal pivots) is what makes fib usable in a *repeating* strategy, and it requires point-in-time computation to avoid look-ahead.

**Elliott waves** — automated counting will **not** be built and presented as a signal. There is no deterministic count, and an auto-labeller that revises itself is the repainting problem in its purest form: it would backtest wonderfully and lose money live. Instead, the count is a **human-authored thesis whose falsification is mechanical**, because Elliott's own rules are hard constraints checkable against price:

- wave 2 may not retrace beyond the origin of wave 1;
- wave 3 may not be the shortest of 1, 3, 5;
- wave 4 may not enter wave 1's territory (non-diagonal impulses).

That is a ready-made **invalidation** source supplied by the framework rather than invented per plan, and the *targets* are fib projections off the labelled pivots (Tier 2). So: user labels pivots → app derives targets and invalidation → both machine-monitored → the review agent records whether the count survived → the calibration record accumulates the owner's hit rate on wave-based theses. Elliott as a first-class planning structure, with no pretence that a machine counted it.

### 17.9 Implementation constraints

- **Path dependence breaks naive replay.** These accumulate from an anchor, so recomputing from scratch each bar is O(n) per bar, O(n²) across a dry-run. The resolver carries incremental state forward bar to bar.
- **Point-in-time correctness is mandatory.** Bar *i* sees only bars ≤ *i*. Computing a value area over the full range and then replaying it is look-ahead bias, and an anchored-profile strategy would backtest beautifully on levels that did not yet exist. Frozen-derived levels are exempt by construction — a genuine reason to prefer them.
- **One implementation, in main.** The Research chart renders the values main computed, never its own client-side profile. Two implementations of VAH is the bug class already paid for three times.

### 17.10 Build order

1. `PriceLevel` types + `Condition.value` extension + resolver — unblocks everything, no UI.
2. `taker_buy_volume` capture (schema v11) + `insights/volume-profile.ts` + anchored accumulators (AVWAP, CVD, VWAP σ bands).
3. Fib ratio sets as data (kills the four hardcoded arrays), log basis, promote-to-reference.
4. Elliott rule-checker as an invalidation source, riding on 1 and 3.
5. `trade_plans` table + scenario lifecycle + base-rate/dry-run checks.

---

*This is a planning document for a personal-use tool. Nothing in it is investment advice; automated trading can lose money faster than manual trading. Start small, keep the kill switch reachable.*
