# Modern Vyapari — Roadmap

## Status · 31 October 2026 — read this first

**This file began as a five-week sprint plan to a personal launch on 30 August
2026.** Development paused after 9 August with Sprint 4 (live execution) not
started, and the project went public as open source on 31 October. The sprint
sections below are kept as the plan of record — their reasoning still governs —
but the dates are history. **Nothing in the app can place a real order**: both
venue adapters declare `canPlaceOrders: false`.

*"Owner" in this file and the others means the person using the app — the human
who authors and signs plans. See [`docs/README.md`](README.md) for the glossary.*

### Built

| Area | Items |
|---|---|
| Levels | S1-1 level resolver · S1-3 history re-backfill · S1-4 volume profile + CVD · S1-5 drift detection · S2-2 drawing → reference |
| Plans (the product) | S3-1 lifecycle · S3-2 authoring + falsifiability gate · **S3-3 plan monitor, both halves** — a trigger opens, manages and closes a paper position · S3-5 structural dry-run · S3-6 calibration record |
| Agent | J-1 plan tools (drafts, never arms) · J-2 plan-aware review · J-3 armed plan on the chart and as distances |
| Platform | S2-7 typed event plumbing · S2-8 transactions, frontend glue, `ipc/` split · S2-9 venue layer · N-1 Telegram outbox · simulated/live app modes · conditional lessons |
| Vendor neutrality | **AI provider port** (`src/main/ai/`, Anthropic adapter) · venue `isConfigured()` · **onboarding needs no exchange account in simulated mode** |

### Since going public (31 Oct)

CI on Windows, Linux and macOS · Electron 43 → 45.2.1 (Chromium 156) · credential
vault on async `safeStorage`, with its first tests · fixed: lazy `require` paths
that left the **kill switch** and the Windows Hello unlock throwing at runtime ·
model picker shows key errors instead of loading for ever · Electron download
race in CI · fresh-install startup error · window icon on Linux/macOS ·
Anthropic SDK 1.x · `@types/node` 24 · CodeRabbit review rules · **AI provider port** and
**venue-neutral onboarding** · release builds no longer try to self-publish.

### Open — where contributions help most

**Good first contributions**
- **A-4 Read web-search support up front** — Anthropic's models API now reports `capabilities.server_tools`; replace the reject-and-retry in `ai/anthropic.ts`.
- **Clearer Telegram errors** — surface Telegram's own short reason ("chat not found") without ever echoing the token.
- **Lock-screen error detail** — a failed unlock points at Settings › Diagnostics, which is unreachable while locked.
- **S2-4 Ichimoku offsets test** — pin all five lines against a known reference.
- **L-1 packaging for macOS and Linux** — `package:linux` / `package:mac` build in CI; the installers have not been run on a real machine.

**Vendor neutrality** — no feature locked to one vendor (design: `ARCHITECTURE.md`, *Vendor neutrality*)
- **A-1 OpenAI-compatible adapter** — one adapter, configurable base URL: OpenAI, OpenRouter, Ollama, LM Studio, and Gemini through its OpenAI-compatible endpoint. Must pass `agent-loop.test.ts`.
- **A-2 Provider choice in Settings › Integrations** — per-provider keys in `integration-secrets`, a base URL for local servers, the choice persisted and read by `ai/registry.ts`.
- **A-3 App-side web search** — for providers without a server-side search tool, so search is not an Anthropic-only feature.
- **A-5 Cost per provider** — price tables per adapter; local models declare zero cost; unknown stays *unknown*, never $0.
- **V-1 Connection forms from the auth spec** — render a venue's setup form from its declared `IntegrationAuthSpec`, so a new venue needs no hand-built form.
- **V-2 Venue choice in onboarding** — once a second adapter exists.

**Larger pieces**
- **Venue adapters** (Kraken, Coinbase, …) behind `integrations/venue/port.ts` — declare capabilities honestly.
- **S2-9 feed half** — a feed port, and the last two `source = 'binance'` predicates (down from 18).
- **S2-8 single runtime owner** — six timers across four files today; design in `ARCHITECTURE.md`.
- **S2-1 Fibonacci as data · S2-3 anchored VWAP/profile tools · S2-5 base-rate check · S3-4 Elliott rule-checker.**
- **J-4 `onDrift: reconfirm` queue · N-2 lesson recall · N-3 backup (L-3) · N-4 read-only MCP client.**
- **Telegram inbound commands** — the remote kill switch from `PLAN.md` §7.1 (`/pause`, allowlisted to one chat).

**Maintainer-led, with safety review: Sprint 4** (S4-1…S4-6) — real order
placement, venue-side TP/SL, reconciliation, the approvals queue. Discuss in an
issue before writing code; the hard rules in `CLAUDE.md` are the acceptance bar.

---

## Original plan (29 July 2026)


**Launch = the day this becomes the tool the owner actually trades with, daily.**
Single user, personal money, but held to institutional standards of correctness:
every number measured, every control real, every claim falsifiable.

Written 2026-07-29. Five working weeks.

**Read `docs/JOURNEYS.md` alongside this** (written 2026-08-01), and
**`docs/ARCHITECTURE.md`** for how anything runs when nobody is typing. This file
sequences *work*; that one describes the seven end-to-end **journeys** the work
serves, and names the spine every other journey feeds: **J3 — the plan executes
without me.** The first UI test run stopped dead at §3 not on a bug but on a
seam between two working surfaces, which is the failure mode a sprint list
cannot see. Items prefixed **J-** below came out of that exercise.

---

## 1. What "launch" means, precisely

Vague launch definitions are how a date gets hit with something unusable. So:

**In scope for 30 August — the app must be able to:**

**The product is one sentence (owner decision, 2026-07-30): the owner authors a
thesis; the agent monitors it and acts on it.** Everything below serves that.
It is deliberately *not* "the machine discovers strategies" — see the deferred
table and §2 for what that decision removed.

1. Open to Home and tell the owner what happened while it was closed, with no
   manual step to get data flowing.
2. Support a full research session in the vocabulary a thesis is written in:
   Ichimoku, Fibonacci with editable ratios, Elliott counts, anchored VWAP,
   fixed-range and anchored volume profile, CVD. These exist so a plan can *name*
   a level and the engine can resolve the same one — not to be a charting tool.
3. Let the owner author a **scenario plan** for a thesis, and monitor it
   mechanically — trigger, invalidation, expiry, OCO branches. **This is the
   core of the product, not a feature beside the strategy engine.**
4. Run those plans **in paper** continuously and unattended, with a review agent
   and an accumulating calibration record — the owner's own hit rate by thesis
   type.
5. Run in **two modes, chosen at launch** — simulated or live (owner decision,
   2026-08-05). Simulated needs no credentials and has no route to a real order;
   live places real orders on Revolut X, every position carrying a venue-side
   stop, every fill reconciled against the venue. **There is no promotion
   ladder**: a plan is armed in whichever mode the app is running, one decision.

**Explicitly NOT in scope for 30 August** (and each for a reason, not for time):

| Deferred | Why |
|---|---|
| `live_auto` (unattended real money) | Requires accumulated supervised evidence that cannot exist before launch day. Promoting on schedule rather than on evidence would defeat the entire lifecycle. |
| Footprint / delta-at-price | Needs `@aggTrade` plus trade-level storage — a different tool with a different storage bill (plan §17.8). Bar CVD covers the actual use. |
| Theming, light mode, locale (§16) | Scheduled after the surfaces settle, deliberately. |
| Multi-venue, notifications outside the app | Scope creep against a single-user tool. |
| **The strategy path — authoring specs, backtesting them, the promotion ladder, auto-strategies armed to paper and promoted to live** | **Owner decision, 2026-07-30; removed from every surface 2026-08-05.** The freeze was not enough — Workbench, the agent's `create_strategy`/`run_backtest` tools and the dashboard panel all survived it, so the app kept presenting two answers to the same question and both the owner and the agent kept reaching for the wrong one. A soft guard (the prompt) against a hard affordance (the tool) loses. The surfaces are gone; the engine code stays, shared and frozen. The product is "I plan the trade, the agent acts on it". The strategy machinery was accreted around a different product — one that discovers and validates its own edge — and it is not the one being built. Measurement backed the call: 90 backtests across the top-15 coins found exactly one spec clearing the gate, at +0.03% out-of-sample, meaning a bot gated on validated edge would simply never act. **Frozen, not deleted** — the fill model, condition evaluator, level resolver, paper engine and risk engine are all shared with the plan path, and ripping the lifecycle out before launch would be churn with real regression risk. The lifecycle states, promotion ladder, backtest-vs-paper divergence card and `create_strategy` stay in the code, unused, until after launch. |
| Charting UX parity with TradingView | **Owner decision, 2026-07-30.** This is not another charting tool. Research exists so the *engine* can resolve the same levels the trader looks at, and so the agent can reason about them — not to win on crosshairs, drawing ergonomics and shortcuts. TradingView remains a legitimate analysis surface; the agent already reads it (`read_browser_page` / `screenshot_browser`). Rendering *correctness* is still in scope — a profile drawn over the price axis is a defect. Charting *comfort* is not. |

**The launch state is therefore: a complete decision-and-execution-assist
terminal, trading real money under human signature — and the signature is given
at ARMING, not at the fill** (owner decision, 2026-08-09).

That decision resolves a contradiction these documents carried for a week. §1
said "under human signature" and S4-4 said "sign each intent", while J3 — the
spine — says *the plan executes without me* and exists to remove the owner from
the moment of temptation. Both cannot hold when a plan triggers at 3am: either
it waits and J3 fails, or it fires and nothing was signed.

**Arming already is the signature.** It is a bounded, specific authorisation —
this branch, this trigger, this entry, this stop, this budget, expiring on this
date — and it cannot happen until the falsifiability gate passes. When the
trigger fires, code executes an instruction the owner already signed. That is
not `live_auto`, which is *the machine deciding what to trade*; here the human
decided exactly what to trade, in advance. It is what makes J3 possible at all.

The approvals queue is therefore **not** "confirm every fill". It is for the one
case that genuinely needs a person: **the plan can no longer be executed as
signed** — a level that drifted past tolerance, an entry the geometry refuses, a
risk-engine rejection. What was signed no longer matches what is in front of the
engine, so the authorisation has lapsed.

Unattended automation of *what to trade* remains a post-launch graduation.

---

## 2. The binding constraint (rewritten 2026-07-30 — the old one no longer applies)

**This section used to say the 14-day paper gate could not be compressed, and
everything else in the plan yielded to it.** That gate is a *strategy* gate — §4
states it per-armed-strategy — and the strategy path is now out of scope. A
**scenario plan's gate is falsifiability, not calendar time**: explicit
assumptions, invalidation separate from the stop, a hard expiry, and a smaller
risk allowance (plan §17). A plan that satisfies those can reach
`live_supervised` the day it is authored. It can never reach `live_auto`, and
that restriction stands — unattended automation needs a validated edge, and by
construction a plan does not have one.

So the calendar pressure is gone, and it is worth being clear that this makes 30
August *more* reachable rather than less.

**What binds instead is a serial dependency, and it has no slack trick:**

> **references → plans → live.** A thesis is authored in terms of levels, so the
> semantic reference layer (S2-1, S2-2) must exist before plan authoring (S3-2)
> is meaningful; the plan monitor (S3-3) must run in paper before it is pointed
> at real money (Sprint 4). Nothing here can be parallelised by working harder,
> and every day lost in the reference layer is a day Sprint 4 starts later.

The one calendar-ish item left is **L-5's 72-hour soak**, which must start by 27
August. That is now the latest immovable date in the plan.

**Still true, and now the reason S1-2 survives at all:** the paper engine has
never executed a single position — `paper_positions` has zero rows. The plan
monitor rides that exact engine (S3-3: *no second fill model, ever*). Finding out
in Sprint 3 that it does not work would be far worse than finding out now.

A second, smaller version of the same problem — **now closed, and left here
because the shape of it recurs.** CVD and the profile buy/sell split only exist
for candles carrying `taker_buy_volume`, which arrived with schema v11; every bar
cached before it read `NULL`, correctly meaning *unknown*, and history heals only
when refetched. That made the re-backfill early work (S1-3), and it has been
done: measured 2026-07-30, **all 10,210 cached `binance` bars carry a known
split, zero unknown.** The general lesson stands for anything added to the candle
row later — a new column is not retroactive, and nothing looks broken while it is
missing.

---

## 3. Sprint plan

Ordering principle: **risk-ordered so that slippage degrades gracefully.**
Live execution is the highest-risk work and sits in Sprint 4 on purpose — if it
slips, launch still delivers a usable research/paper/planning terminal instead of
a half-finished order path pointed at real money.

### Sprint 1 · 30 Jul – 5 Aug — *Make levels real*

Goal: derived levels can be resolved, and the paper engine is proven to execute.
*(Was "start the clock" — that clock was the strategy paper gate, which is no
longer in scope. Retitled 2026-07-30.)*

- [x] **S1-1 Level resolver.** `insights/level-resolver.ts` — DB-facing,
      incremental, point-in-time. Resolves `PriceLevel` → number for the sources
      built in §17 step 2. Wire into `paper-exchange` per bar; then **lift the
      arming guard** in `setStrategyState`. *(Done 2026-07-30. Guard narrowed
      rather than removed — Ichimoku and Fib sources are still refused until
      S2-4 / S2-1. Also fixed: volume-profile bins were anchored to the window's
      low, so a new low moved the POC with no volume having changed.)*
- [x] **S1-2 Prove the paper engine executes.** **Re-specified 2026-08-05**
      (there are no strategies to author, so "one throwaway strategy" was no
      longer a thing that existed) and **done the same day**: a plan trigger now
      opens, manages and closes a real position, through `persistEntry` — the
      same fill model, fee and balance arithmetic the backtester uses. The
      watch-only assertion in `plan-watch.test.ts` failed on the first run of
      the change, which is what it was written for.

      **Where a plan differs from a strategy, and why.** Its **stop does not
      ratchet** — a strategy repeats so its stop is a distance and trailing is
      part of the rule being tested; a plan is one bet and its stop is a price
      the owner signed, so moving it would be trading a geometry they never
      approved. The **fill is the bar's close**, never the approved entry level:
      if price gapped through it, filling there would invent a price the market
      never offered. **Size is the plan's own absolute budget**, because "5% of
      whatever I happen to have" is not a number anyone agreed to at authoring
      time.

      **Two entries are refused**, both from the owner's own numbers rather than
      an invented tolerance: a fill at or below the branch's stop is a trade
      already dead, and one at or above its target is paying for a move that has
      happened. The branch is still recorded as **triggered**, because it fired —
      a trigger that could not be acted on is a different fact from one that
      never fired, and S3-6 has to keep them apart.

      **Still unproven, and it is the part that matters now:** this has run
      against seeded bars, never against the live stream. The remaining question
      is a real armed plan on a real feed.

      **The old strategy recipe is kept below purely as the measurement record** —
      it is why the strategy path was cut, and it should not be re-derived.

      *Superseded detail:*
      *(Demoted from CRITICAL PATH 2026-07-30 — the strategy path is out of
      scope, so this is no longer the item everything else yields to.)*

      **Why it survives the cut.** The plan monitor (S3-3) runs on the paper
      engine's execution path — *no second fill model, ever* — and that engine
      has never executed a position. This item exists to prove it does: fills
      matching the backtester, protective exits firing, the review agent
      writing a review, `distillLessons` folding it into context, equity
      snapshots that aren't fiction. **One strategy is enough, and it does not
      need to be profitable — it needs to trade and to be honest about losing.**
      Retire it once plans are running in paper.

      **Ready to author** (measured, not guessed): `TRX-USD`, RSI(14) crossing
      up through 40, exit above 70, 4H, 10% sizing, 4% stop / 8% target. Over
      5,000 Binance 4H bars: 45 in-sample trades at +3.16% (PF 1.33), 16
      out-of-sample at **+0.03%** (PF 1.01), against +202% buy-and-hold. It
      carries an overfitting warning and that warning is correct — leave it
      visible. TRX is listed on Binance and tradable on Revolut X, so both
      feeds work. Author it through the app's own `create_strategy` /
      `run_backtest` so the lifecycle, audit log and backtest row are real.

      **Evidence behind the scope cut (2026-07-30).** 90 backtests — 6 generic
      oscillator specs × the top 15 non-stablecoin coins by live market cap,
      833 days of Binance 4H each (5,000 bars), run through the project's own
      `runBacktest`. **Exactly one cleared ≥30 trades with a profit factor
      above 1 in both walk-forward halves**, and its out-of-sample return was
      **+0.03%** — zero. 87 of 90 were negative out-of-sample; the two that
      weren't were negative *in*-sample, which is the shape of noise. **No spec
      beat buy-and-hold on its own coin** (ZEC returned +2,086% over the window
      while every ZEC spec lost). **Fees dominate**: XLM adx-trend paid $1,288
      in fees to lose $837. It is not the coin — BTC, XRP, TRX and ZEC all had
      tradeable windows and these specs lost anyway.

      **State measured the same day:** four strategies exist, all `retired`,
      all on session 1 (ARB-USD) which is **archived** — none armable as-is,
      since strategies are session-scoped and the active session is #4. Three
      of their four backtests produced **0 trades**, killed by a hardcoded
      `price between [0.0775, 0.0795]` band — a static number describing the
      day it was written, which is the §17 `PriceLevel` problem in its crudest
      form. Avoid absolute price bands in an S1-2 spec.
- [x] **S1-3 Re-backfill candle history** for every traded pair/interval so
      `taker_buy_volume` exists. Verify CVD coverage reports 100% afterwards.
      *(Tooling done 2026-07-30: `data/candle-repair.ts` measures coverage and
      repairs it, exposed in Settings › Data & feeds. **Run confirmed the same
      day, measured against the real database:** 10,210 cached bars, all
      `source='binance'`, **zero** with a NULL or empty `taker_buy_volume` —
      across all 15 symbol/interval pairs including the full ARB-USD set (1D
      back to Nov 2023, 4H back to Jan 2026). CVD and the profile buy/sell
      split are therefore available over the whole cached history, not just
      post-v11 bars.)*
- [x] **S1-4 Volume profile + CVD on Research**, rendered from main's computed
      values over IPC — never recomputed client-side. *(Done 2026-07-30. The
      registered CVD indicator turned out to be computing `close >= open ?
      +volume : -volume` — candle colour, not the aggressor split — and is
      replaced by a lookup of main's values.)*
- [x] **S1-5 Drift detection.** Implement `driftTolerance` / `onDrift` evaluation
      + the "did the trigger fire because price moved, or because the level
      moved?" comparison in the review payload. *(Half landed with S1-1: the
      resolver evaluates `pct` / `atr` / `binChange` and the paper engine
      honours `invalidate`. Completed 2026-07-30: schema v12 records each
      level's armed vs. at-entry value on the position, and the review agent
      is told to ask whether price moved or the level did. Still owed:
      `reconfirm` needs the operator queue, which arrives with S3-2.)*
- [ ] **S1-6 Daily-use log.** Use the app for a full trading day. Write friction
      down; do not fix it yet. *(Log started 2026-07-30: `docs/FRICTION.md`.
      First entry — Research is not yet the surface analysis actually happens
      on; the owner used TradingView instead.)*

**Exit:** the paper engine has executed and reviewed at least one position.
Profile + CVD visible on Research. Resolver tested for point-in-time correctness.

### Sprint 2 · 6 – 12 Aug — *The plan spine*

**Reordered 2026-07-30.** Plans were Sprint 3 when the strategy path was the
product. They are the product now, so the spine moves first and the richer
level vocabulary follows it. **Item IDs are deliberately unchanged** — they are
referenced from CLAUDE.md and from commit messages, and renaming them to match
a new sprint number would break that trail for no gain.

Goal: a thesis can be written down, armed, and mechanically monitored.

- [x] **S3-1 `trade_plans` table + lifecycle** (DRAFT → PLANNED → TRIGGERED →
      CLOSED / EXPIRED / INVALIDATED). *(Moved from Sprint 3. Done 2026-07-30:
      schema **v13** adds `trade_plans` + `plan_branches`; `main/plans/trade-plan.ts`
      holds the types, the transition table and `validatePlan`, which enforces
      all four falsifiability elements with no flag to skip it. `PlanState` is
      in `shared/ipc-types.ts` and **has no `live_auto` member** — the state not
      existing is a stronger guarantee than a check that can be forgotten.
      `expired` and `invalidated` are separate terminal states because the
      calibration record's most useful distinction is "never fired" vs. "fired
      and was wrong". Branches are a child table, not JSON, since the monitor
      asks per-branch questions. 132 tests green.)*
- [x] **S2-2 Promote drawing → plan reference.** Semantic references persisted
      (anchors/ratios/window/params); the chart renders *from* them. **This is
      the authoring gesture** — it is how a thesis names a level, so it comes
      before the authoring UI rather than after it. *(Main side done
      2026-07-30: schema **v14** `level_references`, `plans/level-reference.ts`
      (pure drawing→meaning mapping) and `plans/level-reference-service.ts`
      (persistence + promote). Horizontal drawings become static levels; a
      rectangle becomes a fixed-range volume profile and is **refused without an
      explicit bin width**. Sloping lines, fib, wave counts and advisory tools
      are each refused with their own reason. Renderer half landed the same
      day: IPC `levels:list|promote|delete`, a references panel on Research
      that promotes drawings and **renders every refusal rather than swallowing
      it**, and static references drawn as locked price lines. Derived
      references are listed but deliberately NOT drawn — their value depends on
      a window the resolver owns, and having the chart compute its own line
      would repeat the fake-CVD mistake. Deleting a drawing detaches its
      reference instead of destroying it.)*
- [x] **S3-2 Plan authoring UI** — assumptions, OCO branches, thesis invalidation
      (separate from the stop), hard expiry, risk budget. Diff of concrete
      numbers shown before arming. *(Moved from Sprint 3. **Service half done
      2026-07-31:** `plans/plan-service.ts` — CRUD plus the arming step, which
      is the operation that matters. Arming runs the gate, resolves every
      derived level to a real number via the new `levelResolver.resolveAtArm`,
      writes those into `resolvedAtArm`, and **refuses when a level cannot be
      computed** rather than storing a placeholder. It returns the resolved
      values so the UI can show concrete numbers before committing — that
      return value *is* the "diff before arming". A draft saves without the
      gate (thinking is not committing); an armed plan cannot be edited or
      deleted. **UI landed the same day:** a per-session **Plans** surface
      (`plans-page.tsx`) with a thesis/assumptions/invalidation/expiry/budget
      form, OCO branches, entry-stop-target levels chosen as either a typed
      price or a **promoted reference** from S2-2, and an Arm action that
      renders the gate's refusals and the resolved level values. **The gate is
      not re-implemented in the renderer** — the page calls `armPlan` and shows
      whatever comes back, because a UI copy of the rule that decides whether
      unvalidated conviction reaches money would be a second definition of the
      one thing that must have exactly one.)*

      **Entry points, of which "promote alert → plan" is one** (added
      2026-07-30). A plan can be started from a drawing (S2-2), from a level
      resolved on Research, or **from an alert that just fired** — you notice
      something cheaply, and only when you decide it is worth capital does the
      falsifiability gate apply. **The gate belongs at the moment of
      commitment, not on every idle curiosity.**

      **Alerts stay a separate object; this is a bridge, not a merger.** The
      temptation once S3-3 exists is to notice that an alert and a plan trigger
      are the same evaluation and fold one into the other. Do not. A plan cannot
      arm without all four falsifiability elements; nobody writes a thesis and
      an invalidation level to get a ping when BTC touches 70k. Adding a
      gate-skipping plan variant to accommodate that would make **"armed" mean
      two things** — does this place an order or not — which is exactly the
      ambiguity §17 avoided by giving plans their own table instead of a `type`
      flag on `strategies`, and exactly what the no-ambiguous-states rule
      forbids. Their consequences differ, so they stay different objects.

      What *is* duplicated is the subscription and scheduling layer, not the
      evaluator — `alert-engine` already shares `evaluateConditionGroup`, which
      is why alerts are backtest-replayable. Deduplicating the refcounted
      candle subscription and closed-bar dispatch is **S2-7(a)**, which is
      already scheduled ahead of S3-3 for this reason. One mechanism, two
      consumers.

      *Note: with the strategy path frozen, an alert is now the only
      zero-commitment way to watch a level, so it got more important, not less.*
- [x] **S2-7 Event plumbing, scoped.** *(Both halves done 2026-07-31: (a) one `ListenerRegistry` replacing four hand-rolled registries; (b) `events/outbound.ts`, one typed main→renderer channel replacing twelve scattered `webContents.send` sites, with `emitError` as the only way to put a failure on a channel.)* Two jobs, both before S3-3 adds a second
      consumer of candles:
      *(Pulled into Sprint 2 on 2026-07-30: S3-3 moved forward, and this item's
      whole justification is that it must land before S3-3 adds a second
      consumer of candles. It follows S3-3's dependency, not its old sprint.)*
      **(a)** Consolidate the four hand-rolled listener registries
      (`binance-ws`, `alert-engine`, `paper-exchange`, `kill-switch`) into one
      typed emitter helper — deduplication, not re-architecture.
      **(b)** One typed **outbound** channel for main → renderer, replacing the
      seven scattered `webContents.send` sites, so sanitisation is enforced in
      one place instead of remembered in seven. This is the real win: the
      boundary is currently per-channel, and chat streaming already leaked raw
      API errors past it once.
      **Rule, non-negotiable:** the bus carries *notifications of things that
      already happened*. It must never carry a step in a sequence that decides
      money. The paper engine's per-candle order (protective levels on every
      tick → closed-bar signals exactly once) is load-bearing, and
      `EventEmitter` fan-out has no ordering guarantee between listeners — a
      plan monitor and the paper engine racing on the same candle could open a
      position while caps are still being checked. Execution stays direct calls.
      *(A first attempt was deleted on 2026-07-29: it sat beside the direct
      wiring rather than replacing it, logged every payload at debug on a
      per-second path, and its event map included `order:intent` /
      `order:executed` — precisely the traffic this rule forbids. Recoverable
      from f6e86db, but re-derive it against the rule above.)*
- [x] **S3-3 Plan monitor** in the engine: trigger evaluation, drift guard,
      expiry sweep. Reuses the paper engine's execution path — no second fill
      model, ever.

      **Applying half done 2026-08-05 (with S1-2).** The paper engine calls the
      monitor directly on every closed bar (`evaluatePlansOnBar` in
      `paper/paper-exchange.ts`), and a triggered branch opens a plan-owned
      position via `openPlanPosition` — sized from the plan's budget, refused
      past its stop or target, blocked by the kill switch. Covered by
      `plan-execution.test.ts`. The history below is kept as written.

      **Wired watch-only, 2026-08-01.** Until this, `plan-monitor.ts` was
      imported by **nothing but its own test** — every armed plan in the
      database read "armed" and no code path evaluated it. The owner found it
      the only way it could be found: they armed a plan and went looking for
      what it was doing.

      The wire splits along the roadmap's own risk line — **watching protects
      you, acting risks something.** Expiry, thesis invalidation and drift are
      evaluated on every closed bar and genuinely transition the plan; a trigger
      is **recorded with a null `position_id` and opens nothing**, because S1-2
      has not proven the engine executes. A fired branch with no position is a
      real state, not a placeholder, and it is what lets S3-6 measure trigger
      rate before a single position has ever existed. `plan-watch.test.ts`
      asserts the boundary, so wiring entry without deliberately removing that
      assertion fails.

      **Two defects found by wiring it**, both invisible while the monitor was
      unreachable: `compileIntent` emitted price conditions with **no `field`**,
      so the lookup key was `price:` while the engine only ever publishes
      `price::close` — every plan trigger and invalidation would have evaluated
      false for ever while the plan displayed as armed. And `armPlan` did not
      reload the engine, so a plan armed mid-session stayed unwatched until
      restart. *(Moved from Sprint 3. **Decision layer done 2026-07-31:**
      `plans/plan-monitor.ts` is pure — given a plan, a bar and two injected
      lookups it returns what should happen. The precedence is the design and is
      fixed: **expiry → invalidation → drift → triggers**, because a bar can
      satisfy several at once and which one wins is what lands in the
      calibration record. OCO cancellation of siblings is decided here.
      **Still owed: the applying half.** A triggered branch does not yet open a
      position — now by an explicit flag rather than by absence — and it could
      not before schema v15 — `paper_positions.strategy_id`
      is `NOT NULL REFERENCES strategies(id)`, so a plan-opened position has
      nowhere to live. The monitor must also be invoked as a **direct call from
      the paper engine**, not a second candle subscriber: they share
      `session.paper_balance`, and `EventEmitter` fan-out gives no ordering
      guarantee between them.)*
- [x] **J-2 Make `review.ts` plan-aware.** *(From JOURNEYS.md J3. Done
      2026-08-01.)* **What it was:** the review payload declared
      `strategy_id: number` and called `getStrategy(pos.strategy_id)`, but
      schema **v15** lets a position be owned by a plan branch with
      `strategy_id` NULL — so a plan-opened position would have closed and
      **never been reviewed**, silently, taking S3-6's only input with it. The
      review is the "and the record says why" half of the spine journey.
      **What landed:** `resolveOwner`
      walks position → branch → plan, and **a plan is judged against its thesis
      and assumptions, not against a spec's intent** — that is why the prompt
      was split rather than parameterised. The shared rules (arithmetic, the
      exit-reason rule, the did-price-move-or-did-the-level question) stay in
      one block so they cannot drift; the tails differ because the questions
      differ. The plan tail enumerates the four right/wrong × profit/loss cases
      explicitly, because the diagonals are the informative ones and a reviewer
      left to itself scores the PnL and calls the assumptions vindicated —
      exactly the self-flattery the calibration record exists to prevent.
      **Schema v16** adds `journal.ref_plan_id`: the review *is* the record
      S3-6 derives from, so a plan's review must be findable by plan rather
      than by searching tag text. Migration tested against a real on-disk v15
      database, per the v15 lesson.
- [x] **J-3 Render an armed plan — two renderings, one source of truth.**
      *(From JOURNEYS.md J2, 2026-08-01.)* **The numeric half is done the same
      day:** the session dashboard's candle chart was deleted (owner decision —
      Home answers "what is this pair doing" before it is asked and Research
      answers it properly, so it was a worse Research among status panels) and
      replaced by `plan-watch-panel.tsx`, which shows armed plans as
      **distances**: gap to each trigger, stop and target, time to expiry, which
      branch has fired. **Derived levels show `resolvedAtArm` and say so** —
      the renderer must never resolve a level itself, and an unlabelled stale
      value would read as a live one. Distances measure against the **analysis**
      feed, never the venue quote, since that is the feed the levels resolved
      from.

      **Geometric half done the same day**, after the owner opened the bookmark
      panel and asked the right question: *"shouldn't it list active plans, and
      when I click, add drawings based on the plan?"* It listed only
      **references** — the authoring layer, drawing → meaning — which is showing
      the ingredients above the thing they are for. The panel now leads with
      armed plans; toggling one draws its trigger, entry, stop, targets and
      thesis invalidation as locked price lines **labelled by role**, and
      switches on any chart indicator its derived levels are built from.

      **The lines are a view of the plan, never ink.** They are not written to
      `chart_drawings`, which answers "does the drawing reset if I turn it
      off?" — nothing was saved, so there is nothing to reset. Persisting them
      would be a second definition of a level the plan already owns: stale the
      moment the plan changed, and outliving the plan if it were deleted.
      Indicators are removed on hide **only if the overlay switched them on**,
      never one the trader enabled themselves. Derived levels draw at
      `resolvedAtArm` — main's number — labelled `at arm`; that is the chart
      rendering a committed value, not computing its own. The owner's expected entry point is *"select an armed plan,
      see its levels laid over the chart with alerts"* — the reverse of the
      built gesture (draw → promote → reference → author). Both directions are
      legitimate; only the one the owner did **not** reach for exists, and its
      absence blocked 25 checklist items. **Constraint: the chart renders
      main's resolved values, never its own** — a renderer that computed a
      derived level would repeat the fake-CVD mistake exactly. Static levels
      draw directly; derived ones draw from the resolver.
- [ ] **S2-1 Fibonacci as data.** Ratio sets, `basis: linear | log`, per-reference
      overrides, one editor, one persisted default. Deletes `FIB_EXT_LEVELS`,
      `FIB_CIRCLE_LEVELS`, `GANN_RATIOS` and replaces KLineChart's baked-in set.

**Exit:** a plan can be authored against a named level, armed, and monitored in
paper. Drift, expiry and OCO cancellation each proven by test.

### Sprint 3 · 13 – 19 Aug — *Thesis vocabulary and calibration*

Goal: the levels a thesis is written in are all resolvable, and the app starts
keeping score of the owner's own assumptions.

- [ ] **S2-3 Anchored VWAP + anchored / fixed-range profile as chart tools**,
      bound to main's values, with explicit anchor selection.
- [ ] **S2-4 Ichimoku offsets test + Research rendering.** Pin all five lines to
      their correct bar offsets — Senkou forward, Chikou back. An off-by-26 here
      backtests beautifully and is fiction.
- [ ] **S3-4 Elliott rule-checker** as a mechanical invalidation source (wave 2
      not beyond wave 1's origin; wave 3 not shortest; wave 4 not into wave 1).
- [x] **S3-5 Structural dry-run.** **Done 2026-08-05.** `plans/plan-dryrun.ts`
      replays `evaluatePlan` — the live monitor's own decision layer — over
      cached bars and answers the question the falsifiability gate never asked:
      the gate proves a plan can be **wrong**; this proves it can **happen**.

      Five verdicts, and the ones that matter are the failures: *never fires*
      (arms cleanly, sits there forever, nothing anywhere says why), *fires
      constantly* (a standing condition wearing a thesis), and *already over*
      (the invalidation is true right now, so arming it would end it on the next
      bar). Branch triggers are evaluated **independently**, not through the
      monitor's first-match-wins path, or an unreachable branch would hide
      behind a greedy sibling.

      **Structural, never statistical, and the type has nowhere to put a PnL.**
      A dry run is the obvious side door through which backtesting walks back
      into a product that removed it, so the guard is the shape of the return
      type and a test that fails if a win rate ever appears in it.

      Also lands `insights/bar-values.ts` — one definition of what a condition
      sees on a bar, shared with the paper engine, so the dry run cannot judge a
      plan against different keys than the live monitor will.
- [x] **S3-6 Plan calibration record.** **Done 2026-08-05.**
      `plans/calibration.ts`, grouped by assumption **tag** and cross-session by
      default. §17's phrasing is the design: **statistics move from the plan to
      the planner.** A plan is a one-shot bet with no sample; the person writing
      them repeats, and whether "range reclaim holds" tends to hold is a real
      accumulating question. With the strategy path gone this is the only
      evidence the app accumulates at all.

      **Three ways the number could have lied, each closed:**

      - **An unwatched window counted as a miss.** A plan that never triggered
        because the laptop was shut records identically to one where price never
        came — in the *flattering* direction, since a thesis that never got its
        chance is not a thesis that failed. Plans whose armed→resolved window
        overlaps a `monitor_gap` are excluded and reported separately. This is
        what the heartbeat was built for.
      - **A rate from four plans.** Below `MIN_SAMPLE` the rates are **null**
        and the counts stand alone. "3 of 4 = 75%" on a screen reads as a
        finding about the thesis rather than about the sample.
      - **Counting plans that have not finished.** `planned` has not had its
        chance; including it would make the record look worse the more actively
        it is used.

      **Captured share is about the forecast, not the money**:
      `(exit − entry) / (target − entry)` answers "when I say 130, how far do I
      usually get?", which no PnL figure gives — the same $50 means something
      different against a 100-point forecast than a 60-point one.

      Surfaced on the **Plans page above the plans**, because the moment it
      matters is the moment before writing the next one. Exposed to the agent as
      `get_calibration`, carrying the honesty rules in the payload — a model
      left alone with counts and a null rate will helpfully compute the
      percentage itself.
- [x] **J-1 Agent plan tools.** **Done 2026-08-05, both halves.** Awareness first — and it was
      reordered on the owner's prompting, correctly. The agent had sixteen tools
      and **not one could observe a plan**; `buildSessionContext` injected the
      pair, trade stats, journal and lessons but nothing about what was armed.
      That is why "paper trade the armed plan" produced an answer about
      strategies: not missing vocabulary, missing sight.

      **Read before write, because write-without-read is worse than neither** —
      an agent that can author a plan but cannot list the ones already armed
      drafts a duplicate of the plan it cannot see. Landed: `list_plans` and
      `get_plan` (session-scoped, read-only, no arming tool and there must never
      be one), plus armed plans in the session context so the agent knows
      without being asked — a tool is only called when the model already
      suspects there is something to look at. Both surfaces state the execution
      boundary explicitly: expiry, invalidation and drift act; a triggered
      branch opens nothing. Derived levels report `resolvedAtArm` **labelled as
      the value at arming**, never as live — the model is a reader, and the
      renderer's rule applies to it.

      **Write half landed the same day.** `create_level_reference` (static
      levels only — a derived level carries a window and a drift policy that
      decide whether an armed plan keeps trading, which is not a choice to infer
      from a sentence in chat), `list_level_references`, and `draft_plan`.
      **`draft_plan` saves as `draft` and can never arm** — arming is the
      owner's signature. The test that guards this pins the *invariant* rather
      than the tool list: no `arm_plan`, `update_plan`, `delete_plan`,
      `transition_plan`, `set_venue` or `place_order` may ever appear, so the
      guarantee survives every future addition.

      **A drafted plan must pass the same gate a hand-authored one does**, and a
      test arms one to prove it — a tool producing plans that look real and
      cannot run would be worse than no tool.

      **Found while building it:** a plan without a thesis invalidation cannot be
      stored at all. `createPlan` compiles conditions up front and refuses a
      non-numeric one rather than storing an empty group (the S2-8 fix, since an
      empty group later reads as a *missing* invalidation three steps from its
      cause). So `draft_plan` requires it and **refuses with the distinction
      spelled out** — a stop is where the trade is wrong, an invalidation is
      where the thesis is. That turns a storage constraint into the question the
      gate exists to force.

      Two further tools closed the remaining blind spots: **`get_order_flow`**
      (CVD and the volume profile — the app computes both and the agent could
      not see either, despite §17 existing so a thesis could be written in that
      vocabulary) and **`get_app_capabilities`**, read from the venue adapter, so
      the agent stops answering from assumption about what happens on a trigger.
      Assuming a position is protected when it is not is the most expensive
      thing it could get wrong.
- [x] **N-1 Reach the owner when they are away — Telegram + outbox.**
      *(Owner decision, 2026-08-05, after checking the notification-infrastructure
      category.)* **Outbox done**: schema **v17** `notifications`, written in the
      **same transaction** as the state change it describes, with a `dedupe_key`
      derived from the event rather than the clock. That makes the two failures
      that would destroy trust in the away-flow structurally impossible rather
      than guarded against — *traded but never told* (process dies before the
      send, nothing records a message was owed) and *told twice* (send succeeds,
      the mark-sent write fails, a retry re-alerts). Standard in payments for
      exactly these reasons.

      Telegram chosen over Knock / Courier / Novu / SuprSend after checking them:
      that category is built for **many recipients** — preference centres,
      digests, per-user routing — and there is one recipient here. Telegram is a
      single HTTPS POST, **zero dependencies**, arrives on a phone. Token and
      chat id live in the encrypted per-integration store.

      **Settings › Notifications** is the visible half, and it shows the outbox's
      health, not just an on switch: waiting / sent / gave up, with the abandoned
      messages listed. A message the app gave up on is by definition the one the
      owner cannot learn about any other way, so it is on screen rather than in a
      log file. The token is write-only from the renderer; the chat id is
      returned, because it is an address rather than a secret and a wrong one
      fails silently from the owner's side. Messages queued before the channel is
      configured are delivered when it is — the page says so, rather than leaving
      the owner to assume they were lost.

      **Not yet wired to the plan monitor's own transitions in live use** — the
      drafts exist in `paper-exchange.ts`; what remains untested is a real
      trigger, which waits on plan execution (S1-2).
- [ ] **N-2 Lesson recall that actually recalls — `sqlite-vec` + temporal memory.**
      FTS5 finds "range" if the owner wrote "range"; *"have I traded a setup like
      this before?"* is a semantic question it answers badly. `sqlite-vec` is a
      pure-C extension keeping embeddings in the same file — no server. Pair it
      with the idea taken from the agent-memory category (Zep scores 63.8% vs
      Mem0's 49.0% on LongMemEval on the strength of it): store **when a lesson
      was formed and what was believed at the time**, not just its text. For
      trading that is not a nicety — "I believed the shelf was real supply on 14
      June, and it broke" is a different and more useful record than "shelves
      sometimes break", and it feeds S3-6 directly.
- [ ] **N-3 Litestream for L-3.** Continuous streaming SQLite backup to object
      storage. Single binary, **no code change, no library**. Closes the launch
      gate's *"backup taken and restored once — an untested backup is a belief,
      not a backup"*, which is currently unbuilt against a database holding the
      owner's whole financial history.
- [ ] **N-4 MCP client, read-only.** The registry passed ~9,650 servers and
      vendors now ship market data over MCP directly, so advanced data no longer
      means one hand-written adapter per vendor. **Read-only data servers only:**
      an MCP server is third-party content reaching a model that holds
      `draft_plan` and `write_journal`, which is the prompt-injection surface
      `fetch_url` already lives under — same rules, never a trigger source. Do
      this when a specific source is named, not speculatively.
- [x] **A plan resolves into the journal, and finished plans get their own
      tab.** *(Owner request, 2026-08-05.)* The ask was "how do I delete an
      expired plan, and can the agent do it?" — the answer to the second half is
      **no, and to the first half mostly no**. Expired plans *are* the
      calibration record: an expired-unfired plan is the **denominator** of the
      trigger rate, so deleting the ones that never fired makes the rate count
      only the ones that did. It rises, with nothing that would notice — this
      project's recurring defect landing on the one number whose job is honesty.
      Deletion also stays off the agent for the reason
      `agent-plan-awareness.test.ts` exists: irreversible, and aimed at the
      owner's own record.

      **The journal half of the request was right and exposed a real gap.**
      `review.ts` only ever ran on a **closed position**, so a plan that expired
      or was invalidated without firing produced no written record at all —
      backwards, because that is the most informative outcome the calibration
      record has. Schema **v18** adds `trade_plans.reviewed`;
      `reviewResolvedPlan` writes a closing note against `ref_plan_id`, with its
      own prompt because the question is different: *why did this not happen?*,
      not *how did it go?* It is told whether the window was **watched
      throughout** — without that the model states confidently that the trigger
      never came when the truth is nobody was looking.

      Clutter is answered by an **Active / Finished tab**, not a delete button
      or a hidden flag. Nothing leaves the record.

- [ ] **J-4 `onDrift: reconfirm` operator queue.** *(Owed since S1-5; J4 has no
      surface without it.)* Today drift is mechanical and silent-by-default —
      the plan stops trading on a stale level and a line goes in the log. The
      queue is where the agent explains a drift **in thesis terms** and proposes
      an amendment. **An amendment is a new commitment**: same gate, same
      signature. The agent proposes; it never edits an armed plan, because a
      plan that quietly changed is not the plan that was approved.
- [ ] **S2-5 Base-rate check v1.** "You assume X; historically it held N of M
      times on this pair." Calibration, not validation.
- [ ] **S2-6 Fix the Sprint-1 friction list.**
- [~] **S2-8 Fix the core, accepting the sprint cost.** *(Owner decision,
      2026-07-31, reversing the recommendation to defer this.)* The observation
      that prompted it: the app has a strong **domain** layer and a weak
      **application** one — features held together at the edges rather than by a
      backend. Measured at the time: `ipc.ts` was 618 lines and 86 handlers with
      no grouping; **6 transaction sites existed in the whole main process, all
      but one in migrations**; background work was 4 scattered `setInterval`
      sites with no owner; and the renderer built domain JSON by hand
      (`plans-page.tsx` literally constructing `ConditionGroup`s). The reasoning
      for doing it now rather than after launch: **the core is cheaper to fix
      before live execution depends on it**, and Sprint 4 puts real money on
      exactly these paths.

      Ordered by whether it is a correctness bug or a structure preference:
      - [x] **Transaction discipline.** `withTransaction()` in `database.ts`,
            applied to every multi-row write. Not reentrant on purpose —
            SQLite has no nested transactions and savepoints would let an inner
            rollback silently keep an outer write. Rollback proven by test, not
            assumed.
      - [x] **Kill the frontend glue.** *(Done 2026-07-31.)* The renderer sends
            a `ConditionIntent`; `plans/condition-intent.ts` compiles it. A
            malformed intent is **refused with a reason** rather than stored as
            an empty group — which `validatePlan` would have read as a missing
            invalidation, surfacing the mistake three steps from its cause.
      - [x] **Split `ipc.ts` into per-domain modules** registered from one
            place. *(Done 2026-08-05.)* The measurement reframed the complaint:
            725 lines and 102 channels, but only about **thirty lines of logic**
            — the delegation to services had already happened. What it had
            become was the app's **dependency hub**, the one module importing 34
            subsystems, so any change to the IPC surface pulled in the venue
            adapter, the agent, the paper engine and the credential vault at
            once. Sixteen domain modules now import only their own services;
            `index.ts` knows the order and nothing else.

            **The guard was written and run green BEFORE the move**, because
            relocating 102 handlers is exactly the mechanical edit that goes
            wrong once and is never noticed — a dropped handler is a channel
            that rejects at runtime, in whichever surface calls it, weeks later.
            `ipc-surface.test.ts` asserts the set main answers equals the set
            preload reaches for, both directions, no duplicates, and that every
            handler reports failures under its own channel name. Deliberately
            **not** a checked-in snapshot: a list nobody trusts gets updated
            reflexively, whereas equality with the bridge is self-maintaining.

            Writing the guard found its own gap — it saw only `ipcMain.handle`
            and was therefore blind to the seven `ipcMain.on` channels, which
            are the hot ones (candle and ticker subscriptions, chat send, the
            Research view reports). Verified beyond the suite by registering
            against a stub Electron: **102 channels, zero duplicates.**
      - [ ] **A single runtime owner** for engine startup/shutdown and background
            jobs, so what is running is enumerable, pausable and reportable.
            **Design written 2026-08-05, now in `docs/ARCHITECTURE.md`** — read it first. Two
            tiers that must never blur (deterministic watchers always on and no
            AI; agent jobs rare, event-triggered and bounded), a persisted job
            queue between them, and a budget plus cooldown on every job that
            calls the model. Measured today: four `setInterval` sites, no shared
            owner, nothing enumerable, nothing persisted, no budget anywhere.
      - [x] **S2-7(b)** — the typed outbound channel. *(Done 2026-07-31 — see S2-7.)*
- [~] **S2-9 Integrations become a layer.** *(Owner decision, 2026-07-31.)*
      **Status 2026-10-31:** venue half done; feed half mostly done — symbol
      mapping has one home and the feed's identity is one constant
      (`integrations/feed/symbols.ts`, `FEED_SCOPE_SQL`), taking the
      `source = 'binance'` predicates from 18 to 2. **Still open: a feed port,
      and those last two predicates.**
      Venue and analysis feed are currently referred to by name from wherever
      they are needed; there is no integration layer at all. Full measurement
      and the target shape are in **`docs/ARCHITECTURE.md`** — read that before
      starting. Summary: Revolut X is ~15 touch points and swappable in days
      (**and this is the cheapest it will ever be, because Sprint 4 has not
      written the order path yet**); Binance is 12 modules, 6 hardcoded URLs,
      **18 `source = 'binance'` SQL predicates** and 5 duplicated symbol
      mappings, so a feed swap changes every number the app has produced and
      carries the schema-v8 contamination risk. **Scope is swappable, not
      concurrent multi-venue** — the latter stays deferred in §1 and would
      violate the one-feed-per-purpose rule. Order of work is §7 of the
      architecture doc; the `source =` collapse goes last, on its own commit,
      with a test asserting a resolved level is identical before and after.
      *(Venue half done 2026-07-31: vault extracted to `security/credentials.ts`
      first, then `integrations/venue/` with port, Revolut X adapter, registry
      and capabilities. Nothing outside that folder imports the venue client.
      Per-integration credential schemes done the same day
      (`security/integration-secrets.ts`, declared auth schemes, no plaintext
      fallback, traversal-safe keys, presence-only status) — **the Revolut X
      keys are deliberately NOT migrated**, since an Ed25519 private key the
      venue already knows cannot be re-derived and L-3 has not happened. IPC
      renamed `revx:*` → `venue:*` with a new `venue:info`; the renderer reads
      the venue's display name from the adapter. **Still owed: the whole feed
      half** — port, symbol-mapping consolidation, and the 18 `source =`
      predicates last, on their own commit with an equivalence test.)*

**Exit:** every level a thesis can name is resolvable by the engine. No
hardcoded ratio array remains. Ichimoku offsets proven by test. The calibration
record has its first entries.
### Sprint 4 · 20 – 26 Aug — *Live execution, supervised only*

Goal: real money, human signature, venue-verified. **The highest-risk sprint.**

- [ ] **S4-1 Real order placement** in `revx/client.ts` behind `OrderPipeline`.
      Idempotent `client_order_id`, signed, full order state machine, partial
      fills, cancel/replace. No AI anywhere in the path.
- [ ] **S4-2 Venue-side TP/SL on every live position.** Plan hard rule — a local
      stop is not a stop if the app is closed.
- [ ] **S4-3 Startup reconciliation, for real.** Compare open orders, fills,
      balances and resting protective orders against the venue. **Report drift;
      never silently adopt either side.** Replaces today's honest stub.
- [ ] **S4-4 Approvals queue made real** — **not** "confirm every fill".
      Arming is the signature (§1), so a trigger executes what was already
      signed. The queue is for the cases where it **cannot** be executed as
      signed: a level drifted past tolerance (J-4), an entry the stop/target
      geometry refuses, a risk-engine rejection. Unapproved intents expire
      rather than linger — a stale authorisation acted on later is the same
      failure as a stale conditional firing weeks late.
- [ ] **S4-5 Kill switch reaches the live path** and cancels resting orders, not
      just future entries.
- [ ] **S4-6 Minimum-size live smoke test.** One real order at the smallest
      viable notional: placed → filled → reconciled → journalled → cancelled by
      kill switch.

**Exit:** S4-6 completed with real money, and the audit log tells the whole story
without gaps.

### Launch week · 27 – 30 Aug — *Freeze and harden*

**No new features.** Anything unfinished on 27 August ships after launch.

- [ ] **L-1 Packaging.** `npm run package:win`; installer launches; icon, asar,
      fuses verified.
- [ ] **L-2 Clean-install run-through** — onboarding, credentials, Windows Hello,
      first session, from nothing.
- [ ] **L-3 Backup routine.** Daily SQLite backup, and **restore it once** — an
      untested backup is a belief, not a backup.
- [ ] **L-4 Full-suite green, typecheck clean, log file reviewed** for anything
      being swallowed.
- [ ] **L-5 Unattended soak.** 72 hours running with paper armed, no crash, no
      unbounded log growth, feeds reconnecting cleanly.
- [ ] **L-6 Go / no-go** against §4.

---

## 4. Launch gate — binary, all must be true

Not aspirations. If any line is false on 30 August, live trading stays off and
the app launches paper-only. That is a perfectly good launch.

- [ ] Every live position carried a **venue-side** TP/SL, verified *on the venue*
- [ ] Startup reconciliation compares against Revolut X and **reports drift**
- [ ] Kill switch blocks new entries **and** cancels resting live orders
- [ ] Protective exits still fire while the kill switch is tripped
- [ ] No AI call in the order path (grep-verified, not assumed)
- [ ] **Every armed plan has all four falsifiability elements** — stated
      assumptions, invalidation *separate from* the stop, a hard expiry, and its
      own risk budget. A plan missing one cannot arm (plan §17)
- [ ] **At least one plan has run the full path in paper** — authored → armed →
      triggered → closed or invalidated → reviewed — with drift, expiry and OCO
      cancellation each proven by test
- [ ] **No plan is armed against a developing level with no drift guard**, and
      `onDrift` defaults to `invalidate` (a stale conditional firing weeks later
      into a different market is the worst failure mode of scenario automation)
- [ ] `live_auto` is unreachable for plans, by construction and by test
- [x] **Simulated mode cannot place an order** — the paper adapter reports
      `canPlaceOrders: false` and no credential is loaded, verified by test
- [x] **The running mode is unmistakable on every screen**, and no surface
      can show simulated and live figures in one number
- [ ] A written per-trade money cap, enforced by the risk engine's config
- [ ] Tests green, typecheck clean, packaged installer runs
- [ ] Backup taken **and restored once**
- [ ] 72-hour soak passed

---

## 5. Feature roadmap beyond launch

Ordered by value, not by ease.

**September — earn automation**
- `live_auto` graduation, per strategy, on accumulated supervised evidence with
  no interventions. Any manual intervention demotes it.
- Away policy per strategy (flatten on stale feed / hold and alert / halt),
  chosen while calm — never decided by an AI at 3am.
- Out-of-app escalation (the channel that matters when the app is closed).
- Depth-aware slippage: the basis monitor measures top-of-book only, so large
  orders still fill worse than the median suggests.

**Unscheduled — the strategy path, if it is ever wanted**
- The whole thing is frozen, not deleted (§1). Reviving it means un-freezing the
  lifecycle, the promotion ladder and `create_strategy`; the fill model,
  condition evaluator, level resolver and paper engine stayed live throughout
  because the plan path uses them.
- **Do not revive it without engaging this measurement:** 90 backtests across the
  top-15 coins by market cap produced exactly one spec clearing the gate, at
  +0.03% out-of-sample, and none beat buy-and-hold on its own coin. A bot gated
  on validated edge would never have acted. That is the finding that moved the
  product to plans-only.
- Two leads worth keeping if it ever returns, both structural rather than
  parameter-tuning: **fees dominate** — several specs paid more in fees than they
  lost to the market, so any per-trade edge under roughly 50bps is noise at 25bps
  taker each way; and **buy-and-hold belongs in the backtest report** as the
  benchmark every strategy is scored against, rather than left for a human to
  remember.

**September — the partner bar** *(from JOURNEYS.md, 2026-08-01)*
- **Make the agent volunteer.** The stated ambition is a "next generation
  trading partner", which is a quality bar rather than a journey. Testable form:
  **does the agent say something the owner did not ask about, at the moment it
  matters?** Today nothing does — every agent action is a reply, and the only
  push in the app is an alert on a condition the owner wrote themselves.
- **Deliberately post-launch, and not for lack of time.** It sits on top of J5's
  calibration record, and an agent that volunteers opinions without one is a
  confident stranger. Build it when there is something earned to say.

**October — sharper evidence**
- Footprint / delta-at-price via `@aggTrade`, if bar CVD proves insufficient.
- Multi-timeframe confluence in specs.
- Monte-Carlo / parameter-sensitivity on backtests, to expose fragile edges the
  walk-forward split misses.
- Plan calibration dashboard: the owner's own hit rate by thesis type.

**Later**
- Theming, light mode, colour-blind-safe mode (§16) — with the constraint that
  outranks every preference in it: no theme may make a state ambiguous.
- Locale / full localisation.
- A second venue, only if basis risk proves to be the binding constraint.

---

## 6. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| **Serial dependency: references → plans → live** | Sprint 4 starts late and live execution is rushed | The plan spine moved to Sprint 2 so the chain starts as early as possible. No parallelism available — this is the constraint that replaced the calendar one. |
| Plans become a backtest loophole in a plans-only world | Every trade is an unvalidated conviction, with nothing ever accumulating | S3-6's calibration record is now the **only** evidence the app produces, so it is a Sprint-3 requirement rather than a trailing nice-to-have. Plus repeat-thesis detection (below). |
| Live execution slips (Sprint 4) | No real trading at launch | Deliberately last, so launch degrades to paper-only rather than to a half-built order path aimed at real money |
| **Basis risk** — validated on Binance, executed on Revolut X | Real fills worse than modelled | Basis monitor measures spread; depth still unmeasured. Start at minimum size. |
| Revolut X caps limit orders at 1,000/day | A busy strategy silently stops | Count orders per day; refuse at 90% with a visible warning |
| Repeated theses go unnoticed | The same bet re-filed as a "one-shot" forever, dodging any accumulation of evidence | Repeat-thesis detection: "you've filed this 6 times." **The old wording ended "…that's a strategy, backtest it", which no longer means anything with the strategy path frozen.** It should instead surface the calibration record for that tag — you have filed this six times, here is how the previous five resolved. |
| Solo developer, five weeks, no slack | Everything slips together | Launch week is a hard freeze; the gate in §4 is the arbiter, not the calendar |
| Silent-failure class recurring | Wrong numbers trusted | Every field a decision depends on needs something that would notice if it went missing (§13) |

---

## 7. Working agreements for the run-up

- **Commit per sprint item**, not per week. The single 12k-line commit that
  opened this roadmap must not happen again.
- **Claude runs commands and verifies its own work** (CLAUDE.md, owner decision
  2026-07-30 — this reverses the original "owner runs all commands" agreement).
  The carve-outs are money, credentials, destructive local state, and anything
  that leaves the machine. Since the owner is no longer double-checking every
  build, an unverified claim now goes straight into the record — run the suite,
  read the output, report what it said.
- **`npm test` and `npm run typecheck` green before every commit.** The suite is
  1.6s and touches no network; there is no excuse.
- **A stub must fail loudly.** Never return plausible success — see
  `exchange/revolutx-exchange.ts` for what that nearly cost.
- **Update `CLAUDE.md` in the same change as the behaviour.** Documentation
  written later is documentation written wrong.
- **Every doc reflects the journeys and the end goal** (owner decision,
  2026-08-01). New items name the journey they serve and the step they land on;
  descriptions are written to the **moment of truth** — what the owner
  experiences when it works or fails — before the mechanism. An item serving no
  journey step is either infrastructure with a named dependant or it is not
  wanted, and the doc says which. The end goal governs: *the owner authors a
  thesis; the agent monitors it and acts on it*, spine **J3**. Full rule in
  `CLAUDE.md`; the journeys themselves in `docs/JOURNEYS.md`.
