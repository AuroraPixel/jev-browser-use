# Contributing to jev-browser-use

Use Bun 1.3.14 for dependencies, builds, tests and TypeScript. The extension is a separate package under `extension/`.
Do not use a user's live browser profile for regression tests.

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun run build
bun run test
npm pack --dry-run
dist/jev-browser-use --version
dist/jev-browser-use --help | head -n 1
cd extension
bun install --frozen-lockfile
bun run typecheck
bun run test:run
bun run build
cd ..
bun run package:extension
JEV_BROWSER_USE_EXTENSION_DIR="$PWD/extension/.output/chrome-mv3" bun run scripts/smoke-extension.ts
```

Normal tests use deterministic model choices and local fixtures. The actual extension smoke check uses an isolated
Chrome profile and random relay port. `JEV_LIVE_TEST=1 bun run scripts/smoke-jev.ts` is an opt-in paid API check with a
local form; supply your own key in the environment. It must never run by default in CI.

Runtime state defaults to `~/.jev-browser-use/v1`. Use a temporary `JEV_BROWSER_USE_HOME` for experiments and tests.
Keep credentials, profiles, temporary artifacts and diagnostic page contents out of commits. Update the English/Chinese
README, `docs/help.md`, `docs/jev.md` and the skill when changing their public contract. Help is embedded into the binary.

Preserve upstream copyright notices. See [architecture](docs/architecture.md), [design decisions](docs/design-decisions.md)
and [release process](RELEASING.md). Report reproducible bugs through this repository's issues, removing keys and private
page contents from logs first.
