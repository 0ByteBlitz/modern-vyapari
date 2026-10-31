---
name: trading-safety
description: Non-negotiable safety rules for this trading bot. MUST be consulted before writing or modifying any code that creates, submits, modifies, or cancels orders, touches the risk engine, handles credentials, or changes strategy execution logic.
---

# Trading safety rules (from docs/PLAN.md §1, §7, §7.1)

These rules override convenience, performance, and feature requests. If a requested change conflicts, stop and flag the conflict instead of implementing it.

## Execution path

1. **No AI in the order path.** Claude/LLM output may create an `OrderIntent` record — nothing else. Only the deterministic risk engine may approve an intent; only the execution engine may submit it.
2. Every order passes ALL risk checks at submit time: per-pair capital %, max order size, daily loss caps (pair + global), daily trade count, order budget (1,000/day venue cap), price sanity vs current Revolut X mid, balance check, duplicate suppression via `client_order_id`.
3. **Entry is incomplete until its venue-side TP/SL stop is confirmed.** No naked positions, ever — including paper mode (simulate the same invariant).
4. Kill switch and auto-pause states must be checked before every submission. A paused session/strategy submits nothing.
5. After crash/restart: reconcile against the exchange (source of truth) and start PAUSED. Never auto-resume trading.

## Change discipline

- New order-affecting code requires: audit_log entries before submission, idempotent retries, and a test against the paper engine first.
- Never widen a risk limit in code. Limits change only via the settings UI with typed confirmation.
- Fail-safe default is always "stop and hold, then notify" — never improvise recovery logic that opens new risk.

## Secrets

- Private key + API key: main process only. Never in IPC payloads, logs, error messages, prompts sent to Claude, or the DB.
- Anything that could log a request must redact headers.

## Money math

- Prices/quantities are strings end-to-end; arithmetic via integer/decimal-safe utilities only (no IEEE floats).
- Respect venue steps: quantize sizes to `base_step`/`quote_step` from `/configuration/pairs`, validate against min/max before submit.
