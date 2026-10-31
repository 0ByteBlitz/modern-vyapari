# Docs

The design record for Modern Vyapari. It is unusually thorough because the project
was built with one rule above the others: **every number measured, every control
real, every claim falsifiable** — and most of the rules in `CLAUDE.md` exist
because something went wrong without them. These files explain *why*.

Several were written as a single-user design diary before the project went public
(31 October 2026), so they speak of "the owner" and of a launch date that has
passed. Each file opens with its current status.

## Which file, for what

| File | Read it when you want to know… |
|---|---|
| [`JOURNEYS.md`](JOURNEYS.md) | What the app is for — seven end-to-end journeys and what is built for each. **Start here.** |
| [`ROADMAP.md`](ROADMAP.md) | What is built, what is open, and **where contributions help most** (top section). |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the code is layered, the venue/feed integration seam, and what runs when nobody is typing. |
| [`FRICTION.md`](FRICTION.md) | What is rough or broken right now — the honest list. A good place to find a first PR. |
| [`DESIGN-NOTES.md`](DESIGN-NOTES.md) | Deep dives: security posture, calibration record, app modes, conditional lessons, paper cash. |
| [`DECISIONS.md`](DECISIONS.md) | The incident behind each rule, roughly chronological. Read the relevant entry before deciding a rule does not apply. |
| [`PLAN.md`](PLAN.md) | The original architecture plan. Still the reference for the risk engine, security model and **§17 scenario plans**; its strategy sections are frozen. |

## Reading order, by goal

- **Using the app:** the main [`README`](../README.md) → `JOURNEYS.md`.
- **First contribution:** [`CONTRIBUTING.md`](../CONTRIBUTING.md) → [`CLAUDE.md`](../CLAUDE.md) → the *Open* section of `ROADMAP.md` or an open entry in `FRICTION.md`.
- **Touching a venue, a feed or a background job:** `ARCHITECTURE.md` first.
- **Touching the order path, risk engine, credentials or agent tools:** `CLAUDE.md`'s hard rules → the matching `DECISIONS.md` entries → `PLAN.md` §7 and §11.

## Glossary

| Term | Meaning |
|---|---|
| **Owner** | The person using the app — the human who authors and signs plans. Not a GitHub role. |
| **Plan** | The product's one object: a falsifiable thesis with stated assumptions, a thesis invalidation separate from the stop, a hard expiry and its own risk budget. |
| **Arm / armed** | Signing a plan. The signature is given at arming, not at the fill; the engine then executes the signed terms. |
| **Level reference** | A named price level (static or derived) the engine resolves every bar — what a plan's triggers and stops are written in. |
| **Analysis feed / venue** | Binance public data for charts, indicators and paper fills / the exchange for balances, orders and fills. Never mixed in one computation. |
| **Simulated / live** | App modes with separate databases. Simulated is the default; live order placement is not built. |
| **Calibration record** | Statistics about the *planner*, grouped by assumption tag across plans — how often a thesis type triggers, invalidates or reaches target. |
| **J0–J7** | The seven journeys in `JOURNEYS.md`. **J3 — "the plan executes without me"** is the spine. |
| **S1-2, S3-6, …** | Sprint items in `ROADMAP.md` (sprint – item). **J-n** came from the journeys exercise, **N-n** are post-launch, **L-n** are launch-week checks. |
| **`[x]` / `[~]` / `[ ]`** | Done / partly done / not started, in `ROADMAP.md`. |
| **Frozen** | The strategy path (spec authoring, backtesting, promotion ladder). Code kept because plans share its engine; not to be built on. |

## Keeping docs honest

Behaviour and the docs describing it change in the same PR. When a doc and the code
disagree, the code is the bug report for the doc — fix whichever is wrong, and say
which journey the change serves.
