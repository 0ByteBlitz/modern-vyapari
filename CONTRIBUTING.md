# Contributing to Modern Vyapari

Thanks for helping. This project handles API keys and, eventually, real money — so the bar
is correctness over speed. A small, verified PR beats a large, plausible one.

## Before you start

1. Read [`AGENTS.md`](AGENTS.md) — the hard rules apply to humans too.
2. Skim [`docs/README.md`](docs/README.md) — the docs map and glossary ("owner",
   J0–J7, sprint IDs) — then [`docs/JOURNEYS.md`](docs/JOURNEYS.md). A good PR says which journey and step it
   serves. If it serves none, it should be infrastructure with a named dependant.
3. For anything bigger than a bug fix, **open an issue first** so we can agree on the shape
   before you write it. Check [`docs/ROADMAP.md`](docs/ROADMAP.md) — several features are
   deferred *for a stated reason*; re-proposing one is welcome if you engage with that reason.

## Development setup

```bash
git clone https://github.com/<you>/modern-vyapari.git
cd modern-vyapari
npm install
npm test          # no network needed
npm run typecheck
npm start         # build + launch
```

Requires Node.js 22.13+. Use a **paper / simulated** setup while developing. Never test
against a funded exchange account.

## Pull requests

- **Keep it scoped.** One concern per PR. Don't bundle a refactor into a bug fix.
- **`npm test` and `npm run typecheck` must pass.** CI runs both.
- **Add a test for new logic** in `plans/`, `risk/`, `paper/`, `insights/` or
  `integrations/`. Tests must not touch the network.
- **Docs change with behaviour.** If you change how something works, update the doc that
  describes it in the same PR.
- **New IPC channel?** Add the preload method in the same change (`ipc-surface.test.ts`
  enforces this).
- **New dependency?** Explain what zero-dependency alternative you rejected and why.
- Follow the title, body and comment conventions below. They apply to everyone,
  people and agents alike.

### PR titles

```
type(scope): summary
```

- **type**, one of: `feat` (new behaviour), `fix` (wrong behaviour made right),
  `docs`, `refactor` (no behaviour change), `test`, `chore` (deps, tooling),
  `ci`, `perf`.
- **scope**: optional. Name the area, lowercase: `plans`, `paper`, `agent`, `ai`,
  `feed`, `alerts`, `risk`, `security`, `ui`, `onboarding`, `site`, `roadmap`.
  Leave it out when a change spans areas evenly.
- **summary**: lowercase, no trailing period, at most 72 characters for the whole
  title. Say what is now true, not what you did: `fix(alerts): one buffer entry per bar`,
  not `fix(alerts): fixed a bug in the buffer`.
- **A series** ends with `N/M`: `feat(ui): signed redesign 2/5 — home, plans`.
- Commit subjects follow the same format.

CI checks the title format (`.github/workflows/pr-title.yml`), so a wrong title fails
the PR until it is edited.

### PR bodies

Use the template (`.github/PULL_REQUEST_TEMPLATE.md`) every time, with its sections
in order. Don't delete or reorder them.

- **What and why** names the journey and step (`J3, the trigger opens a position`)
  and links the issue, or says there is none.
- **How I verified it** lists commands run and what was observed. Tick a box only
  for something you actually did. An unticked box says why.
- **Safety checklist**: every line is answered. Mark `N/A` with the reason, never
  by leaving the box empty.
- **Agent-authored PRs** end with the agent's attribution line.

### PR comments

A comment is one of these four kinds, and starts with its label in bold so the
thread can be scanned:

| Label | When | Contains |
|---|---|---|
| **Verified** | after testing beyond what the body says | what was run, what was observed, what was not checked |
| **Changed** | after pushing in response to review | the commit, and one line per point addressed |
| **Reply** | answering one review thread | what changed, or why nothing did, in one or two sentences |
| **Superseded** | before closing in favour of another PR | the PR number and what it covers that this one did not |

- One comment per event. Don't post a running commentary.
- No restating the diff. Link the commit instead.
- A comment written by an agent ends with the line
  `_🤖 Posted by [Claude Code](https://claude.com/claude-code)_`, or that agent's
  equivalent, so a reader knows no person checked it.
- Bot status comments, such as a skipped automatic review, need no reply.

## Changes that get extra scrutiny

Anything that touches the order path, the risk engine, the kill switch, credentials, the
agent's tool catalogue, or the main↔renderer boundary. These PRs need:

- a clear statement of what invariant could break and why it doesn't;
- tests against the paper engine for order-affecting code;
- no new way for AI output to reach execution. **This one is non-negotiable.**

## Adding a venue (exchange) adapter

The venue sits behind a port in `src/main/integrations/venue/`. An adapter:

- implements `port.ts` and declares its capabilities honestly (e.g. `canPlaceOrders: false`
  until execution is real — **a stub that returns plausible success is a bug**);
- registers in `registry.ts`;
- keeps all wire formats and symbol translation inside the adapter;
- comes with a test alongside `venue-port.test.ts`.

## Adding an AI provider adapter

The model vendor sits behind `src/main/ai/port.ts`. An adapter:

- lives in `src/main/ai/` and is the **only** file that imports its SDK
  (`vendor-boundary.test.ts` fails otherwise);
- declares `capabilities` honestly — server-side web search, prompt caching, vision,
  and how reliable its tool calling is (`"basic"` for most local models);
- translates the app's messages and tool specs to its wire format, and back;
- passes the agent-loop contract in `agent-loop.test.ts` against a fake transport,
  so it can be tested without a key;
- registers in `ai/registry.ts`.

The agent's tools belong to the app, not the provider, so no adapter can widen what
the agent is allowed to do. One OpenAI-compatible adapter with a configurable base URL
covers OpenAI, OpenRouter, Ollama, LM Studio and Gemini's compatible endpoint — see
`docs/ARCHITECTURE.md`, *Vendor neutrality*.

## Using AI coding agents

Welcome — this repo is set up for them. `AGENTS.md` holds the rules for every agent;
`CLAUDE.md` only imports it, so Claude Code loads the same file, along with `.claude/skills/`. You remain responsible for every line: review AI-written code as carefully as
your own, and never let an agent run anything against a live exchange account.

## Code of conduct

Be kind and assume good faith. See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
