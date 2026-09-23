# Releasing jev-browser-use

GitHub releases contain four compiled CLI binaries (macOS/Linux × ARM64/x64), the Chrome extension ZIP and
`SHA256SUMS`. This workflow does **not** publish to npm. Do not instruct users to install from the npm registry until
an independently configured and verified registry release exists.

## Prepare

1. Update the version in `package.json`, `extension/package.json`, both plugin manifests, the Claude marketplace metadata
   and `CHANGELOG.md`. Run `bun install` in the root and extension directories to refresh their lockfiles.
2. Run the validation commands in [CONTRIBUTING.md](CONTRIBUTING.md), including extension build and smoke check.
3. Inspect `npm pack --dry-run`, the extension ZIP and `git diff --check`. Check staged content for keys, local browser
   state and private files. `.env.example` must contain placeholders only.
4. Commit to `main` and wait for CI on both supported runner platforms.

## Publish on GitHub

```bash
# The tag must exactly match package.json, e.g. v0.1.0.
git tag "v$(bun -p 'require("./package.json").version')"
git push origin --tags
```

The tag workflow type-checks, cross-compiles, packages the extension, creates checksums, smoke-checks Linux x64 and
creates a GitHub Release. A tag containing `-` is marked as a prerelease. Never reuse a published tag to replace source.
If a release job fails, inspect its logs and retry that job when the failure is transient.

Verify the resulting release:

```bash
gh run list --workflow release.yml --limit 3
gh release view --repo AuroraPixel/jev-browser-use
# Download into an empty temporary directory, then:
sha256sum -c SHA256SUMS       # Linux
# shasum -a 256 -c SHA256SUMS # macOS
```

Run the downloaded platform binary with `--version`, `--help`, and an isolated local browser script. Load the packaged
extension into a temporary Chrome profile and confirm relay navigation/fill/click/reconnect. Test npm shims under both
Node and Bun using local download fixtures; cross-compilation alone does not prove all platform runtimes work.

## Optional npm publication

The package retains a Node-compatible shim and checksum download scripts for future registry distribution. Its default
binary URL is this repository's GitHub release for `package.json.version`. A registry publication requires separate
maintainer intent, package ownership and credentials/trusted-publisher configuration. Do not repoint the download base
to upstream dev-browser or include private environment files, browser profiles or uncompiled dependencies in the package.

## Manual release when hosted runners are unavailable

If GitHub reports an account/runner problem before any job starts, distinguish that from a test failure. Complete the
local checks first, then cross-compile from the clean release commit:

```bash
bun run package:extension
for target in bun-linux-x64-baseline bun-linux-arm64 bun-darwin-arm64 bun-darwin-x64-baseline; do
  asset="${target#bun-}"
  bun run scripts/build.ts all --target "$target" --outfile "dist/jev-browser-use-${asset%-baseline}"
done
(cd dist && shasum -a 256 jev-browser-use-* > SHA256SUMS)
# Write concrete validation results and any untested target limitations to release-notes.md outside the repo.
gh release create "v$(bun -p 'require("./package.json").version')" \
  --target main --title "jev-browser-use $(bun -p 'require("./package.json").version')" \
  --notes-file /absolute/path/to/release-notes.md dist/jev-browser-use-* dist/SHA256SUMS
```

Verify remote source, visibility, asset hashes and the downloaded native binary after publication. Cross-compiled targets
that have not run natively must be identified in the release notes. Keep the hosted workflow enabled and rerun it after
the account/runner issue is resolved; do not report an unstarted job as a passing platform test.

The x64 assets use Bun baseline targets so the release does not require AVX/AVX2-capable CPUs.
