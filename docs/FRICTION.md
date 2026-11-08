# Friction log (ROADMAP S1-6)

> **Contributors:** this is the most honest list of what is rough in the app.
> Anything here without a "Closed" or "Resolved" note is open, and fair game for a
> PR — say which entry and which journey it serves. To add one, open an issue with
> what you were trying to do, what got in the way, and the journey it interrupts.

Observations from actually using the app. **Written down, not fixed** — the point
of S1-6 is to accumulate real friction before spending Sprint 1 days on it. Each
entry says what was being attempted, what got in the way, and where a fix would
land (this sprint / Sprint 2 / post-launch §5). Nothing here is a commitment.

**Entries from 2026-08-01 on name the journey they interrupt** (`docs/JOURNEYS.md`).
Friction is not evenly costly: an awkward step inside the spine journey — J3, the
plan executing without the owner — is worth more than a rough edge on a surface
visited monthly.

---

## 2026-11-06 · Stress test off the happy path — J3 first, then J1, J5

**Attempted:** the plan journey against adversarial cases in the running app on the live stream, simulated mode, 1m plans on BTC, ETH and SOL: several plans on one pair (OCO, and a non-OCO plan whose branches both fire), entry refused past the target, invalidation and expiry with a position open, expiry while armed, budgets above the paper cash and of 0.01, a crash and restart mid-position, the kill switch and a paused session across three sessions, a 24-plan same-bar burst, agent drafts with contradictory terms and no invalidation, a request to arm, and two conversations at once.

**Fixed the same day** (defects):

- **Invalidation or expiry with a position open left the position unmanaged — J3.** The plan went terminal, dropped out of the watch list, and its position stayed open with nothing checking its stop or target. The plan's own exit now runs first: the position closes at the bar's close, with slippage, as `exit_signal`.
- **A plan that fired and then expired never ended — J3.** `triggered → expired` is not a legal transition; the refusal was ignored, so the plan stayed *triggered* and logged "expired" on every bar. It now ends *closed* (calibration reads *expired* as "never fired").
- **Expiry was judged a bar late — J3.** The monitor used the candle's timestamp, which is its open. A 4h plan could trigger up to four hours after its expiry. It now judges each bar at its close; the dry run matches.
- **A non-OCO plan could spend more than its budget — J2.** Two branches at 60% both fired: 120% of a budget shown as the maximum. Shares now total 100% or less for every plan.
- **A budget larger than the paper cash armed silently and drained the account — J2.** One plan took all 9,489 and every later plan was refused for want of cash. Arming now warns, with the balance. The refusal itself read "Needs 0.00 but the paper account holds 0.00"; small amounts now keep their digits.
- **The kill switch reset itself on restart — J3.** It lived in memory, so a crash re-enabled entries for every armed plan in every session. It now persists until the owner resets it.
- **Home said nothing while the kill switch was on — J3.** It read "armed — the engine is watching it" while every trigger was refused. *Needs your attention* now leads with the kill switch, and names a paused session whose armed plans cannot enter; a paused session's card says *paused*.
- **Surfaces lagged the engine by up to a minute — J3, J5.** Home, the session overview, Portfolio and Orders only polled (60/15/30/20 s); Home's armed count was seen 41 s stale. They now reload on `data:updated`, a burst coalesced into one reload. Home also waited on the 0.3–0.5 s ticker fetch before showing any engine state; the two now load apart.
- **The agent told the owner refused plans held positions — J1.** `list_plans` said "a triggered branch opens a paper position" and carried no position facts, so plans whose entries the kill switch refused were reported as "in a paper position, managed by the engine". Each branch now says whether its position is open, closed, or was refused.
- **A *Triggered* pill on a plan whose entry was refused** (open item 3 below). It now reads *Fired · no entry*, in the quiet outline of the finished states.
- **Searching a hyphenated word failed — J5, J1.** `st-oco` reached SQLite's FTS5 as syntax ("no such column"), in the Journal search and in the agent's memory tool. Words are now quoted.
- **A plan stop gapped through filled at the stop.** After a restart or a feed hole, a bar that opened below the stop filled at a price the market never offered. A plan's stop now fills at the open in that case (strategies keep the backtester's rule: their stop can ratchet inside a bar).
- **Bars missed in an outage were never checked against open positions — J3.** When a feed hole refills, the missing bars are now replayed against each open plan position's stop and target, oldest first. (Verified that the refill runs after a crash; no stop happened to be crossed during the test outages, so a replayed exit was not observed live.)
- **A crash left its last bar cut short in the cache, kept as final — J3.** Seen live: a BTC 1m bar stopped at the crash with a fifth of its volume, and a restart within one and a half bars never refilled it, so the end of that bar was never checked against a stop. The engine now drops the newest cached bar when it seeds a stream; the gap is measured from the last bar it can trust, and the refill rewrites it.

**Measured** (24 plans across three sessions, one bar): about 15–20 ms from close to recorded trigger and simulated entry per plan; one `data:updated` per stream; Binance delivered the three pairs' closes 0, 0.47 and 0.87 s apart; event to toast in the DOM 3–8 ms; IPC reads 1–3 ms, `portfolioSummary` 80–95 ms.

**Open:**

**1 · Bars missed while the app was down get no plan decision — J3.** Protection is replayed, decisions are not: a trigger, invalidation or expiry that would have fired on a missed bar waits for the next live close. Bars cut short by crashes before this fix stay in the cache (BTC-USD 1m 17:22 UTC on 6 Nov) until *Repair candle history* is run.

**2 · A burst of triggers is a burst of Windows notifications — J3.** 24 plans firing on one bar showed 24 desktop toasts within a second.

**3 · A refused entry uses up the trigger — J3.** After the kill switch is reset, or a paused session resumed, a plan that fired meanwhile stays fired and cannot enter. Correct by design (the signature covered that bar), but nothing says so at the time.

**4 · A take-profit can book a loss — J2.** A target closer than the round-trip fee (0.5%) closed as `take_profit` with a negative P&L, twice. Arming does not warn.

**5 · Budgets of 0.01 arm.** There is no minimum; a live venue would refuse the order.

**6 · *Needs your attention* clips to one row** with its own scrollbar once it holds two items.

---

## 2026-11-06 · Prototype journey, end to end on the live stream — J1, J2, J3, J5

**Attempted:** research → draft → arm → monitor → position → close → review in the running app, simulated mode.

**Fixed the same day:** see ROADMAP, *Prototype journey walked end to end*. The two that mattered most were invisible until the walk reached them: a market entry threw on its first live trigger without recording it, and every review came back empty because thinking consumed the token cap.

**Open:**

**1 · Windows notifications show "Electron", not the app — J3.** Seen in the unpackaged dev run; not yet checked on an installed build.

**2 · The agent's tool calls read as raw markers in the chat — J1.** A tool call shows as a bare chip between paragraphs, with no sense of what it is doing or found. Wanted: calmer, more legible tool progress.

**3 · A triggered plan whose entry was refused stays *Triggered* in Active — J3.** No position exists and nothing more can happen until expiry, but the solid *Triggered* pill reads as "in a trade". **Resolved 2026-11-06:** the pill reads *Fired · no entry*.

---

## 2026-10-31 · Going public — first run by a second pair of eyes

**Attempted:** publish the repo, then run the app end to end on a fresh clone and
on the maintainer's machine.

**Fixed the same day** (defects, not friction): ten lazy `require` paths broken by
the `ipc/` split — the **kill switch** and the Windows Hello unlock threw at
runtime; the model picker loading for ever on a rejected key; a fresh-install
startup error from the basis monitor; no window icon on Linux/macOS.

**Open:**

**1 · A Revolut X key is required to get past onboarding — J0. Resolved 2026-10-31:**
setup completeness is decided in main, and simulated mode needs only an AI provider. Anyone without a
Revolut X account — most contributors — cannot try the app at all, even though
simulated mode needs no venue. The design already says so — *"Simulated is the
default and needs no credentials"* (`DECISIONS.md`, app modes) — so this is a
seam between design and build, not a new feature. Lands: simulated-only
onboarding.

**2 · Telegram failures read as "Telegram HTTP 400" — J3.** Telegram's reply says
why ("chat not found"), but the whole body is withheld because it can echo the
token. A wrong chat ID cost a debugging session. Lands: surface the short reason,
never the body.

**3 · A failed unlock points at Settings › Diagnostics, which is unreachable while
locked — J0.** Lands: show the error on the lock screen, or a button that opens the
log folder.

**5 · The chat's effort picker truncates its label ("High Effor") — U-3.** The
select is narrower than its longest option in both the drawer and the floating
window. Cosmetic, and exactly what one component set fixes. Found while taking the
README screenshots.

**4 · The agent reported indicator values timestamped July 2026 while the candles
were current — J1.** Reported by the agent itself during a demo run (visible in
the README's research screenshot); **not yet investigated or confirmed**. If true,
it is the project's recurring defect — a value shown with more confidence than it
earned — and outranks the rest of this list.

---

## 2026-08-01 · First UI test run — four frictions, one of which stopped the run

**Attempted:** the whole of the first UI test pass, first launch of
everything built 30–31 July.

**Got through §0 to §2 complete, then stopped.** The two defects found (§2.8, a
duplicate plan name surfacing as "couldn't read or write local data", and an
error banner outliving its form) were fixed immediately per the wrong-number
rule. These four are friction and are not fixed:

**1 · The plan/chart gesture is inverted — J2, and it blocked ~25 checks.**
Drawing could not be found, and the plan was expected to work like a template:
pick the armed plan from the bookmark panel and see it on the chart with its
alerts. What exists is draw ink → promote ink →
author a plan referencing it. What was reached for is select an armed plan → see
its levels on the chart. Both are legitimate; only the un-reached-for one is
built. **This is the entry that matters** — it is not a rough edge, it is a
missing seam, and it took §3, §4 and part of §5 with it. Promoted to a roadmap
item (**J-3**, Sprint 2) rather than left here, because friction that blocks a
third of the test surface is not friction. **Resolved 2026-08-01 by J-3:** the
bookmark panel leads with armed plans, and toggling one draws its levels on the
chart, labelled by role.

**2 · The feed chip could not be found at all — J0/J7. Closed same day.**
§1.1–1.3 were all ticked as *could not find it*. Verified by reading the code rather than by asking again:
the rename **works** — the venue chip renders the adapter's `displayName`
("Revolut X") and the `venueName` dependency is present, so the "reads Venue
forever" failure mode is not occurring. The checklist itself was wrong about
the other chip, which reads "Binance", not "Binance Spot".

The real finding was that note itself: **a status indicator nobody can
locate is not reporting status.** It was `--text-xs` in `--muted-foreground`,
no background, right-aligned in a 34px band — the quietest element on screen,
for a component whose stated purpose is that a feed going quiet is noticed
*without going looking*. Fixed: a real chip with a surface and border, one size
up, and a degraded feed now colours its whole label rather than only its 6px
dot. **Kept in this log because the lesson generalises** — the same reasoning
that makes an unreadable value a defect makes an unfindable status indicator
one, and neither shows up in a test that only asks "is it rendered".

**3 · Credentials is a status readout where an Integrations surface is expected
— J7. Closed 2026-08-01**, after it was raised a second time: Settings still
showed credentials the old way, with no integrations surface. The venue had been a port with a registry and declared
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
Two observations: it did not update when the interval changed in the header,
and it looked messy. The better follow-up question: does the session dashboard
need a chart at all, when Research has a far larger one?

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

**What happened:** the analysis fell back to TradingView, and the result was
shared with the agent instead. Research is usable enough to look at a chart, not usable
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

**Resolved, same day — decision: the goal is not to create another charting
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
