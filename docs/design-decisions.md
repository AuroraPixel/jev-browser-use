# Design decisions

This document describes the independent jev-browser-use project. Upstream provenance is recorded in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), not presented as this project's release history.

## Identity and isolation

The repository, command, plugin and skill are named `jev-browser-use`; MCP tools use `jev_browser_use_*` and runtime
settings use `JEV_BROWSER_USE_*`. TypeSafe's `TYPESAFE_*` provider variables keep their existing names. The default state
root `~/.jev-browser-use/v1` prevents accidental reuse of a dev-browser daemon or Chrome profile. The extension is built
from checked-in source and has its own display name, tab-group name and storage key. Both extensions use relay port
9222 for protocol compatibility, so users must enable only one against that relay.

## Keep native reasoning in the host

Codex/Claude already has task context and a text model. Native text handoffs avoid another model provider and preserve
that context. Jev can explicitly request reasoning/assistance; known field text can be prepared once. A session represents
a bounded goal, not an entire open-ended task. See [architecture](architecture.md) for the controller boundaries.

## Warm runtime, direct control when appropriate

A thin compiled client talks to a persistent Bun daemon embedding Puppeteer. Named pages persist, and host scripts use
real Puppeteer APIs with snapshot/ref/fill helpers. Exact known actions and unsupported controls can use these scripts;
Jev is useful when action selection should be delegated continuously.

Launched Chrome profiles belong to this runtime. An externally connected browser belongs to its host and is never
closed by idle cleanup. Only touched tabs receive extensions when attached. Input across tabs uses a bring-to-front lock.
Two scripts on the same page can interleave; an active Jev burst holds its page lock.

## Explicit lifecycle and uncertainty

`BrowserStoppedError` distinguishes an intentionally stopped runtime browser from an arbitrary protocol failure.
Dialogs on managed tabs are auto-accepted; unrelated attached tabs retain their own behavior. Script execution contexts
are retired at completion/deadline so detached operations cannot outlive the command. This is lifecycle control, not a
security sandbox. Browser-side JavaScript can still race later protocol commands.

Freshness checks happen after inference and before action. Bounded waits reduce decisions against half-rendered pages.
Only explicit transient inference HTTP responses get one retry. An uncertain browser mutation never does. A host
checkpoint is evidence for one stage, and final semantic verification remains the host's responsibility.

## Packaging and releases

Bun compiles one binary per supported platform. The optional Node shim validates SHA256SUMS before installation;
GitHub assets and the default download repository belong to AuroraPixel/jev-browser-use. The extension has a separate
Bun lockfile and WXT build. GitHub tag releases distribute binaries, extension ZIP and checksums. Npm publishing is not
automatic and must not be advertised before a separate registry release exists.

## Compatibility

The inherited `migrate-from-doobie` command remains available as an explicit, non-destructive import into an empty
runtime home. It is not an automatic migration from dev-browser. The extension relay retains the upstream wire protocol;
Jev's DOM support does not imply support for every Chromium or website interaction.
