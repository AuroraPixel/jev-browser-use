# Jev with Claude Code and Codex

jev-browser-use pairs a continuous Jev executor with a persistent Puppeteer browser. The host agent owns the goal,
text generation and outcome verification. Jev selects supported actions and can explicitly hand control back to the
host. No separate text-model API, MCP sampling or recursive agent invocation is required.

## Build and configure

Follow the [README installation guide](../README.md#install). Use the compiled `dist/jev-browser-use` on PATH.
Set `TYPESAFE_API_KEY` in the invoking CLI/MCP environment; optionally set `TYPESAFE_MODEL` (default `jev-latest`) and
`TYPESAFE_PROXY` (an HTTP(S) proxy). The default state root is `~/.jev-browser-use/v1`; override with
`JEV_BROWSER_USE_HOME` only when a separate runtime is needed. Keep the same home for CLI/MCP using one extension relay.

The key is read on each invocation and passed over the daemon's private socket, so an already-running daemon does not
need to restart after the calling environment changes. Do not put keys in goals, scripts or tool arguments. The endpoint
is fixed to `https://api.typesafe.ai/v1/systemone`; redirects are rejected. Git/macOS system proxies and SOCKS URLs are
not used automatically. The compiled binary does not load `.env` files by itself.

Jev receives page URLs, titles, visible text, candidate controls, current field values, goals and recent action history.
Password/upload controls are excluded from Jev actions; surrounding page text can still contain sensitive data. Session
state is in memory. Traces omit input text and keys, but observed page values can contain typed text. See
[data boundaries](architecture.md#data-and-trust-boundaries).

## Chrome extension

Build or download the bundled extension following [the README](../README.md#use-your-existing-chrome-profile), then start the loopback relay:

```bash
jev-browser-use relay                         # leave running; defaults to 127.0.0.1:9222
# Enable jev-browser-use in Chrome; the popup should say "Connected to relay".
jev-browser-use --connect http://127.0.0.1:9222 -e 'const p = await browser.getPage("main"); await p.goto("https://example.com"); await p.title()'
# Use this command as the MCP server instead of mcp --headless:
jev-browser-use mcp --connect http://127.0.0.1:9222 -t 60
```

The relay speaks the extension protocol from the bundled extension (derived from upstream revision `b549fb0`) and provides the browser-level CDP discovery
and sessions required by Puppeteer. The extension creates tabs in its **jev-browser-use** group in the existing Chrome
profile, so those tabs use that profile's cookies and logins. Only tabs managed by the extension are exposed; your
unrelated tabs are not automatically attached. Browser-wide settings, extra browser contexts, closing Chrome, and
additional page CDP sessions are unsupported. Ordinary page scripts, snapshots, screenshots and Jev work on the managed tabs.

Use the identical `connect` URL for normal scripts, Jev runs and resumes. One CDP client can connect at a time: CLI and
MCP share it through the same daemon and `JEV_BROWSER_USE_HOME`. Disconnecting the CDP client preserves the tabs; turning
off the extension detaches its debugger sessions. Relay/extension reconnects invalidate active Jev sessions; inspect the
page state before deciding to start a new goal. Commands are never retried by the relay after a timeout.

The relay accepts only loopback connections, rejects website origins and DNS rebinding hosts, and exposes no Jev key.
It sends an application heartbeat to keep the MV3 background connection alive and does not log page URLs or content.
For a popup stuck on **Connecting...**, check `http://127.0.0.1:9222/`: `extensionConnected` should be true. If the endpoint
is unreachable, start the relay. If it belongs to a different service, resolve that port conflict; the bundled extension
has port 9222 built in. Do not start a second relay or second extension against the same endpoint.

The relay can run as a user background service (for example a macOS LaunchAgent executing the compiled binary with
`relay`). Keep it running while using the extension. `jev-browser-use stop` disconnects the automation daemon; it does not
stop a separately managed relay or close the user's Chrome.

Opt-in compatibility test with an unpacked copy of the bundled extension:

```bash
JEV_BROWSER_USE_EXTENSION_DIR=/absolute/path/to/extension bun run scripts/smoke-extension.ts
```

This uses a temporary extension copy, random relay port and isolated Chrome profile. It checks the actual popup status,
page creation/navigation, snapshot, fill/click, screenshot, browser-session detach, reconnect, preserved state and close.

## CLI and script API

Initialize a named page with an ordinary script. Keep the same browser profile and headed/headless/connection flags
for subsequent calls (headed and headless are different browser instances).

```bash
jev-browser-use --headless -e 'const p = await browser.getPage("main"); await p.goto("https://example.com/search"); await p.snapshot()'
jev-browser-use --headless -t 60 jev <<'JSON'
{"page":"main","action":"run","goal":"Search for browser automation and open the first result","stepLimit":60}
JSON
```

A `needs_text` response has the session and continuation token, field label/value/context, page text and goal:

```json
{"status":"needs_text","sessionId":"…","requestId":"…","field":{"label":"Search","value":"","role":"searchbox"},"verified":false}
```

Claude/Codex reads that result and writes the field text natively. Pass the returned IDs verbatim in a second call:

```bash
jev-browser-use --headless -t 60 jev <<'JSON'
{"page":"main","action":"resume","sessionId":"RETURNED_SESSION","requestId":"RETURNED_REQUEST","text":"browser automation"}
JSON
```

An empty text string clears the field. A `paused` response resumes the same way without `text`. Status and stop use
`{"page":"main","action":"status","sessionId":"…"}` and `{"page":"main","action":"stop","sessionId":"…"}`.
Every response includes `steps`, `decisions`, active `elapsedMs`, recent action history and the last observed page.
A stop cannot undo an action already dispatched to Chrome; inspect the page before continuing.

For text already known before the run, supply `inputs` to avoid a host turn for each field:

```json
{"page":"main","action":"run","goal":"Search for browser automation and open the first result","inputs":[{"url":"https://example.com/search","label":"Search","text":"browser automation"}]}
```

Use an observed accessible field label and the exact HTTP(S) page URL, including query and fragment. Labels match with
whitespace normalized; there are no substring matches or URL wildcards. Jev still chooses when and where to type. A
matching value is used only when that label identifies exactly one visible editable candidate. Duplicate labels return
control before inserting anything; unmatched fields use the ordinary `needs_text` flow. Bindings are consumed once,
before dispatch (or when the field already has that value), and never reused after uncertain execution. Filled fields
are excluded from further text choices while their identity and value remain unchanged. A later cleared field requires
fresh host text. Up to 20 bindings and 20,000 total text characters are supported, on `run` only.
The configured completion button cannot be dispatched while provided inputs for the current URL remain unfilled.

Claude/Codex still writes text that requires reading new page content. For example, delegate searching and opening a
post to Jev, read the selected post in the host, then start a bounded reply run with the host-written reply in `inputs`
and the submission `completion` boundary. This needs no separate text-model API and keeps routine input inside Jev's loop.

Scripts use the identical API without the `page` key:

```javascript
const p = await browser.getPage("main");
await p.jev({ action: "run", goal: "Search for browser automation" });
// In the next script, getPage("main") and p.jev({action:"resume",sessionId,requestId,text}).
```

`--json` emits the usual NDJSON frames; read the result frame's `data`. The CLI/script transport can succeed while the
returned Jev `status` is `blocked` or `error`; always inspect that status. MCP additionally sets `isError` for `error`.
No provider errors include the raw response body or credentials. Only explicit transient inference responses allow one bounded retry (see telemetry below); browser mutations never retry automatically.

## MCP and bundled Skill

Configure a stdio MCP server in either host with:

- Command: the absolute path to this checkout's `dist/jev-browser-use`.
- Arguments: `mcp --headless` (optionally `-t 60`).
- Environment: `TYPESAFE_API_KEY` and a dedicated `JEV_BROWSER_USE_HOME`; optionally `TYPESAFE_PROXY` / `TYPESAFE_MODEL`.

`jev_browser_use_run` opens the page and verifies results. `jev_browser_use_jev` accepts the CLI JSON plus optional `browser`,
`headless`, `connect`, `timeout`; its JSON result is returned as `structuredContent` and text. `jev_browser_use_help` with
`{"topic":"jev"}` gives the embedded guide. MCP cancellation closes the request socket, aborts inference and prevents
later actions; status/stop calls can run while another request is in progress.

For agents that use the CLI Skill, install the bundled instructions with the built binary:

```bash
jev-browser-use install-skill --claude
jev-browser-use install-skill --codex
```

The Skill tells the current agent how to produce text, consume continuation tokens and independently verify results.
Do not run a second Jev session or a Puppeteer mutation on the same tab during an active burst.

## Contract and limits

| Result | Host action |
| --- | --- |
| `needs_text` | Supply authorized text with the returned `sessionId` / `requestId`. |
| `needs_host` | Read `handoffReason`, perform the needed host reasoning/action, then resume without text. |
| `paused` | Inspect progress; resume with the latest IDs and no text. |
| `done` | Independently verify every requirement using DOM, URL or screenshot evidence. |
| `blocked` | Inspect the page; use scripts or a new bounded goal if appropriate. |
| `error` / `stopped` | Inspect possible partial effects before doing anything further. |

`verified` is **always false**. Jev saying DONE is not verification. A dispatch failure records an `uncertain` history
entry before returning; that action is never retried automatically. Identical repeated resume payloads return the recorded
result without another mutation. Reusing a token with different text/options is rejected. Concurrent duplicate resumes
are rejected while the first is running. Old receipts return their original result; use `status` for current state.

Before a click/select, the runtime checks document/form state, the selected target's identity, semantics and nearby
context, current visibility, disabled state and occlusion in a scoped read. Unrelated sidebar updates and animation do
not force a new prediction. HTTP(S) navigation links outside forms/dialogs use their own name, resolved destination and
container identity rather than the container's changing video timers. A container is not offered as a click target when
its click point activates a nested interactive control or media element. Articles with timestamp/bookmark permalinks
offer those precise links instead of the whole article; each link retains the post's nearby text for target selection.
Field selection and explicit `inputs` use the scoped check. Host text requests refresh the
context before returning. Actual insertion after a host handoff and completion decisions validate the full observed
semantics (visible text, controls, values and document/form state), excluding internal target blobs and live-region IDs.
After input settles, the runtime verifies
that the editor retained exactly the requested value; mismatches stop before any subsequent submission.
Navigation, node replacement, changed values or an overlay invalidate a text request: the supplied text is discarded and
the session pauses with a fresh token. Resume to obtain a new decision and, if necessary, a fresh text request. A page that
keeps changing asks the host for help after three stale decisions. These checks reduce races; they cannot freeze page JavaScript or undo
an input already sent to Chrome. Other applications using CDP and page scripts can still modify the page.

Each burst holds a lock on the page. At a handoff the lock is released so the host can inspect it. Calls have a 120-second
ceiling plus the enclosing CLI/MCP deadline (Jev defaults to 60 seconds; flags/config override it). By default a call
continues until text, host help, completion or the session budget, without intermediate host turns. `maxSteps` is an
optional short burst (1–30); `stepLimit` defaults to 60 (1–100). Inference decisions are also capped at twice the session step limit. Sessions are per tab, kept only in daemon
memory and lost on restart or tab close. Provider timeouts and unrecovered errors end the session. Any recovered inference choice still requires freshness checks before action.

Native input/textarea fields use native value setters and input/change events. Contenteditable fields use a native
browser editing transaction, so editors that ignore synthetic input can update their state. The runtime selects the captured editor, checks focus/selection again after focus handlers, and uses Chrome Input.insertText.
Detected focus redirection is rejected before insertion; browser JavaScript can still race later protocol commands. Editors
requiring individual key events or a custom API can still need host assistance. Post-action waits are bounded to two
animation frames / 50ms for ordinary controls; autocomplete uses the bounded option-stability wait described below.

Jev observations collect visible candidate controls directly, reusing accessible-name and ref generation without building
the ordinary full ARIA snapshot. Visible text nodes are collected once. Every target question carries its own rules and
each choice includes current values, field focus and nearby context. Jev questions are independent: a target question
does not see the operation question's instructions. Click choices retain link destinations; CSS controls also retain
visible names and observed classes without inventing ARIA checked state. List ordinals are not field values.
An inserted value is not a confirmed autocomplete selection: resolve the current picker before filling covered fields.
Ordinary `page.snapshot()` behavior is unchanged.

The [official API](https://docs.typesafe.ai/primitives/choice) accepts textual state as a string, object or array.
This adapter uses Choice for the operation and speculative targets, and consumes only the selected operation's target.
Score is an ordered rating and Noul is a yes-probability; neither generates text or replaces an element choice.
The [fan-out pattern](https://docs.typesafe.ai/patterns/fan-out) keeps these independent questions in one network request.

The current adapter supports viewport-visible main-frame DOM controls, open shadow DOM, clicks, text entry, native single
selects, vertical scrolling and waits. Observations cap candidates at 150 and page text at 6000 characters. Visible frames
are flagged `unsupportedFrames`; use ordinary jev-browser-use scripts for iframe targets, closed shadow DOM, canvas, uploads,
passwords, multi-selects or other custom widgets. A truncated/partial observation is not proof of task completion.

## Host handoff and measurement

### Host-authored page checkpoints

Codex/Claude should define the next bounded task and its observable completion conditions. Jev selects supported
actions continuously; the runtime handles observation, readiness, freshness and the stop boundary. When the host knows
what success looks like, use `until` to avoid another model request just to recognize an already reached page:

```json
{"page":"research","action":"run","goal":"Search for Jev and open a relevant original post","inputs":[{"url":"https://x.com/explore","label":"Search query","text":"from:anishfn Jev"}],"until":{"url":{"origin":"https://x.com","pathnameIncludes":"/status/"},"text":["Jev"]}}
```

`until` is AND, not OR. `url.origin` must match exactly; `pathname` is exact and `pathnameIncludes` is a literal path
fragment (neither matches query parameters). `text` fragments match visible text with whitespace normalized, ignoring
case by default; `matchCase:true` makes prose matching strict. `fields`
checks unique visible accessible labels, optionally narrowed by role, with exact `value`, `checked` or `selected`:

```json
{"until":{"fields":[{"label":"First","checked":true},{"label":"Second","checked":false}]}}
```

The runtime stops with `done/checkpoint_reached` and `completionEvidence` as soon as every condition is observed,
even on the last allowed action. Loading, truncated observations and visible unsupported frames prevent acceptance.
Unrelated clocks or videos do not invalidate matching conditions. A model DONE that disagrees with the checkpoint
returns `needs_host` plus the unmet `checkpoint.checks`, rather than silently claiming success. Do not use weak text
conditions as a substitute for verifying the requested result: the X example establishes a post containing Jev is open,
not that it is the best or original post. Codex still reads, compares and verifies it. `verified` always remains false.

Use **either** `until` for page/state evidence **or** `completion` below for one authorized submission. A page checkpoint
does not provide the submission guard. Prepared inputs, continuation tokens and the prohibition on retrying uncertain
browser actions remain unchanged. If the full task needs reading and writing, finish a research checkpoint, let the
native host interpret and compose, then start a submission-bounded run with that already-written text.

### Compact handoffs and diagnostic retrieval

Results now include `handoff.source` (`model`, `runtime`, `text`), `handoff.next`, a short instruction and a `resume`
object containing the correct session/request IDs. For text, the host adds its natively written `text`; the page/field
context is already in the same result. For reasoning, inspect the result and unmet checks, use ordinary scripts for
unsupported controls if needed, then resume without text. A model reasoning handoff reads fresh context without waiting
for unrelated animation to stop. It never retries a mutation. New-window and uncertain-submission handoffs have distinct
next actions. The caller still supplies the page and the same browser/connection settings.

`diagnostics:"summary"` is the default: it keeps actions, model, latency, confidence, stale reasons, request sizes,
candidate counts, host context and HTTP-attempt telemetry, but omits large probability maps. The daemon retains them.
For full distributions, use `diagnostics:"full"` on run, or fetch them later without any model call or browser action:

```json
{"page":"research","action":"status","sessionId":"RETURNED_SESSION","diagnostics":"full"}
```

`startedAt` and `returnedAt` are UTC timestamps for joining host invocations; `timing.wallMs` uses a monotonic clock.
`requests` records each real HTTP attempt, including error status, elapsed time, payload bytes and whether it is being
retried. `decisions` counts chooser invocations; it is no longer an HTTP-request count when an inference retry occurs.
Explicit HTTP 429/502/503/504/529 responses allow at most one delayed retry of inference. Other HTTP errors, malformed
answers and ambiguous network failures do not retry. This recovery happens before any browser action; it never resends
a click, edit or submission. Failed response bodies and credentials are never retained in telemetry.
`Retry-After` is honored; a requested cooldown longer than one second returns the error instead of retrying early.

Autocomplete fields now wait for the active picker's visible option content to remain stable for 150ms (at least
300ms after insertion, at most 800ms), instead of accepting the first transient option. Ordinary controls retain the
short render wait. This trades a bounded local wait for fewer paid decisions against unfinished suggestions; it is not
a guarantee that every site's asynchronous picker has finished. Freshness and occlusion checks remain authoritative.

For a task ending in exactly one authorized submission, supply an explicit completion boundary:

```json
{"page":"reply","action":"run","goal":"Publish the requested reply once","completion":{"submitLabel":"Reply","successText":"Your post was sent."}}
```

Use the site's established exact button name and success message; the example is X's English reply composer.
After clicking that button, the controller only observes. A newly appearing or changed visible alert/status/live-region
message containing `successText` returns `done`, `stopReason: "submission_confirmed"`, and `completionEvidence`.
Old notifications and matching text in ordinary articles do not qualify. The runtime polls for up to 2.5 seconds without
another Jev prediction. If confirmation remains absent, it returns `needs_host`, `stopReason: "submission_unconfirmed"`;
resuming that session only checks for late feedback and cannot click or type again. A transport error remains uncertain
and is never retried. Completion is still `verified:false`: independently open the resulting record/permalink.

Navigation (`goto`, reload, back/forward) and Jev calls temporarily enable focused-page emulation so Chrome continues
rendering while its window is hidden or the desktop is locked. The caller's emulation preference is restored on success,
handoff, cancellation and errors. Covered controls are excluded from the model's action table. Main-page scrolling is
withheld while a visible dialog/menu/listbox is open; use host scripts for scrolling custom overlay contents.

The operation and target heads still share one TypeSafe request. A new `HANDOFF` operation selects one typed reason
(`reasoning`, `unsupported_control`, `missing_information`, `no_progress`) in that same request. It returns `needs_host`
with a continuation token. The host can inspect or operate the page, then resume the original goal without text. A goal
change requires stopping and starting a new session. `TYPE_TEXT` uses a matching known input or the host's native text generation.
No separate text-model API or recursive Claude/Codex process is introduced.

A new-window event on the existing CDP session returns `needs_host` / `new_window` with `openedWindows` containing the
browser-announced URLs. It stops the current tab's loop instead of repeatedly submitting against the unchanged opener.
These URLs are not proof of loaded results. Inspect the result tab independently; the bundled extension may not expose
popup tabs through `listPages`. Opening a new window does not bypass a configured single-submission completion boundary.

Three consecutive actions without an observed change also request host assistance. A visible main-region loading
indicator prevents accepting DONE immediately. Both safeguards are bounded; final correctness still needs independent
verification. Budget exhaustion has `stopReason: "step_limit"` / `"decision_limit"`, separate from a model BLOCKED choice.
A BLOCKED choice within three seconds of an observed navigation is rechecked locally, allowing a partially rendered
page to reveal content even when its loading indicator is absent. After a click, selection or text edit, early BLOCKED
and unsupported-control/no-progress handoffs get up to 3.5 seconds to observe an update. Reasoning and missing-information
handoffs remain immediate. No input or click is retried during these waits.
After navigation, a visible main-region loader is polled locally for up to five seconds before requesting more choices.
New busy states and temporarily disabled controls awaiting prepared text also get a bounded five-second local wait.
A model-selected WAIT after an action polls for a changed observation within that same deadline, reducing paid decisions
against an unchanged page. Disabled controls are read-only context, never offered as executable targets; a disabled control
by itself is not treated as loading. An expired pending-control wait hands back for inspection.

Unnamed checkboxes, radios and switches can use adjacent inline captions without borrowing an entire form's text.
Checkbox/switch target choices describe the checked state and the click's effect; action history records observed before/after
states. Repeating a checkbox/switch action from the same form state hands off before another toggle, including across bursts.
This bounds oscillation without assuming the requested final state. Intentional repeated state cycles may require host control.

Every result includes `timing`: `decisionMs`, `observeMs`, `preflightMs`, `actionMs`, `settleMs`, `hostWaitMs`, `wallMs`.
`elapsedMs` remains active controller time, excluding host waits. `trace` records decisions, API round-trip latency,
model identifier, target and outcome, including stale choices and host handoffs. Operation/selected-target confidence
and probability distributions are retained for diagnosis; confidence is not a guarantee of correctness. Each API decision also records
`requestBytes` and `candidateCount`; text choices record `textSource` (`provided` or `host`). Traces do not store typed text or keys.
Decision latency includes response transport/parsing and any inference retry wait; per-attempt `requests.latencyMs`
excludes the retry delay. Neither is pure server inference. `wallMs` covers this Jev session, not
initial navigation, the host's earlier work or independent final verification. Replayed resumes return original timings.

## Tests

`bun run test` uses local fixtures and fake model choices, with no paid Jev requests. It covers handoff, duplicate resumes,
stale documents/fields, covered targets, select values, bounded execution, cancellation and ordinary browser regressions.

The opt-in live smoke test uses a temporary browser home and a local form, invokes the real TypeSafe endpoint through the
built CLI and MCP, checks both host text handoffs and provided inputs, and verifies the resulting DOM and submission count:

```bash
JEV_LIVE_TEST=1 bun run scripts/smoke-jev.ts
# Or, with credentials in a gitignored local env file:
JEV_LIVE_TEST=1 bun run --env-file=.env.jev.local scripts/smoke-jev.ts
```

This command makes paid API requests; it is never included in the ordinary test suite. It stops its own daemon and removes
its temporary browser home on exit. See [third-party notices](../THIRD_PARTY_NOTICES.md) for Jev attribution.

`scripts/bench-jev-loop.ts <frozen-source-directory> [output.json]` compares a frozen pre-change source tree against the
current implementation on the same local form. Use an isolated `JEV_BROWSER_USE_HOME`; the baseline needs its dependencies.
It runs three alternating before/after pairs, independently verifies values and exactly one submission, and records
timing, requests and host calls. By default choices are deterministic; `JEV_LIVE_TEST=1` uses the configured TypeSafe API.
Navigation, final verification and host reasoning time are excluded. This is a bounded fixture comparison, not a claim
about general website speed.

`scripts/bench-jev-checkpoints.ts <frozen-source-directory> [output.json]` compares the same prepared search task on an
owned fixture with asynchronous suggestions and a continuously changing result page. It alternates three before/after
pairs and independently checks the final URL and content. Use `JEV_LIVE_TEST=1` for paid real-API measurements; the
default explicitly labelled 250ms simulated policy is only for reproducible regression diagnosis, not API speed claims.
