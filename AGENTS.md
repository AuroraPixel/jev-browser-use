# Repository guide

This repository ships `jev-browser-use`, a Bun-compiled browser automation CLI and warm daemon built on Puppeteer.

## Tooling

- Use Bun for dependency installation, builds, tests, and TypeScript tooling. Do not use pnpm.
- The npm package contains a small Node-compatible shim and download scripts; test those under Node as well as Bun.
- `docs/help.md` is embedded into the binary and is the source of truth for `jev-browser-use --help`.

## Validation

Run before finishing runtime changes:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun run build
bun run test
```

For packaging or release changes, also run:

```bash
npm pack --dry-run
dist/jev-browser-use --version
dist/jev-browser-use --help | head -n 1
```

Tests that launch Chrome should set `JEV_BROWSER_USE_HOME` to a temporary directory. Never point tests at a user's real
`~/.jev-browser-use/v1` state.

## Independent project identity

Use `jev-browser-use` for the CLI, extension, plugin and skill; `jev_browser_use_*` for MCP tools and
`JEV_BROWSER_USE_*` for runtime environment settings. Keep upstream names only in attribution and explicit migration
notes. Preserve `LICENSE` and `THIRD_PARTY_NOTICES.md`. Do not copy keys, profiles or local diagnostics into the repository.

## Extension

The extension is a separate Bun package. For extension or release changes, run:

```bash
cd extension
bun install --frozen-lockfile
bun run typecheck
bun run test:run
bun run build
cd ..
bun run package:extension
JEV_BROWSER_USE_EXTENSION_DIR="$PWD/extension/.output/chrome-mv3" bun run scripts/smoke-extension.ts
```

The smoke check creates its own Chrome profile and relay. Never replace the user's installed extension for a test.
