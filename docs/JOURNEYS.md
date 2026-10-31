# Journeys — what the app is for, end to end

**Written 2026-08-01, after the first UI test run.** Owner input on the seven
product goals; agency model, spine and agent-tool scope decided the same day.

**Updated 2026-08-05** for two owner decisions that changed the product's
shape: **one object — the trading plan** (strategies, the Workbench, the
promotion ladder and backtesting are gone from every surface), and
**simulated/live as app modes** rather than a per-plan flag. How anything runs
unattended is `docs/ARCHITECTURE.md`.

**Status · 31 October 2026.** "Owner" means the person using the app. Each journey
below has its own step table; this is the summary.

| Journey | State |
|---|---|
| J0 · Daily loop | ✅ Built — Home, *while you were away*, plan distances |
| J1 · Hunch → thesis | ✅ Built — Research, order flow, agent with web search and fetch |
| J2 · Thesis → plan | ✅ Built — falsifiability gate; the agent drafts, never arms |
| J3 · Plan executes while away | 🟡 **Paper only** — monitor, execution and notifications built; proven on seeded bars, not yet driven by a live stream; the app must be running |
| J4 · Structure moved → critique | 🟡 Drift measured and acted on; the agent's critique and the reconfirm queue (J-4) are not built |
| J5 · Was I right? | ✅ Calibration record built; few entries so far |
| J6 · Paper → live, supervised | ❌ Not built (Sprint 4) — nothing can place a real order |
| J7 · Swap venue, feed or AI provider | 🟡 Venue layer and **AI provider port** built (one adapter each, plus paper); feed port not built |

## Why this document exists, and what it is not

A surface checklist tests **surfaces** — does this page load, does this
button refuse. The first run of it passed §0 through §2 and then stopped dead at
§3, and the reason is written in the owner's own margin note:

> *"I couldn't find how to draw, and shouldn't the plan be like a template and
> automatically added to the chart with alert if I click on bookmark and select
> the armed plan?"*

That is not a bug report. It is a **journey** report: the owner's path is *"I see
a level on the chart, it becomes part of my plan"*, and what was built is *draw
ink → promote ink → separately author a plan that references the ink*. Three
steps where one was expected. Every surface in that path works. The seam between
them does not, and no amount of checklist ticking would have found it.

**Journeys test seams. Checklists test surfaces. The roadmap sequences work.**
All three are needed; this one was missing.

**How to use it:** when a change is proposed, ask which journey it serves and
which step it lands on. A change that serves no journey step is either
infrastructure with a named dependant, or it is not wanted.

---

## The spine

**J3 — the plan executes without me.** (Owner decision, 2026-08-01.)

The owner named the actual problem: *"I have problem of not sticking to my
plan."* The app's answer is not to discipline the trader — it is to **remove the
trader from the moment of temptation** by making the plan the thing that acts.

**Which is only possible if the signature is given in advance.** Owner decision,
2026-08-09: **arming is the signature.** A trigger executes terms already
signed — this branch, this entry, this stop, this budget, this expiry — rather
than asking at the moment J3 exists to remove the owner from. Requiring approval
per fill would put them back at 3am in front of the decision they said they
cannot make well. See ROADMAP §1.

Everything else serves that:

- **J1 and J2 exist to produce plans good enough to be trusted unattended.**
- **J4 and J5 exist to keep those plans honest** once they are running.
- **J6 puts real money behind them; J7 keeps the data underneath them clean.**

This also matches the constraint the roadmap already runs on — `references →
plans → live` (ROADMAP §2). The spine decision does not reorder the sprints; it
explains them.

## The agency model — where the agent stops

**Owner decision, 2026-08-01: the agent drafts, the owner signs, code executes.**

This is the existing hard rule (`CLAUDE.md`: *AI proposes, code executes*)
restated as a product position rather than a safety constraint, and it settles
what "agentic trading" means here:

| The agent may | The agent may never |
|---|---|
| Research, read the chart, search, fetch | Place, amend or cancel an order |
| **Draft** a plan and **create** a level reference | **Arm** a plan |
| Critique an armed plan and propose an amendment | Apply an amendment |
| Monitor, narrate, and keep the calibration record | Choose the venue or the feed |

**Arming is the signature, and it stays human.** A plan's licence to risk money
comes from falsifiability, not from a validated edge — which is exactly why
plans can never reach `live_auto`, and why `PlanState` has no such member to
forget about.

**The agent authors the conditions; the engine judges the moment** (2026-08-05).
The owner asked for the agent to "look at the market and enter if it thinks it is
favourable". The intent is right — a stale trigger should not fire mechanically
into a changed market — but an AI call at the moment of entry is unreviewable and
untestable, and it is the one thing the hard rule forbids. So the judgment moves
earlier: what the agent would have looked at becomes **conditions written into the
plan**, plus a confirmation window after the trigger. Deterministic, reproducible,
and still the agent's thinking. See `docs/ARCHITECTURE.md`.

**Agent tool scope (owner decision, 2026-08-01): draft-only write tools.** The
agent gets `create_level_reference` and `draft_plan`. It does not get an arming
tool, and there must never be a `set_venue` tool.

---

## J0 · The daily loop

**Trigger:** the owner opens the app.

**Moment of truth:** within five seconds they know what changed, what fired, and
what needs them — without opening a session.

| Step | Built? |
|---|---|
| Home opens first, not the last session | ✅ `home-page.tsx` |
| "Needs your attention", derived not stored, disappears when empty | ✅ |
| "While you were away" from the audit log | ✅ |
| Per session: how far price sits from each armed plan's levels | ✅ `plan-watch-panel.tsx` (2026-08-01) |
| **What each armed plan did while away** | ❌ — J3's gap, see below |

**State:** the healthiest journey after J7. What it lacks is plan-shaped
content, which arrives with J3.

**Changed 2026-08-01:** the session dashboard's candle chart was **deleted**, on
the owner's question *"do we even need a chart on session dashboard when there
is a massive chart in the research area?"* It was Phase 0 furniture answering a
question Home now answers first and Research answers properly — a chart you
could not draw on, anchor from, or promote a level out of. What replaced it is
the numeric half of J-3: **armed plans as distances.** "Trigger 1.4% away,
expires in 9 days" is a sentence you can act on; a chart makes you eyeball it.

---

## J1 · Hunch → thesis *(AI-assisted research)*

**Trigger:** *"Something's happening in SOL."*

**Moment of truth:** the agent tells the owner something about market structure
they had not seen, **anchored to a level the engine can resolve later.**

| Step | Built? |
|---|---|
| Ask the agent about a pair, in chat, from any surface | ✅ `chat-drawer.tsx` |
| Agent reads the real chart the owner is looking at | ✅ `research-view.ts` |
| Agent reads order flow — CVD, volume profile, derivatives, basis | ✅ |
| Agent searches and reads the web | ✅ `web_search` + `fetch_url` |
| Agent can see the plans the owner has authored | ✅ J-1 awareness half, 2026-08-05 |
| **Agent turns its conclusion into a level the engine can resolve** | ✅ `create_level_reference`, 2026-08-05 |
| Agent reads order flow the app computes (CVD, volume profile) | ✅ `get_order_flow`, 2026-08-05 |

~~**The seam that breaks it.**~~ **Closed 2026-08-05 (J-1).** The agent could
say *"72,400 is the level that matters"* and then the owner retyped it into a
form — its only authoring tool was `create_strategy`, pointing at the frozen
path. It can now name a level (`create_level_reference`) so the chart and the
engine read one definition, and read the order flow the app already computes.

**AI-assisted research no longer terminates in prose.** What is still owed is
the agent *volunteering* — see the partner test below.

**Proves it:** ask the agent to analyse a pair; a named level appears in the
references panel without the owner typing a number.

---

## J2 · Thesis → plan *(AI-assisted trade planning)*

**Trigger:** *"Above 72.4 held four hours, I'm long to 81."*

**Moment of truth:** **the gate refuses, and the refusal teaches** — it tells the
owner they never wrote down what would prove them wrong. A gate that only
gatekeeps is bureaucracy; a gate that teaches is the product.

| Step | Built? |
|---|---|
| Start a plan from a level, an alert, or a blank form | ⚠️ blank form only |
| Agent can read an existing plan's assumptions and branches | ✅ `get_plan`, 2026-08-05 |
| **Agent drafts the plan from the conversation** | ✅ `draft_plan` (draft-only), 2026-08-05 |
| Author assumptions, invalidation, expiry, budget, OCO branches | ✅ `plans-page.tsx` |
| Save an incomplete draft — thinking is not committing | ✅ |
| Arm → gate runs, refusals are **visible and specific** | ✅ verified §2.4–2.5 |
| Arm → every derived level resolves to a concrete number, shown before commit | ✅ `armPlan` returns them |
| Arm → refuse rather than store a placeholder if a level won't resolve | ✅ |
| **The armed plan's levels appear on the chart** | ✅ 2026-08-01 (J-3) |

**Two seams break it.**

1. ~~**The agent cannot draft.**~~ **Closed 2026-08-05 (J-1).** `draft_plan`
   saves a thesis as a draft and reports what arming will still require. It can
   never arm — that stays the owner's signature, and the guard is the tool not
   existing rather than a check that could be forgotten.
2. ~~**The owner's expected entry point is inverted.**~~ **Closed 2026-08-01.**
   The Research panel led with *references* — the authoring layer — so the owner
   opened it looking for plans and found ingredients. It now leads with armed
   plans, and toggling one lays its levels over the chart, labelled by role.
   Both gestures now exist: draw → promote → author, and select → see.

   The rule that shaped it: **the lines are a view of the plan, never ink.**
   Nothing is persisted, so hiding them leaves nothing to reset — and a plan's
   levels can never go stale against the plan that owns them.

**Verified working, and worth recording as such:** the falsifiability gate
refuses visibly and names what is missing (§2.4–2.13, all passed). That was the
most important test in the checklist and it passed.

**Defects found here** (§2.8): a duplicate plan name surfaces as *"couldn't read
or write local data"* — a raw `UNIQUE` constraint on `idx_plans_slug` escaping
as a generic storage failure — and the error banner outlives the form that
caused it.

---

## J3 · Plan → execution while away **(the spine)**

**Trigger:** the owner sleeps. The market moves.

**Moment of truth:** **the plan did exactly what was written, and the record says
why.** Not "a trade happened" — *why this branch and not that one, and what the
levels were worth at the moment it fired.*

| Step | Built? |
|---|---|
| Decide what a plan should do on a bar: expiry → invalidation → drift → triggers | ✅ `plan-monitor.ts`, pure |
| Drift disqualifies a branch before its trigger is evaluated | ✅ |
| OCO: the first branch to fire cancels its siblings | ✅ |
| **The monitor actually runs on a live bar** | ✅ wired watch-only 2026-08-01 |
| Expiry and thesis invalidation transition the plan | ✅ |
| A trigger is recorded, OCO siblings cancelled | ✅ |
| A triggered branch **opens a position** | ✅ `openPlanPosition`, 2026-08-05 (S1-2) |
| One fill model shared with backtest and paper | ✅ `persistEntry`, owner-agnostic |
| A plan-owned position has somewhere to live | ✅ schema v15 |
| Position carries a stop and a target from the moment it opens | ✅ engine rule |
| **The paper engine has ever executed a position** | ✅ on seeded bars, 2026-08-05 — **not yet driven by the live stream** |
| **The owner is told what happened, in plan language** | ✅ N-1 — trigger and close notifications carry the thesis and whether a position opened |
| **A closed plan position is reviewed** | ✅ J-2, 2026-08-01 |

**Found by walking this journey, 2026-08-01:** the owner armed a plan, went
looking for what it was doing, and found nothing. `plan-monitor.ts` was imported
by **nothing but its own test** — every armed plan read "armed" and no code path
evaluated it. Two further defects were invisible underneath that, because an
unreachable monitor cannot fail visibly: price conditions compiled without a
`field`, so every trigger and invalidation would have read false for ever; and
arming did not tell the running engine, so a plan stayed unwatched until
restart. **This is what the journey framing is for** — no surface was broken,
and no checklist item would have asked "is anything actually looking at this?"

**Three seams break it, in dependency order.**

1. **S1-2.** The paper engine has never executed a single position;
   `paper_positions` has zero rows. The monitor rides that exact engine. This is
   why plan execution is deliberately unwired — extending a path that has never
   run once means the first failure found would be the *strategy* path's, not
   the plan path's.
2. **The applying half of S3-3** — a triggered branch does not open a position.
   Now gated by an explicit flag rather than by absence: watching protects, and
   acting risks, so watching went live first.
3. ~~**`review.ts` is strategy-shaped.**~~ **Closed 2026-08-01 (J-2).** It
   declared `strategy_id: number` and called `getStrategy()` on it, so once
   plan execution opened its first position the trade would have closed and
   never been reviewed. A plan is now judged against **its thesis and
   assumptions**, not a spec's intent — a separate prompt, because the question
   is different, over shared rules so the arithmetic cannot drift apart.

**Proves it:** author a plan, arm it, leave the app running, come back to a
position that opened on the branch that was supposed to fire, carrying its stop,
with a review in the journal explaining which condition triggered and whether
the level had moved.

---

## J4 · Structure moved → the plan is critiqued *(agent feedback)*

**Trigger:** the market's structure changes underneath an armed plan.

**Moment of truth:** the agent notices the thesis's **premise** decayed *before*
the stop is hit — *"your VAH anchor has migrated 3% toward price; this is not
the setup you approved"* — and says so.

| Step | Built? |
|---|---|
| A developing level's drift is measured every bar against `resolvedAtArm` | ✅ `level-resolver.ts` |
| `onDrift: invalidate` stops the plan trading on a stale level | ✅ |
| Drift and unresolvable levels are reported, not swallowed | ✅ `notices` |
| `onDrift: reconfirm` reaches an operator queue | ❌ owed since S1-5 |
| **The agent explains the drift in thesis terms** | ❌ |
| **The agent proposes an amendment; the owner applies or invalidates** | ❌ |

**The seam.** Drift handling today is mechanical and silent-by-default: the plan
stops trading and a line goes in the log. The owner's goal — *"agent feedback on
plans and improvise existing plan based on market structure"* — needs the
reconfirm queue as its surface and an agent critique as its content.

**The constraint that shapes it:** an amendment is a **new commitment**, so it
goes through the same gate and the same signature. The agent proposes; it never
edits an armed plan. An armed plan that quietly changed would mean the plan that
fires is not the plan that was approved.

---

## J5 · Was I right? *(calibration)*

**Trigger:** roughly thirty plans have resolved.

**Moment of truth:** the app states a fact **about the owner**, not about the
market — *"your breakout theses trigger 60% of the time and reach target 20%."*

| Step | Built? |
|---|---|
| Every closed position gets a review that judges process over outcome | ✅ `review.ts` |
| Operator exits are excluded from evidence but counted in cash | ✅ |
| "Did price move, or did the level move?" is in the review payload | ✅ schema v12 |
| Reviews distil into lessons injected into every conversation | ✅ `distillLessons` |
| **Plans are in the review loop at all** | ❌ see J3 seam 3 |
| **Per-scenario-tag statistics** — trigger rate, invalidation-before-target, captured share | ❌ S3-6 |
| Repeat-thesis detection: *"you have filed this six times; here is how the previous five resolved"* | ❌ risk register |

**Why it matters more than it looks.** With the strategy path frozen, this is
**the only evidence the app accumulates.** There is no backtest to point at for
a plan — that is the deliberate design. If J5 is missing, an unvalidated
conviction never becomes a validated *trader*, and the app is a very careful way
to keep guessing.

---

## J6 · Paper → live, supervised *(trade execution)*

**Trigger:** a plan has proven itself in paper and the owner wants it real.

**Moment of truth:** the signature — and a **venue-side** stop that exists on the
exchange, or the venue refuses the trade.

Entirely Sprint 4. What exists today is the honest refusal: the venue adapter
declares `canPlaceOrders: false` and `venueSideProtectiveOrders: false` until
S4-1/S4-2 verify them against the real API, and the stubs fail loudly rather
than returning plausible success. The launch gate in ROADMAP §4 is this
journey's acceptance test, line by line.

---

## J7 · Swap the venue, the feed or the AI provider *(integrations)*

**Trigger:** a different exchange, a different price source, or a different model vendor —
including a local model. No feature of the app is meant to be locked to one vendor.

**Moment of truth:** **nothing silently blends.** Two sources never meet inside
one computation.

| Step | Built? |
|---|---|
| Venue reached through a port, not by name | ✅ `integrations/venue/` |
| Capabilities declared, pessimistic until verified | ✅ |
| Switching the venue is privileged, audit-logged, refused while anything is open | ✅ |
| No path from configuration to loading code | ✅ compile-time map |
| Symbol mapping has one home; non-USD returns `null`, never a best-effort string | ✅ `feed/symbols.ts` |
| The feed's identity is one constant across all 18 predicates | ✅ `FEED_SCOPE_SQL` |
| A feed **port**, so a second analysis source is possible | ❌ rest of S2-9 |
| Setup asks the venue whether it is configured; simulated mode needs no venue at all | ✅ `isConfigured()`, `setup:status` |
| AI provider reached through a port; vendor SDKs only under `src/main/ai/` | ✅ `ai/port.ts`, `vendor-boundary.test.ts` |
| The agent loop is provider-neutral and contract-tested | ✅ `agent-loop.test.ts` |
| A second AI provider (OpenAI-compatible: OpenAI, OpenRouter, Ollama, LM Studio, Gemini) | ❌ A-1 |
| Choose the provider and its key in Settings | ❌ A-2 |

**The healthiest journey in the app**, and the only one where the seams were
designed before the surfaces. Scope stays **swappable, not concurrent** — one
venue and one feed at a time, chosen at setup. Concurrent multi-venue remains
deferred and would violate the one-feed-per-purpose rule.

---

## The partner test

*"Next generation trading partner"* is not a journey — it is a quality bar. Made
testable:

> **Does the agent tell the owner something they did not ask about, at the
> moment it matters?**

Today, nothing does. Every agent action is a reply to a prompt. The alert engine
pushes, but it pushes a condition the owner wrote themselves. J4's critique is
the first genuine instance of the agent volunteering something.

This bar is deliberately **not** scheduled before launch. It is the difference
between a good tool and the stated ambition, and it belongs in ROADMAP §5 where
it can be built on top of a calibration record that actually has entries — an
agent that volunteers opinions without one is just a confident stranger.

---

## What this exercise found that the roadmap did not

Five gaps, in order of leverage:

1. **The agent has no write tools into references or plans.** Two of the seven
   product goals — AI-assisted research and AI-assisted planning — dead-end at
   prose because of one missing pair of tools. `create_strategy` exists and
   points at the frozen path.
2. **`review.ts` cannot review a plan-owned position.** It lands the moment
   S3-3's applying half does, and it is the "record says why" half of the spine.
3. **Plans are not rendered on the chart.** The owner's expected entry point to
   J2 is the reverse of the one built, and it blocked 25 checklist items behind
   one flyout.
4. **`onDrift: reconfirm` still has no operator queue** — owed since S1-5, and
   J4 has no surface without it.
5. **Nothing in the app volunteers anything.** The partner bar, post-launch.

Each is now a roadmap item; see ROADMAP §3.

## What this exercise confirmed

Worth recording, because it is the part that went right: **the falsifiability
gate works and is visible.** §2.4 through §2.13 all passed — arming refuses with
the reason on screen, expiry bounds hold at both ends, OCO budget over 100% is
refused, and an invalidation that merely restates the stop is refused. That was
the most important test in the checklist, and it is the mechanism the whole
plans-only product rests on.
