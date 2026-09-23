# Architecture

## Three cooperating layers

The native host agent owns task meaning. Jev selects browser actions. The local runtime owns the mechanics and stop
conditions. Each does the work it has the right information for.

| Layer | Responsibility | Deliberately delegated elsewhere |
| --- | --- | --- |
| Codex / Claude | Planning, reading and synthesis, text generation, exception handling, independent verification | Repetitive per-click decisions |
| Jev | Choosing an operation and its observed target; explicit handoff decisions | Writing field text, executing JavaScript, proving the whole task complete |
| Runtime | DOM observation, readiness, freshness, action execution, bounded waits, checkpoints, session state, telemetry | Semantic judgment about relevance or quality |

```mermaid
sequenceDiagram
    participant H as Native host agent
    participant R as CLI/MCP + warm daemon
    participant B as Chrome (direct CDP or extension)
    participant J as Jev / TypeSafe
    H->>R: run(goal, known inputs, until or completion)
    loop Until a boundary or budget
        R->>B: Observe visible state; bounded readiness wait
        B-->>R: Page text, candidates, values, document identity
        alt Fresh checkpoint already matches
            R-->>H: done + evidence (verified: false)
        else More action needed
            R->>J: One request with operation and independent target questions
            J-->>R: Operation + target / HANDOFF / DONE / BLOCKED
            alt Text or host reasoning needed
                R-->>H: Context + sessionId + requestId + handoff
                H->>R: resume with native text or after host assistance
            else Supported action
                R->>B: Revalidate target, execute once, settle
            end
        end
    end
    H->>B: Independent result check via ordinary script
```

The diagram describes boundaries, not unbounded retries. Sessions have action/decision/time budgets. A completed or
failed session must not blindly restart an uncertain external action.

## Entry points and transport

`bin/jev-browser-use.cjs` is an optional Node-compatible installation shim. The compiled `dist/jev-browser-use` embeds
Bun and the daemon bundle. `src/cli` parses scripts/commands and talks to a private Unix socket. `src/mcp/server.ts`
provides a stdio MCP interface over that same client transport; MCP does not run a separate browser loop.

The warm daemon (`src/daemon`) holds Puppeteer browser connections, a named-page registry and script execution contexts.
It can launch a persistent isolated Chrome profile, attach to HTTP/WebSocket CDP, attach through a host-owned Unix
socket, or use the extension relay. The home defaults to `~/.jev-browser-use/v1`; `v1` identifies the state/protocol
layout, not the project's 0.1.x release series. Set `JEV_BROWSER_USE_HOME` for isolation.

One page can have one active Jev burst. At a text/host handoff its lock is released so the host can inspect or act.
Ordinary scripts on the same page can interleave; callers must not start competing workflows. CLI and MCP should share
one daemon and connection URL when using the extension, which accepts one CDP client.

## Observation and action selection

`src/page/snapshot/inpage.ts` collects visible candidate controls and accessible names directly for Jev. It does not
construct the full ordinary ARIA snapshot first. Targets include operation eligibility, current values, link destinations
and nearby context. Observations cap candidates at 150 and text at 6,000 characters, flagging partial coverage.

`src/jev/model.ts` sends one TypeSafe request with **Choice** questions for the operation and speculative targets.
Questions are independent; each has its own instructions and candidate metadata. Only the chosen operation's target
is consumed. The adapter does not use a text completion API. It does not use Score/Noul in place of element choices.

`src/jev/browser.ts` checks that the document and target still match before dispatch. Click/selection checks are scoped
to target identity, context, form state, visibility, enabled state and occlusion; unrelated sidebar clocks need not
invalidate them. Text after a host handoff requires fresh context. Controls covered by overlays are not executable.
A freshness rejection causes another observation, not a retry of the browser mutation.

Ordinary post-action settling uses a short render wait. Autocomplete waits for the active picker's option content to
stay quiet for 150 ms, with a 300 ms minimum and 800 ms cap. Loading and pending controls receive bounded local waits.
These are readiness heuristics, not guarantees about every website's asynchronous behavior.

## Native text and handoffs

The host can bind known text to an exact URL and a unique accessible label using run-only `inputs`. A binding is
consumed once; other fields return `needs_text`. The host writes new text in the current conversation and resumes with
the returned single-use IDs. There is no extra OpenAI/Anthropic key or recursively launched agent.

Jev can choose `HANDOFF` with `reasoning`, `unsupported_control`, `missing_information` or `no_progress`. The runtime
also hands off for repeated stale observations, unsupported coverage, new windows and uncertain submissions.
`handoff.source` distinguishes these paths. `handoff.next` and `handoff.resume` describe how to continue; the host still
supplies the same page/connection and must resolve the reason first.

Identical resume requests replay their recorded receipt. Different payloads using the same token are rejected.
Sessions and receipts are in daemon memory and do not survive daemon restart, page closure or relay reconnection.
A new goal requires ending the previous session and starting a new one.

## Completion and uncertainty

`until` is a host-authored AND contract over URL, visible text and exact field states. The runtime evaluates it against
fresh observations before another inference request and after the final action. Loading, truncation and visible
unsupported frames prevent acceptance. A matching checkpoint returns evidence immediately. If Jev says DONE too early,
the result contains unmet checks and asks the host to inspect.

`completion` is a separate boundary for exactly one authorized submission. The host specifies the observed button label
and established success message. After dispatching that button the controller only observes; absent confirmation returns
`submission_unconfirmed`. A resume only checks for late feedback and cannot resubmit. Use either `until` or `completion`;
a checkpoint is not a submission guard and neither option grants authorization.

Every done result has `verified:false`. The host must check the actual task outcome, such as the saved record/permalink
or selected field values. A post containing “Jev” is not automatically relevant, original or the best result.

## Extension and relay

`extension/` contains the MV3 Chrome extension, adapted from the archived upstream implementation. Its popup starts
inactive. When enabled, a service worker connects to `ws://localhost:9222/extension`. It uses Chrome debugger and tab-group
APIs to create/manage the jev-browser-use group. It contains no Jev credentials or inference client.

`src/extension/relay.ts` exposes loopback CDP discovery and WebSocket sessions to Puppeteer and forwards commands to the
extension. It rejects website origins and non-loopback/DNS-rebinding hosts, sends a heartbeat, and never automatically
replays a timed-out command. Disconnection preserves tabs; disabling the extension detaches debugger sessions.

Extra page CDP sessions, separate browser contexts and closing the user's Chrome are unsupported. Popup tabs may not be
exposed through `listPages`; the host must inspect new-window handoffs. Extension mode and direct Chrome mode therefore
have different capability boundaries, even though the ordinary page/Jev APIs are shared.

## Data and trust boundaries

- The TypeSafe endpoint receives the goal and observed page data (including current non-password field values).
  Use Jev only on page data you intend to send to that provider.
- Password and upload controls are excluded from Jev action choices. Surrounding visible page text can still contain
  sensitive information; the adapter is not a general data-redaction system.
- The key is read from the CLI/MCP process environment and sent to the daemon through its private socket; it is not
  stored in browser extension settings or source control. Redirects from the provider endpoint are rejected.
- Traces omit supplied text and API keys, but normal page observations/results can contain text that was entered.
  Treat saved diagnostics as page data. The relay does not log page URLs or contents.
- Page contents are untrusted task data. The native host controls authorization for external writes; the skill must not
  turn a webpage instruction into permission.
- Scripts run in a fresh `node:vm` context, which is **not a security sandbox**. Only execute trusted scripts.

## Telemetry and recovery

Results include monotonic phase timings, UTC start/return timestamps, decision traces and a separate `requests` array.
`decisions` counts chooser invocations; `requests` counts HTTP attempts, including failures. An explicit HTTP
429/502/503/504/529 permits at most one inference retry before any action. Retry-After above one second returns an error;
ambiguous transport errors and malformed answers do not retry. **Browser actions never retry automatically.**

Default summary diagnostics omit large probability maps, which remain available through `status` with
`diagnostics:"full"` without another model call. Session wall time excludes initial navigation, earlier host reasoning
and later independent verification. Measure the entire host workflow separately when reporting end-to-end speed.

## Source map

| Path | Contents |
| --- | --- |
| `src/cli`, `src/shared` | CLI, configuration, IPC protocol, state paths |
| `src/daemon` | Warm daemon, browsers, named pages, script execution |
| `src/page` | Snapshots, refs, fill, screenshots, rendering helpers |
| `src/jev/controller.ts` | Session state machine, budgets, execution loop |
| `src/jev/model.ts` | TypeSafe request/response, bounded inference recovery |
| `src/jev/browser.ts` | Observation, guards, actions and readiness |
| `src/jev/checkpoint.ts`, `handoff.ts` | Deterministic evidence and host continuation |
| `src/mcp/server.ts` | Six renamed MCP tools |
| `src/extension/relay.ts`, `extension/` | Relay and Chrome extension |
| `skills/jev-browser-use`, plugin manifests | Host workflow instructions and discoverable metadata |
| `test`, `extension/__tests__`, `scripts/smoke-*.ts` | Offline regressions and opt-in real integration checks |

See [Jev contract](jev.md), [implementation decisions](design-decisions.md) and [upstream notices](../THIRD_PARTY_NOTICES.md).
