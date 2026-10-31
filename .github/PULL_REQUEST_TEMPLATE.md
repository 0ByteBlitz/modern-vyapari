## What and why

<!-- What does this change, and which journey (J0–J7 in docs/JOURNEYS.md) and step does it serve? -->

Closes #

## How I verified it

<!-- Commands you ran and what you observed. "Should work" is not verification. -->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] I ran the app and exercised the changed path (or explain why not)

## Safety checklist

- [ ] No AI/LLM output can reach order placement, plan arming or venue choice
- [ ] No secret crosses IPC or reaches logs, prompts, the DB or error messages
- [ ] Money values stay strings; no float arithmetic on prices or quantities
- [ ] New IPC channel → preload method added in this PR (or N/A)
- [ ] DB writes broadcast `data:updated` (or N/A)
- [ ] Docs updated where behaviour changed (or N/A)
