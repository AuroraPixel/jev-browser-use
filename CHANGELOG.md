# Changelog

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
