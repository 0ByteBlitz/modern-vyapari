<div align="center">

<img src="assets/icon.png" alt="Modern Vyapari logo" width="96" />

# Modern Vyapari

**An AI trading partner that keeps the AI out of the order path.**

*जानेर मात्र, किनबेच* — *jaanera matra, kinbech* — "trade only knowingly."

[![CI](https://github.com/0ByteBlitz/modern-vyapari/actions/workflows/ci.yml/badge.svg)](https://github.com/0ByteBlitz/modern-vyapari/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: alpha, paper only](https://img.shields.io/badge/status-alpha%20%C2%B7%20paper%20only-orange)
![Electron + TypeScript](https://img.shields.io/badge/Electron-TypeScript-2b2e3a)

</div>

---

Most AI trading projects ask *"can a model find the trade?"* Modern Vyapari starts from a
different problem: **most traders lose not for lack of ideas but because they don't stick
to their plan.** So the app's job is to take you out of the moment of temptation.

**You author a thesis. The agent helps you sharpen it and watches the market. Deterministic
code executes exactly what you signed — and nothing else.**

> ⚠️ **Alpha. Nothing in this app can place a real order yet.** Live execution is not built;
> all positions today are simulated (paper). See [Status](#status) and the [Disclaimer](#disclaimer).

## A quick tour

*Screenshots are from simulated mode with demo plans, taken offline — which is why the market
panels are empty.*

**1. First launch.** Connect an AI provider and you're in. An exchange account is optional
while you trade in simulated mode. Every key is encrypted with your OS keychain before it
touches disk.

<p align="center">
  <img src="docs/images/onboarding.png" width="820" alt="Onboarding: the AI provider comes first; the trading venue is marked optional in simulated mode" />
</p>

**2. Home, and the global agent.** The app opens on Home with no session selected: paper
performance, *while you were away*, and your sessions, each badged *armed*, *in position* or
*idle*. The mascot in the corner is the **global agent** — ask it anything that isn't about
one pair, and it offers your sessions as one-click ways in.

<p align="center">
  <img src="docs/images/home.png" width="820" alt="Home with three sessions, one armed, and the global agent's floating chat window open from the mascot in the lower-right corner" />
</p>

**3. A session, and its own agent.** Inside a session the agent drawer belongs to that pair —
its plans, journal and memory. The global agent moves aside but stays one click away. Two
agents, never ambiguous which: the drawer is bounded by its session, the mascot is global.

<p align="center">
  <img src="docs/images/session.png" width="820" alt="BTC-USD session dashboard: an armed plan with entry, stop and target, engine activity, the BTC-USD agent drawer, and the mascot docked at its edge" />
</p>

**4. Plans.** A thesis you can be wrong about, written down before the market can talk you out
of it. Drafts can't be armed until they state assumptions, an invalidation, an expiry and a
budget — and only you can arm one.

<p align="center">
  <img src="docs/images/plans.png" width="820" alt="Plans page with one armed plan and one draft, each showing its thesis, branches, assumptions, budget and expiry" />
</p>

**5. Research.** Charting on the analysis feed, with the agent reading the chart, searching the
web and fetching pages through its tools. It can research, journal and draft a plan —
it has no tool that can place, size or price an order.

<p align="center">
  <img src="docs/images/research.png" width="820" alt="Research screen with a BTC-USD candlestick chart and the agent calling web_search, read_candles and fetch_url" />
</p>

**6. Quitting says what stops.** A plan can only execute while the app is running, so closing
it tells you exactly what won't be watched.

<p align="center">
  <img src="docs/images/quit-dialog.png" width="480" alt="Quit dialog: while the app is closed, 1 armed plan can't trigger. Cancel is the default." />
</p>

There's also an optional **Windows Hello** gate at launch, with its own *while you were away*
feed — including, in red, any window when nothing was watching.

## How it works

```mermaid
flowchart LR
    U([You]) -- write thesis --> P[Trading plan]
    A[AI agent] -. research, levels, drafts .-> P
    U -- sign / arm --> P
    P --> M[Plan monitor<br/>every closed bar]
    M -- trigger --> R[Risk engine<br/>pure code, 8 gates]
    R --> E[Execution engine<br/>pure code]
    E --> V[(Venue / paper)]
    A -. "no tool exists" .-x R
```

### One object: the trading plan

A plan is a thesis you can be wrong about, written down before the market can talk you out
of it. It **cannot be armed** without all four of:

- **Stated assumptions** — what has to be true.
- **A thesis invalidation, separate from the stop.** A stop is where the *trade* is wrong; an
  invalidation is where the *thesis* is wrong, and it can fire while you're in profit.
- **A hard expiry** — a stale conditional firing weeks later into a different market is the
  worst failure mode of scenario automation.
- **Its own risk budget** — an absolute amount.

Plans are deliberately **not backtested** — a one-shot bet on a path has no meaningful sample.
What replaces backtesting is falsifiability, plus a **calibration record** that scores you as a
planner across many plans.

### Agency: the agent drafts, you sign, code executes

This is structural, not a setting. The agent can research, read order flow, create level
references and **draft** plans. It cannot arm a plan, place an order or choose the venue —
**those tools do not exist**, and a test asserts they never appear. A tool that does not exist
can't be reached by a jailbreak, a prompt injection from a web page, or a refactor that
forgets a check.

## How it compares

| | Autonomous multi-agent frameworks | **Modern Vyapari** |
|---|---|---|
| Who decides a trade | LLM agents debate and decide | **You**, at signing time |
| AI in the order path | Yes | **Never** — pure-code risk + execution |
| Form | Python library / CLI for research | Desktop app for daily use |
| Validation | Backtests | Falsifiable plans + a calibration record |
| Prompt-injection blast radius | Can affect trade decisions | Capped by construction: no order tools |

Projects like [TradingAgents](https://github.com/TauricResearch/TradingAgents) explore how far
autonomous agents can go. Modern Vyapari explores the other end: how useful AI can be while
being structurally unable to lose your money on its own.

## Features

- **Research workspace** — KLineChart charting, 24 indicators, volume profile, anchored
  VWAP/CVD, Binance + Hyperliquid derivatives (funding, OI, basis).
- **Level references** — named price levels (static or derived) the engine resolves every
  bar, point-in-time, so a chart and the engine never disagree.
- **Plan authoring + falsifiability gate** — refusals tell you exactly what's missing.
- **Plan monitor and paper execution** — each armed plan is evaluated every closed bar for
  expiry, invalidation, drift and triggers. A trigger opens a paper position with the branch's
  stop and target, managed intrabar, and the close is reviewed.
- **Two agents** — a **global agent** (the mascot, on every screen) for anything not tied to one
  pair, and a **session agent** (the drawer) bounded by its session's plans, journal and
  memory. Switchable tool catalogue, cost tracking, post-trade reviews and conditional lessons.
- **Any AI provider (in progress)** — the agent loop is the app's, behind a provider port.
  Anthropic is the first adapter; OpenAI, OpenRouter, Gemini and local models (Ollama,
  LM Studio) are next.
- **Simulated and live modes** — separate databases, never blended; simulated by default.
- **Kill switch** — blocks new entries, never blocks exits.
- **Honest quitting** — closing the app says which armed plans and open positions stop being
  watched, with a native fallback so the window can always close.
- **Telegram notifications** — via a transactional outbox, so a message can't claim
  something the database didn't commit.
- **Security-first Electron** — sandboxed renderer, strict CSP, secrets encrypted with the OS
  keychain (`safeStorage`), Electron Fuses hardening, optional Windows Hello gate.

## Status

| Area | State |
|---|---|
| Sessions, research charting, level references | ✅ Working |
| Global agent (mascot) and session agents | ✅ Working |
| Plan authoring, arming, monitoring, paper execution | ✅ Working (proven on seeded bars; live-stream verification wanted) |
| AI providers beyond Anthropic | 🟡 Port built; OpenAI-compatible and local adapters next |
| Calibration record | 🟡 Recording, few entries |
| Live order placement on a venue | ❌ Not built — adapter reports `canPlaceOrders: false` |
| Venue-side protective orders, startup reconciliation, approvals queue | ❌ Not built |
| Strategy specs / backtester UI | 🧊 Frozen (engine kept; shared with plans) |

The roadmap and the reasoning behind every cut are in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Quick start

**Requirements**

- **Node.js 22.13+** (uses the built-in `node:sqlite`)
- **Windows 10/11** is the primary platform. macOS and Linux build and should run, but are
  not yet tested — reports welcome.
- An **AI provider key** for the agent — today **[Anthropic](https://console.anthropic.com/)**.
  The provider sits behind a port, so OpenAI, Gemini, OpenRouter and local models (Ollama,
  LM Studio) are adapters away — see [Contributing](#contributing).
- **No exchange account needed to start.** Simulated mode trades on paper. Connecting
  **[Revolut X](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange)** is optional
  until you go live, and the venue sits behind a port too.

```bash
git clone https://github.com/0ByteBlitz/modern-vyapari.git
cd modern-vyapari
npm install
npm start
```

First launch asks for your AI provider key; connecting a venue (for Revolut X, an Ed25519
signing keypair plus an API key) is optional in simulated mode. Everything is encrypted at rest with the OS keychain (DPAPI on Windows): never
plaintext, never logged, never sent anywhere except the service it belongs to. Market data for
analysis comes from Binance's **public** endpoints — no Binance account needed.

### Scripts

| Command | What it does |
|---|---|
| `npm start` | Build and launch (dev, unpackaged) |
| `npm run build` | Build main + preload (`tsc -b`) and renderer (`vite build`) |
| `npm test` | Run the test suite (Node's native runner, no network) |
| `npm run typecheck` | Typecheck all TypeScript projects |
| `npm run package:win` | Windows NSIS installer (unsigned) via `electron-builder` |
| `npm run package:linux` / `package:mac` | AppImage / dmg — built in CI, not yet run on real machines |
| `npm run inspect-db` | Read-only look at your local database |

## Architecture

Electron + TypeScript · React + Vite + Tailwind v4 + shadcn/ui · `node:sqlite` (zero native
dependencies) · KLineChart · an AI provider port (Anthropic adapter today)

The venue, the data feed and the AI provider each sit behind a port (`src/main/integrations/`,
`src/main/ai/`), so **adding an exchange or a model provider is an adapter, not a rewrite.**
Start with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Start with **[`docs/README.md`](docs/README.md)** — a map of the docs and a glossary of the project's terms.

| Doc | What it's for |
|---|---|
| [`docs/JOURNEYS.md`](docs/JOURNEYS.md) | The seven end-to-end journeys the app serves — read first |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, the integration seam, what runs in the background |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | What's built, what's next, what's frozen and why |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Why each rule exists — the incident behind it |
| [`docs/DESIGN-NOTES.md`](docs/DESIGN-NOTES.md) | Subsystem deep-dives (calibration, modes, lessons, security) |
| [`docs/FRICTION.md`](docs/FRICTION.md) | Known rough edges, honestly listed |
| [`CLAUDE.md`](CLAUDE.md) | Rules for AI coding agents — and a fast orientation for humans |

## Contributing

Contributions are very welcome — read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Good places
to start:

- **AI provider adapters** — one OpenAI-compatible adapter covers OpenAI, OpenRouter, Ollama
  and LM Studio (and Gemini, via its compatible endpoint). Implement `src/main/ai/port.ts`.
- **Venue adapters** — Kraken, Coinbase, Bybit, Binance spot… implement the venue port.
- **UI and UX** — the current focus: one vocabulary per state, a motion system, one component
  set. See *Current focus* in [`docs/ROADMAP.md`](docs/ROADMAP.md).
- **macOS / Linux** — the installers build in CI; run one on a real machine and report back.
- **Live-stream verification** — arm a paper plan on a USD pair and report what happens.
- Anything in [`docs/FRICTION.md`](docs/FRICTION.md).

This repo is built with AI coding agents in mind: [`CLAUDE.md`](CLAUDE.md) and
[`.claude/skills/`](.claude/skills) give Claude Code (and humans) the rules that keep the
order path safe.

**Found a security issue?** Please don't open a public issue — see [`SECURITY.md`](SECURITY.md).

## Disclaimer

Modern Vyapari is experimental software provided for educational and research purposes. **It is
not financial advice**, and nothing in it is a recommendation to buy or sell any asset. Crypto
trading carries a high risk of loss, and automated trading can lose money faster than manual
trading. You are solely responsible for your API keys, your exchange account, your compliance
with your exchange's terms and your local laws, and every trade made with this software. The
software is provided "as is", without warranty of any kind — see [`LICENSE`](LICENSE).

The app is not affiliated with or endorsed by Revolut, Binance, Hyperliquid, TradingView or
Anthropic.

## License

[MIT](LICENSE) © 0ByteBlitz

*Vyapari (व्यापारी) — Nepali/Hindi for "trader".*
