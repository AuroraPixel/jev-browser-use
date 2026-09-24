# Predeclared browser comparison

Compare three actual interfaces: Codex desktop Computer Use (native Chrome accessibility actions), Codex built-in Browser Use (supported batched Playwright), and jev-browser-use through the installed Chrome extension. Codex's external Chrome browser connector was unavailable; the in-app browser and desktop interface are functional. All published labels must identify the actual interface. This is a system/workflow comparison, not a controlled test of foundation models.

Four workloads on public, unmodified test sites:

1. Selenium web form: fill a single-line field and textarea, select Two, check the default checkbox, clear the checked checkbox, select the default radio, verify fields, submit, verify the received page and submitted values.
2. Selenium dynamic input: reveal the input, wait for visibility, fill it, verify its value.
3. The Internet controls journey: select Option 2, visit checkboxes, check the first and clear the second, verify all results.
4. The Internet dynamic controls: remove and restore the checkbox, enable the input, fill it, disable it, verify final value/disabled state and feedback.

Inspect and author both programs before measurement. Allow efficient batching on the Codex side. Give both systems the same task values and expected conditions. Jev plans include a semantic target so the deployed Jev API is exercised, alongside grounded local actions.

Five repetitions per workload/interface. Alternate desktop/browser/Jev and Jev/browser/desktop order by repetition. Navigation/reset creates fresh documents; no learned cross-trial binding. All recorded attempts, timeouts and failures remain in the raw data. Exploratory authoring/debug attempts are separately retained and excluded from the prepared-program benchmark for all arms.

Measure monotonic elapsed time within the actual tool runtimes:
- navigation/reset time;
- prepared execution through independent state verification (AX for desktop, DOM for browser interfaces);
- sum of both as prepared workflow time.

Host reasoning, code/plan authoring, tool dispatch outside the measured runtime, one-time connector startup and screenshot export are excluded. Never describe these numbers as end-to-end model/agent completion latency. Report the boundary on the result graphic.

Correctness is checked independently from executor DONE: exact field/option/checkbox/radio values and received result, actual input visibility/disabled state, plus required messages. Native baselines use official supported actions; desktop verification reads accessibility state, Browser Use verification reads the DOM. Dynamic messages are checked at each stage because the site removes earlier feedback. Jev uses its plan/action runtime with its normal guards and actual API key; no fabricated chooser.

Publication gate decided before measurement: all Jev measured runs must verify successfully, success rate must be no worse than either baseline, median prepared-execution time must be lower for both site families, and the geometric mean of the four workload median speed ratios must exceed 1.15 against both baselines. Also report any individual workload regressions. A qualified advantage applies only to these measured workloads/environment. If the gate fails, update the README honestly but do not publish a promotional post or comparative reply.

Publish a comparative promotional claim only if the implementation/tests and predeclared result checks pass. Artwork must be distinct from deterministic charts of measured data, and all claims must state scope and limitations.

The requested desktop Computer Use interface is measured separately; the faster available built-in Browser Use interface is an additional comparison. They must never be conflated in captions or social copy. Preserve user-default viewport sizes and disclose them; neither arm is resized merely for screenshots.
