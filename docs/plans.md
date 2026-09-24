# Conditional browser plans

The native Codex/Claude host compiles the task into a small conditional program. The local runtime executes grounded
actions, Jev resolves semantic choices, and the host handles new reasoning, text or unsupported visual interactions.
No additional text-model API or training is required. The ordinary goal-only Jev loop remains available.

## Authoring

Observe the page once. Describe identities with observed accessible labels, roles, link destinations and surrounding
context. Do not invent selectors or predict elements on an unseen page. Use a goal stage for unfamiliar widgets;
it retains Jev's dynamic operation/target loop until its observable checkpoint. Known adjacent actions can run locally
inside the same invocation. Each action still performs its normal freshness, visibility and hit-point checks.

```javascript
const p = await browser.getPage("main");
await p.goto("https://your-app.example/profile");
await p.jev({
  action: "run",
  goal: "Set the supplied display name, select Pro and enable updates",
  plan: {
    origins: ["https://your-app.example"],
    targets: {
      name: {label: "Display name", role: "textbox"},
      tier: {label: "Tier"},
      updates: {label: "Updates", role: "checkbox"}
    },
    stages: [
      {id: "name", goal: "Set the display name",
       action: {operation: "TYPE_TEXT", target: "name", text: "Ada"}},
      {id: "tier", goal: "Select Pro",
       action: {operation: "SELECT", target: "tier", option: {label: "Pro"}}},
      {id: "updates", goal: "Enable updates",
       action: {operation: "CLICK", target: "updates", checked: true}}
    ]
  }
});
```

These illustrative labels must be replaced with labels actually observed on the target site.
CLI `jev-browser-use jev -e '<JSON>'` and MCP `jev_browser_use_jev` accept the same plan with an additional `page`.
Plan-only local work needs no Jev key; unresolved semantic choices require `TYPESAFE_API_KEY`.

## Contract

- `origins`: 1–10 exact HTTP(S) origins. A cross-origin navigation hands off before further actions or text insertion.
- `targets`: at most 30 aliases. `label`, `role`, `contextIncludes` and `href` are conjunctive hard filters.
  A unique exact label/href can bind locally. A `description` adds a semantic constraint and requires Jev on first use,
  even if only one control matches the hard filters. All compatible candidates remain available to that decision.
- `stages`: 1–30 stages, each with an `id` and bounded `goal`. Entry defaults to the first stage; `start` overrides it.
- `action` declares TYPE_TEXT, SELECT or CLICK. Only that operation and its compatible observed targets can execute.
  Jev may scroll, wait or hand off when the target is unavailable. For multi-action discovery use a goal stage.
- TYPE_TEXT accepts known `text`, including an empty string to clear. Omit text to request native host writing.
  Values must total at most 20,000 characters. The actual editor value is checked before the stage completes.
- SELECT requires an exact option `label`, `value` or both. Verification uses the actual selected index and value,
  so different labels sharing a value are not confused. Ambiguous matching options cannot be dispatched.
- CLICK with `checked` ensures a checkbox/switch state. Other clicks require `until`. A click is dispatched once,
  then the runtime observes its result. This includes clicks that submit forms; author specific result evidence.
- `until` uses the same conjunctive URL/text/field checkpoint as ordinary Jev runs. Field actions verify their intrinsic
  result AND any extra checkpoint. Avoid URL-only evidence for pages whose body loads asynchronously.
- `before` requires positive precondition evidence before acting. `wait:true` makes an observation-only stage.
- `timeoutMs` bounds local waiting (100–30,000 ms; default 5,000). Expiry returns `needs_host`. Resuming a dispatched
  stage only checks for late evidence; it never repeats its action. Repair the UI or stop and compile a revised plan.
- On success, the first matching `branches:[{when: checkpoint, next: "stage-id"}]` wins. Otherwise `next` applies:
  omitted means the following array element, null ends the plan. Conditions are evaluated on a fresh, complete
  observation. Immediate branch cycles and more than 200 transitions hand off; action/decision budgets still apply.

Do not combine `plan` with top-level `inputs`, `until` or `completion`. Plans own their stage values and conditions.
Completing a plan proves only those authored conditions. `verified` stays false; the host independently checks the task.
A submission whose acknowledgement is uncertain must be inspected before starting a replacement plan.

## Unknown controls and branching

```javascript
{
  id: "choose-date",
  goal: "Open the date picker and choose the requested date",
  until: {text: ["Chosen date: 24 September 2026"]},
  branches: [
    {when: {text: ["Additional details required"]}, next: "details"}
  ],
  next: "review"
}
```

With no `action` this is a generic bounded Jev goal. Its controls need not be known in advance. Different pages may use
native inputs, popovers or several dialogs. The host supplies goal-specific completion evidence and later stage ids.
Canvas, inaccessible frames, uploads and unsupported widgets can return to the host's ordinary browser/vision tools;
the plan executor does not claim all interactions are covered by its DOM vocabulary.

## Verified binding reuse

Opt in with `reuse:true` only for a stable semantic identity, for example:

```javascript
{description: "The primary search input for this page", role: "textbox", reuse: true}
```

Bindings are learned after completion is verified, never merely because the model selected a control. The per-page
cache holds at most 64 entries in memory. Reuse requires the same document, origin/path, target definition, control
identity and compatible candidate set. A replacement node, reload, changed context or competing candidate invalidates
it. Ordinary preflight checks still run immediately before input. Field values and generated text are not cached;
identity/context checks use digests. No cache is written to disk.
Controls whose semantic identity changes during dispatch are not learned as reusable bindings.

Do not reuse relative judgments such as "cheapest product", "first unread item" or "empty field".
A new website starts with dynamic interpretation; it requires no site-specific profile or training.

## Routing and diagnostics

Plans default to operation and target confidence floors of 0.5. Override with
`routing:{minConfidence:0.6,minTargetConfidence:0.7}`, including on ordinary goal-only runs. These are configurable
engineering defaults, not calibrated guarantees. Tune against independently checked outcomes. Low confidence returns
`needs_host` / `low_confidence` without dispatching the proposed action. Exact local actions do not query Jev.

`plan` in the response records the active stage/goal, completed stages, transitions, local actions, binding hits and
invalidations, model calls, confidence handoffs and pending evidence. `trace.source` distinguishes `local`, `binding`
and `jev`; `trace.decisionIndex` joins actual model decisions to `requests[].decision`. Locally resolved actions do not
inflate `decisions` or API counts. `maxSteps` counts actions; confirmation continues after the final allowed action.
Host text handoffs preserve the plan and use the existing single-use continuation protocol.

Measure cold and warm runs separately, include failed attempts and handoffs, and report independent correctness,
full wall time, actual API attempts and local/browser waiting. Plan compilation occurs in the native host and must
also be included in an end-to-end comparison; runtime-only benchmarks do not measure that cost.

For fully specified controls, keep exact target identities when they satisfy the task. Do not add a semantic
description solely to invoke Jev: that intentionally adds a decision round trip. The [public-site comparison](benchmarks/2026-09-23/report.md)
found faster prepared execution than desktop Computer Use, but slower than Codex's batched built-in Browser Use.
Use the interface and routing appropriate to the actual uncertainty; the plan runtime is not a universal speed win.

## Reproduce checks

Use the repository's pinned Bun version. With the configured Jev key in the environment:

```bash
# Three layouts, alternating old-loop/plan order, cold and same-document warm runs.
JEV_LIVE_TEST=1 JEV_BENCH_REPEATS=3 bun run scripts/bench-jev-plans.ts
# Without JEV_LIVE_TEST, this uses a simulated 250 ms chooser, not a Jev speed measurement.
JEV_PUBLIC_TEST=1 bun run scripts/smoke-plans-public.ts
JEV_BROWSER_USE_EXTENSION_DIR="$PWD/extension/.output/chrome-mv3" bun run scripts/smoke-extension.ts
```

The benchmark records every attempt, API request count, status, timing and independent DOM assertions under `tmp/`.
The old loop receives the same known text and final checkpoint, and can use a visible loading state for local waits.
The public checks visit Selenium's form and dynamic-input pages in a temporary Chrome profile, without user accounts.
