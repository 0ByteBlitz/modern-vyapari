---
name: revx-api
description: Revolut X REST API reference for this project — request signing, endpoints, rate limits, and gotchas. Use whenever writing or modifying code that talks to the Revolut X API (src/main/revx/), debugging 401/400 responses, or adding new endpoint coverage.
---

# Revolut X API — project reference

Base URL: `https://revx.revolut.com/api/1.0` · Official docs: https://developer.revolut.com/docs/api/revolut-x-crypto-exchange

## Signing (the part that breaks)

Message = `timestamp + METHOD + path + query + body`, concatenated with **no separators**:

- `timestamp`: ms epoch, identical to the `X-Revx-Timestamp` header value
- `METHOD`: uppercase
- `path`: starts at `/api` — e.g. `/api/1.0/orders/active` (NOT just `/orders/active`)
- `query`: without `?`, empty string if none — must match the actual URL query byte-for-byte (param order matters)
- `body`: minified JSON, empty string for GET

Sign with Ed25519 (`crypto.sign(null, message, privateKeyPem)`), base64-encode → `X-Revx-Signature`.
Headers: `X-Revx-API-Key` (64-char alphanumeric), `X-Revx-Timestamp`, `X-Revx-Signature`.

Debugging 401: almost always a message-construction mismatch — check path prefix, query ordering vs URLSearchParams serialization, and that body string signed == body string sent.

## Endpoints in use (read-only, Phase 0)

- `GET /balances` → array of `{currency, available, reserved, staked?, total}` (strings)
- `GET /candles/{symbol}?interval=&since=&until=` → `{data: [{start, open, high, low, close, volume}]}`; interval in **minutes** (integer); no-volume candles use mid-price
- `GET /tickers?symbols=` → `{data: [{symbol, bid, ask, mid, last_price}]}`
- `GET /configuration/pairs` → per-pair `base_step`, `quote_step`, `min_order_size`, `max_order_size`, `min_order_size_quote`, `status`
- `GET /order-book/{symbol}?limit=` (auth) — deeper than `GET /public/order-book/{symbol}` (5 levels max)

## Order endpoints (Phase 4+ ONLY — risk engine must exist first)

- `POST /orders` — body: `{client_order_id: uuid, symbol, side, order_configuration: {limit: {base_size, price, execution_instructions?}} | {market: {...}}}`. **Rate limit: 1,000 limit orders/day.**
- `PUT /orders/{venue_order_id}` — replace (new venue_order_id returned)
- `DELETE /orders/{venue_order_id}` / `DELETE /orders` (cancels ALL incl. conditional + TPSL)
- `GET /orders/active`, `/orders/historical` — cursor-paginated (`metadata.next_cursor`)
- `GET /orders/fills/{venue_order_id}`, `/trades/private/{symbol}`
- Venue supports **conditional and TP/SL order types** — every live position must carry a venue-side stop (plan §7)

## Gotchas

- Symbol format is `BTC-USD` in paths, but responses may show `BTC/USD` — normalize at the client boundary
- All monetary values are strings; never parse to float for arithmetic (display-only parsing is fine)
- 429 responses exist on all endpoints — respect the client-side token-bucket limiter
- `client_order_id` is the idempotency key — generate UUID before submit, persist before the HTTP call
