# Split validation, frozen before measurement

Keep the 23 September run intact. Same installed binary; no runtime changes during this experiment.

## A: prepared executor comparison

Compare real Codex in-app Browser Use against the existing jev-browser-use conditional-plan LOCAL route.
Both receive identical inspected control identities and supplied text; neither invokes a model during prepared execution.
Jev must report zero model decisions/API attempts; this arm is labelled Jev local plan, not Jev model inference.
Same four public workflows, assertions and values as 23 September. Five repetitions, alternating native/Jev and
Jev/native. Round zero is a symmetric warm-up. New documents every task; no learned binding reuse. Retain every failure.
Report navigation, prepared execution, workflow time, all samples and medians. Known profile/default viewport differences
remain disclosed; this isolates the unnecessary model request in task design, not every browser/transport implementation variable.

## B: natural-language host workflow study

Use real supported Codex Browser Use and real Jev delegation with native Codex reasoning/text/unsupported-control fallback.
No prepared per-task executable scripts. The same single host session handles both arms; this is an exploratory paired
workflow study, NOT an independent-context blind agent benchmark. The second arm can benefit from observations in the
first, despite alternating order. Do not present model rankings or universal speed conclusions.

Three paired tasks, one attempt per arm; total six workflows. Before measurement, only natural-language tasks are defined:

1. Count and wait: from The Internet home, find Add/Remove Elements. Add three controls, remove two, independently verify
   one Delete control remains. Then return home, find Dynamic Loading, choose Example 2, start it, and verify Hello World.
   Order: native first, Jev second.
2. Read and decide: from The Internet home, open Sortable Data Tables. Read the SECOND table, choose the row with largest
   Due (ties by Last Name then First Name). At Selenium's web form, put First Name + space + Last Name in Text input,
   put that row's Email in Textarea, select Two if Due >= 75 else One, ensure Default checkbox is checked and Checked
   checkbox is cleared, submit once. Independently verify the data choice and received values.
   Order: Jev first, native second.
3. Frame handoff: from The Internet home, open Frames then Nested Frames. Read the four visible frame words in order
   LEFT, MIDDLE, RIGHT, BOTTOM. At Selenium's web form put their values joined by ' | ' into Textarea and 'Frame check'
   into Text input, select Three, submit once. Independently verify original frame contents and received values.
   Order: native first, Jev second.

The listed frame words identify the desired regions; actual content still must be read through the browser.
Previously inspected site/task knowledge is shared context; these are new workflows, not guaranteed unseen web content.
For both arms use meaningful batching where current observations allow it. No artificial host turn per click.
Jev may hand back reasoning/text/unsupported interactions; charge these host turns to Jev's total, don't hide them.

Record host monotonic elapsed time from task start through final verified result, including observation, planning,
tool dispatch, UI execution, real recovery and validation. Exclude only prior connector/docs setup and later report writing.
Do no unrelated work during an active timed attempt. Capture start/end, tool calls, handoffs, success and errors. Bound
an attempt to 5 minutes; retain failures and report real wall time. Host elapsed includes the interactive agent/tool
environment's scheduling overhead; it is not an isolated foundation-model latency or a repeatable statistical estimate.

Compare A and B separately. Do not pool their times, reuse the previous forced-inference score, or publish an X promotion
from an all-local executor win. No production guard is disabled. Keep credentials and private browser diagnostics local.
