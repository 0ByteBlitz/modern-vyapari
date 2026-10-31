# Contributing to Modern Vyapari

Thanks for helping. This project handles API keys and, eventually, real money — so the bar
is correctness over speed. A small, verified PR beats a large, plausible one.

## Before you start

1. Read [`CLAUDE.md`](CLAUDE.md) — the hard rules apply to humans too.
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
- Use [Conventional Commits](https://www.conventionalcommits.org/) style subjects
  (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

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

## Using AI coding agents

Welcome — this repo is set up for them. `CLAUDE.md` and `.claude/skills/` load automatically
in Claude Code. You remain responsible for every line: review AI-written code as carefully as
your own, and never let an agent run anything against a live exchange account.

## Code of conduct

Be kind and assume good faith. See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
