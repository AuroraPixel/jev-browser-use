# Public-site comparison: three actual browser interfaces

**All 60 measured trials passed independent checks. Jev was faster than desktop Computer Use, but slower than
Codex's built-in Browser Use on every prepared-execution median. This result does not support a broad
“faster than Codex” claim.** No promotional post or comparative social reply was published from this experiment.

![Real measured comparison across Selenium and The Internet](comparison.png)

## Measured results

Five repetitions per workload and interface, collected on 23 September 2026. Seconds, lower is better.
Each cell below is the median of its five actual measurements; no slow or failed measured trial was removed.

| Workload | Codex Computer Use, desktop | Codex Browser Use, built-in | jev-browser-use | Desktop / Jev | Built-in / Jev |
| --- | ---: | ---: | ---: | ---: | ---: |
| Selenium web form | 3.892 | 1.296 | 2.111 | 1.84× | 0.61× |
| Selenium dynamic input | 1.734 | 1.165 | 1.516 | 1.14× | 0.77× |
| The Internet dropdown + checkboxes | 3.982 | 0.887 | 0.958 | 4.16× | 0.93× |
| The Internet dynamic controls | 13.321 | 12.610 | 12.714 | 1.05× | 0.99× |
| Independently verified | 20 / 20 | 20 / 20 | 20 / 20 | | |

The geometric mean of the four **baseline median / Jev median** execution ratios is **1.741×** against desktop
Computer Use and **0.811×** against built-in Browser Use. Equivalently, Jev's execution duration is about 42.6% lower
than desktop and 23.2% higher than built-in Browser Use under this equal-workload aggregation. These percentages are
not the ratio of total suite runtimes, a confidence interval, or a measure of model intelligence.

Including the initial navigation/reset gives these **prepared workflow** medians:

| Workload | Desktop (s) | Built-in (s) | Jev (s) |
| --- | ---: | ---: | ---: |
| Selenium web form | 4.761 | 1.621 | 2.368 |
| Selenium dynamic input | 2.703 | 1.201 | 1.917 |
| The Internet dropdown + checkboxes | 5.943 | 3.026 | 2.491 |
| The Internet dynamic controls | 14.532 | 12.944 | 13.320 |

The workflow geometric mean ratios are 1.648× vs desktop and 0.844× vs built-in Browser Use. Jev wins the controls
journey's workflow median against built-in Browser Use because initial navigation differed; it does **not** win that
workload's execution median. Navigation remains separately available in the data.

## What actually ran

- **Computer Use:** the real Codex CUA native macOS Chrome interface, with accessibility-derived element indices,
  native value setting, menu choices, clicks and fresh AX checks. Deterministic adjacent actions were batched.
  Required asynchronous transitions used the interface's paced AX/screenshot observations, without added sleeps.
- **Browser Use:** the real Codex in-app browser, using its supported batched Playwright actions, locator waits and
  read-only DOM checks. This was an additional, stronger baseline. Codex's external Chrome browser connector was
  unavailable, so this arm used its own in-app profile.
- **Jev:** the installed jev-browser-use Chrome extension, compiled conditional-plan runtime, and live TypeSafe/Jev
  API. Each workload included one semantic target; exact known controls ran locally. Across the 20 runs there were
  **85 executed browser actions and 22 API attempts**. Two extra decisions followed freshness rejection of changed
  pages; the rejected actions were not dispatched. No fake chooser or cross-trial learned binding was used.

OpenAI distinguishes [Computer Use and Browser Use](https://help.openai.com/en/articles/20001510-manage-browser-and-computer-use-in-your-enterprise-workspace).
Its [built-in browser has separate state](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app).
These interfaces and profiles must not be presented as interchangeable. This is an independently run system/workflow
comparison, not an OpenAI, Selenium, Browser Use or Jev vendor benchmark.

## Tasks and correctness

| Public page | Actions | Independent verification |
| --- | --- | --- |
| [Selenium web form](https://www.selenium.dev/selenium/web/web-form.html) | Fill text and multiline textarea; choose Two; toggle both checkboxes; select Default radio; submit once | Exact pre-submit field/check/radio state; Received page; submitted query values |
| [Selenium dynamic input](https://www.selenium.dev/selenium/web/dynamic.html) | Reveal the input; await readiness; fill supplied text | Actual visible input and exact value |
| [The Internet dropdown](https://the-internet.herokuapp.com/dropdown), then [checkboxes](https://the-internet.herokuapp.com/checkboxes) | Choose Option 2; visit checkboxes; check first and clear second | Selected option and both checkbox states |
| [The Internet dynamic controls](https://the-internet.herokuapp.com/dynamic_controls) | Remove and restore checkbox; enable, fill and disable input | Each stage's feedback, restored checkbox, final value and disabled state |

The final Jev DONE status was never accepted as independent proof. Browser arms read actual DOM values; desktop
checks used the displayed accessibility values and received URL. All arms used the same text, “Browser benchmark N”,
and the same multiline value. Selenium submission is a public test form, not a message to a person.

## Timing and limitations

Programs were authored after inspecting the sites, then frozen before the measured series. Five rounds alternated
desktop → built-in → Jev and Jev → built-in → desktop. Arms did not run concurrently. Each task started a fresh
document. The same prepared scripts were used across measured rounds.

`performance.now()` measured navigation/reset, execution through independent verification, and their sum inside the
actual tool runtime. Initial page readiness uses each interface's normal navigation/AX mechanism, which is not
identical. Intermediate navigation from dropdown to checkboxes is inside execution. Host reasoning, plan/code
authoring, outer tool dispatch, connector startup and post-run image export are excluded. **Neither timing is full
end-to-end agent latency.** Both native arms were allowed efficient batching; there was no forced model turn per click.

Environment: macOS 26.5.2 arm64. Desktop/Jev shared the user's Chrome profile and 1920×830 page viewport; built-in
Browser Use used its separate profile and default 1280×720 viewport. Existing Chrome extensions, network variability
and rendering differences are confounders. Viewports and privacy settings were not changed to manufacture a win.
Five repetitions on four inspected workflows are a small local sample, not a broad browser-agent benchmark.

The Internet's four asynchronous transitions contain approximately 12 seconds of site-imposed waiting. Jev cannot
remove that site delay. A faster decision API does not imply an equally faster complete task. Here, real semantic
requests also add overhead to tasks already completely specified by inspected controls.

The measured binary was an unreleased 0.1.0 build with conditional plans, SHA-256
`4948c0477875fee2c75d678b9c1772f65358a603e2cc280f258f05291cff4137`, on branch
`feat/adaptive-browser-plans`, based on `264b2705f182212c55fdd3f1084a101212135cf3` plus working-tree changes.
The installed binary and repository build hashes matched. [Source manifest](source-manifest.json).

## Fixes and interpretation

The tested runtime includes local execution of exact observed targets, Jev selection for semantic targets,
condition-driven stages and branching, local readiness waits, confidence handoffs, guarded binding reuse, and
single-dispatch receipts that prevent repeating an uncertain submit. These are documented in [conditional plans](../../plans.md).
The extension connection was also corrected: the older Dev Browser extension was inactive and the installed
jev-browser-use extension connected to the existing relay, producing the correctly named tab group.

Authoring pilots found verification-script issues, not failed field edits: Selenium's revealed input has a default
text type without an explicit attribute; The Internet removes earlier feedback; the in-app read-only DOM interface
does not expose `checkVisibility()`. Checks were corrected before measurement using the DOM `type` property,
per-stage feedback and the supported `isVisible()` API. An initial pilot's report save also rejected a path separator;
the harness now uses a permitted flat filename. These authoring attempts remain separately recorded and are excluded
from every arm's prepared-program result. No production guard was weakened to improve a score.

The practical routing choice is to use exact grounded actions for fully specified controls, reserve semantic Jev
decisions for genuine uncertainty, and keep native reasoning for content and exceptions. Adding a semantic description
only to force an API request is not an optimization. This benchmark deliberately includes semantic requests to test
the integration; it is not a benchmark of an all-local plan. Further speed improvements must be remeasured across
fresh tasks, including host planning cost, before making broader claims.

## Publication decision and reproduction

The [predeclared protocol](protocol.md) required all Jev runs to verify, success no worse than both baselines, lower
execution medians for both site families, and a geometric mean speed ratio above 1.15 against **both** baselines.
The correctness gate passed; the speed gate failed. The thresholds were not changed after seeing the results.

- [All 60 measurements](measured.json): public timing/result fields only; no keys, browser profiles or private page data.
- [Computed statistics and gate](summary.json).
- [Prepared native and Jev harnesses](../../../bench/public-comparison/README.md), plus deterministic chart renderer.
- [Architecture artwork](architecture-poster.png) was generated with the built-in image tool using this [prompt](poster-prompt.txt).
  It illustrates the design; the measurement graphic above is generated from actual data with Matplotlib.

Keep failed attempts, use new output names for reruns, and do not replace the five measured rounds with selected faster
ones. A future experiment should use a new dated report and retain this result.
