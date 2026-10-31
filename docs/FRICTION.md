# Friction log (ROADMAP S1-6)

Observations from actually using the app. **Written down, not fixed** — the point
of S1-6 is to accumulate real friction before spending Sprint 1 days on it. Each
entry says what was being attempted, what got in the way, and where a fix would
land (this sprint / Sprint 2 / post-launch §5). Nothing here is a commitment.

**Entries from 2026-08-01 on name the journey they interrupt** (`docs/JOURNEYS.md`).
Friction is not evenly costly: an awkward step inside the spine journey — J3, the
plan executing without the owner — is worth more than a rough edge on a surface
visited monthly.

---

## 2026-08-01 · First UI test run — four frictions, one of which stopped the run

**Attempted:** the whole of the first UI test pass, first launch of
everything built 30–31 July.

**Got through §0 to §2 complete, then stopped.** The two defects found (§2.8, a
duplicate plan name surfacing as "couldn't read or write local data", and an
error banner outliving its form) were fixed immediately per the wrong-number
rule. These four are friction and are not fixed:

**1 · The plan/chart gesture is inverted — J2, and it blocked ~25 checks.**
The owner's note: *"I couldn't find how to draw, and shouldn't the plan be like
a template and automatically added to the chart with alert if I click on
bookmark and select the armed plan?"* What exists is draw ink → promote ink →
author a plan referencing it. What was reached for is select an armed plan → see
its levels on the chart. Both are legitimate; only the un-reached-for one is
built. **This is the entry that matters** — it is not a rough edge, it is a
missing seam, and it took §3, §4 and part of §5 with it. Promoted to a roadmap
item (**J-3**, Sprint 2) rather than left here, because friction that blocks a
third of the test surface is not friction.

**2 · The feed chip could not be found at all — J0/J7. Closed same day.**
§1.1–1.3 were ticked with *"Where is this? Confusing where to test this?"*
against all three. Verified by reading the code rather than by asking again:
the rename **works** — the venue chip renders the adapter's `displayName`
("Revolut X") and the `venueName` dependency is present, so the "reads Venue
forever" failure mode is not occurring. The checklist itself was wrong about
the other chip, which reads "Binance", not "Binance Spot".

The real finding was the one in the margin: **a status indicator nobody can
locate is not reporting status.** It was `--text-xs` in `--muted-foreground`,
no background, right-aligned in a 34px band — the quietest element on screen,
for a component whose stated purpose is that a feed going quiet is noticed
*without going looking*. Fixed: a real chip with a surface and border, one size
up, and a degraded feed now colours its whole label rather than only its 6px
dot. **Kept in this log because the lesson generalises** — the same reasoning
that makes an unreadable value a defect makes an unfindable status indicator
one, and neither shows up in a test that only asks "is it rendered".

**3 · Credentials is a status readout where an Integrations surface is expected
— J7. Closed 2026-08-01**, after the owner raised it a second time: *"the
settings page still shows credentials old way, there is no way of wanted
integrations feature."* The venue had been a port with a registry and declared
capabilities since S2-9; Settings still showed one venue's key status and
nothing about the venue.

`integrations-pane.tsx` replaces the Credentials section. It states what is
connected, **what each connection can actually do**, and how to change it. The
capability rows are read from the adapter and never asserted in the renderer —
`canPlaceOrders` is false until S4-1 and `venueSideProtectiveOrders` is false
until S4-2 verifies it against the real API, so the page currently says live
trading is off *and why*. That honesty is the point of the section: a capability
shown as present before it is verified is how a position ends up unprotected.
`CredentialsPanels` is embedded rather than reimplemented — one implementation
for anything that writes a private key the venue already knows.

**4 · The session dashboard chart — J0. Resolved by deleting it, same day.**
Two observations: it *"does not update properly if I change the time from the
header"*, and it *"looks messy"*. The owner's follow-up question was the better
one: *"do we even need a chart on session dashboard when there is a massive
chart in the research area?"*

No. It was Phase 0 furniture from when the dashboard was the app's main surface
and the question was "what is this pair doing" — a question **Home** now answers
before it is asked, and **Research** answers properly. What remained was a chart
you could not draw on, anchor from, or promote a level out of: a worse Research
embedded in a page of status panels, carrying a second chart configuration to
keep in sync with the first. Both findings above were its own.

Replaced by `PlanWatchPanel` — armed plans as **distances**: how far price is
from each trigger, stop and target, and how long until expiry. That is the spine
journey's at-a-glance view, and a list of numbers answers it better than candles
do. **The interval bug was therefore never diagnosed and deliberately so** —
deleting the surface beat debugging it.

`CandlesCard` itself survives on the **Market** page, where switching symbols is
its actual job. The venue bid/ask reference (§1.3) went with it and now appears
only there; if it turns out to be wanted next to plan status, it comes back as a
strip rather than a chart.

**Unrun and still owed:** §3.2 onward, §4, §5, §6 and §7. §5.4–5.5 (coverage
table, repair) and §7 (chat, alerts, archive) are **not** blocked by entry 1 and
can be re-tested cheaply. §6 — the S1-2 smoke test — remains the item gating
Sprint 3, because the paper engine has still never executed a position.

---

## 2026-07-30 · Research is not yet where analysis happens

**Attempted:** discretionary analysis of ARB-USD 4H on the Research surface.

**What happened:** the owner fell back to TradingView and shared the result with
the agent instead. Research is usable enough to look at a chart, not usable
enough to think on. This is the single most important entry in this file so far,
because Research is the surface the roadmap assumes the day is spent on — if the
real workflow is "analyse in TradingView, paste to the agent", then the
discretionary tooling in Sprint 2 is being built for a surface that isn't being
used, and that assumption needs testing before more is built on it.

**Concrete defects visible in the same session (not yet fixed):**

- **The volume-profile overlay is drawn over the price axis.** Its host div is
  `inset: 0` over the whole chart container (`research-page.tsx`), so `size.width`
  includes the y-axis gutter, while `yOf` maps prices through `convertToPixel`
  into `candle_pane` only. Bars anchored at `right = size.width` therefore run
  underneath the axis labels, and `PANE_SHARE` is 22% of a width that includes
  the gutter rather than 22% of the plot. Same mismatch vertically: the host's
  height spans the volume sub-pane too.
- **Large dead space to the right of the last candle** at default zoom, which
  compresses the price action into roughly half the pane.

**Resolved, same day — owner decision: the goal is not to create another charting
tool.** So this entry does *not* become a charting-UX workstream. TradingView
stays a legitimate analysis surface; the agent can already read it
(`read_browser_page` / `screenshot_browser`), which is exactly why the ToS risk
was accepted. Research's job is narrower and unchanged: be the surface where the
trader sees **the same levels the engine will resolve**, so a POC drawn on screen
and a POC a strategy triggers on are one number from one implementation. Recorded
in ROADMAP §1's deferred table.

The line that decision draws, and it is the useful part of this entry:

- **Rendering correctness stays in scope.** A profile drawn over the price axis
  is a defect — it misplaces a level, and misplaced levels are this project's
  recurring bug class, not a comfort issue.
- **Charting comfort is out of scope.** Crosshair behaviour, drawing ergonomics,
  keyboard shortcuts, timeframe muscle memory. TradingView has had years; five
  weeks will not close that and should not try.

**Still owed:** the two defects above are unfixed and deliberately so — S1-6 is a
logging exercise and S1-2 (arming strategies) owns the calendar. Fix them when
the profile is load-bearing for a plan, not before.

---

## 2026-07-30 · A pair can be tradable and unbacktestable at the same time

**Attempted:** evaluate strategies on **HYPE-USD** for S1-2.

**What happened:** `HYPE/USD` is **active on Revolut X** (base step 0.000001, min
order 1 USD) — a pair the owner can actually trade. **Binance does not list HYPE
at all**; `/api/v3/exchangeInfo` returns only `HYPER*`, a different token. Under
the feed-role rule (CLAUDE.md: Binance is *the* analysis feed, RevX candles are
execution truth and must never be charted from), that makes HYPE-USD
**executable but unanalysable**: `getAnalysisCandles` throws, the chart cannot
draw it, and the in-app `run_backtest` cannot produce a single number for it. It
therefore cannot pass the backtest gate — not because it lacks edge, but because
the architecture has nowhere to get its history.

This is a structural gap, not a bug. The feed rule is right and should not be
relaxed casually; the FX-contamination purge (schema v8) is what mixing sources
costs. But the rule was written assuming Binance is a superset of what Revolut X
trades, and it is not.

**Options, none taken yet:**

1. **Restrict S1-2 to pairs Binance also lists.** Costs nothing, forecloses
   nothing, and is the only option that needs no architecture change.
2. **Per-symbol analysis source** — a symbol's analysis history comes from
   exactly one venue, recorded on the row and labelled everywhere it surfaces.
   This preserves "never mixed inside one computation" while dropping the
   assumption that the one source is always Binance. Hyperliquid is already
   integrated (`data/hyperliquid.ts`) and is HYPE's native venue.
3. **Chart from Revolut X for Binance-absent pairs.** Currently forbidden
   outright, and the thin-book/short-history reasons for that still hold.

**What the indicative numbers said**, for whenever this is revisited — measured
against Hyperliquid's `candleSnapshot` for coin `HYPE`, which is the
**perpetual**, not RevX spot, and is *not* the project's analysis feed, so none
of it is reproducible in-app today: over 2,191 4H bars (Jul 2025 → Jul 2026),
six candidate specs produced one marginally-positive result (a MACD-histogram
zero-cross: +2.0% in-sample, +0.3% out, 73 trades) against **+30.8% buy-and-hold**
over the same window, with fees exceeding net profit. No edge demonstrated.
Hyperliquid also publishes no aggressor split on that endpoint, so CVD would be
unavailable for HYPE even if option 2 were taken.
