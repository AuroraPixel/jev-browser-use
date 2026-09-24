# Changelog

## Unreleased

- Add fresh pre-submit conditions, post-submit checkpoints and persistent task progress; uncertain submissions remain observe-only.
- Observe visible nested iframe controls with document-scoped refs; adopt managed popups and retain opener/URL changes.
- Add bounded `page.interact` relocation and label-checked tooltip reading, with rendering leases during normal actions/waits.

- Commit recognized autocomplete selections before other edits/submission; support keyboard-driven display/identity pickers without exposing hidden values.
- Add same-row result checkpoints and reject goal-only DONE on pending selections, incomplete observations or low confidence.
- Conditional browser plans with native host authoring, local exact actions, dynamic Jev goal stages and evidence-based branches.
- Verified, bounded in-memory semantic bindings with document/context/competitor invalidation.
- Configurable confidence handoffs, observation-only waiting and per-stage routing diagnostics.
- Intrinsic text/checkbox/dropdown verification, including duplicate-valued native options; no replay while awaiting action evidence.
- Matched cold/warm plan benchmarks and CLI/MCP documentation.

## 0.1.0 — 2026-09-23

Initial independent release of **jev-browser-use**.

- Separate repository, executable, state directory, environment variables, MCP tools and agent skills.
- Native Codex/Claude reasoning and text paired with a continuous Jev operation/target loop.
- Known-text inputs, host-authored checkpoints, typed handoffs and single-submission completion boundaries.
- Scoped freshness checks, bounded rendering/readiness waits, idempotent continuations and per-request telemetry.
- Chrome extension source, builds, tests and distribution alongside the loopback CDP relay.
- English/Chinese getting-started guides, architecture, API contracts and explicit upstream attribution.

The runtime and extension build on dev-browser; operation/target fan-out and parts of the guard/wait design build on
jev-ultrafast. Their earlier releases are upstream history, not jev-browser-use releases. See THIRD_PARTY_NOTICES.md.
