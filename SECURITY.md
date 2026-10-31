# Security policy

Modern Vyapari stores exchange and AI API keys and is designed to place orders. Security
reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's
[private vulnerability reporting](https://github.com/0ByteBlitz/modern-vyapari/security/advisories/new)
instead. Include what you found, how to reproduce it, and the impact you expect.

You should get an acknowledgement within 7 days. Please give a reasonable window for a fix
before public disclosure.

## In scope

- Secrets leaking: keys crossing IPC, appearing in logs, prompts, the database, error
  messages, crash output or network requests to the wrong host.
- Any path by which AI/LLM output — including prompt injection via fetched web pages — can
  arm a plan, place, modify or cancel an order, or change the venue.
- Renderer sandbox escapes, CSP bypasses, navigation/window-open guard bypasses.
- Risk-engine or kill-switch bypasses.
- Electron Fuses or packaging misconfiguration that weakens the above.

## Out of scope

- Losses from trading decisions the user signed.
- Vulnerabilities in third-party services (exchanges, Anthropic, Browserbase, Telegram).
- Attacks that require an already-compromised OS user account.

## Your own keys

- Use exchange API keys with the **minimum permissions** needed; never enable withdrawals.
- Restrict keys by IP where your exchange supports it.
- If you think a key leaked, revoke it at the exchange first, then report.
