# Reproduce the prepared-workflow comparison

The [dated report](../../docs/benchmarks/2026-09-23/report.md) documents the exact environment, limitations, raw
measurements and publication gate. This is a public-site test: submitting Selenium's form sends only synthetic test
values. It never logs into a service or posts a message.

1. Use the report's source version, Bun 1.3.14, compiled CLI, connected jev-browser-use extension and a privately
   configured Jev API key. Inspect the public pages before using these observed labels. Ensure the old Dev Browser
   extension is inactive; both compete for the same relay port. Do not disable unrelated user extensions or guards.
2. In Codex's supported CUA REPL, follow its current documentation to bind a disposable in-app browser Tab as
   `baselineForm` and native Chrome App as `chromeApp`. Create a separate disposable desktop Chrome tab. The native
   programs require actual Codex interfaces; they cannot be replaced by external Puppeteer while retaining this label.
3. Put the declarations from `native-common.js`, `native-browser.js` and `native-desktop.js` in that REPL. These are
   prepared tool programs, not modules to import through the CLI. Role strings reflect the tested Chinese macOS UI;
   derive any needed changes from fresh accessibility observations before measuring, never stale indices.
4. Run all four tasks in round zero as authoring pilots, verify assertions, then freeze the programs. Use
   `await runNativeRound(0)` for Browser Use and `for (const task of Object.keys(nativeTaskUrls)) await
   runDesktopTask(0, task)` for desktop. Select only the disposable desktop tab before running its arm. Do not export
   full AX states containing browser chrome, bookmarks or unrelated tabs into public artifacts.
5. For Jev, prefix `jev.js` with `const benchmarkRound = N;` and run the resulting file:

   ```bash
   jev-browser-use --connect http://127.0.0.1:9222 --quiet-page -t 110 run /path/to/round-N.js
   ```

   Results are saved with `saveFile` as `public-comparison-jev-round-N.json` under the configured runtime's tmp
   directory. Use a new naming prefix for a new experiment. Full traces remain local; share sanitized measurements.
6. Run five rounds, odd: desktop → Browser Use → Jev; even: Jev → Browser Use → desktop. Do not execute arms in
   parallel. Record every result and error. Native functions print timings and independently checked outcomes;
   export the REPL's `desktopRows` and `nativeRows` without dropping failed trials. Round zero is always separate.
7. Recompute the four per-interface medians and geometric mean of baseline/Jev median ratios. Include initial
   navigation separately and as prepared workflow time. The existing `measured.json` is immutable evidence of the
   reported run, not a place to overwrite results until a target score is achieved.

To regenerate the existing public figure from its data (no browser or key needed):

```bash
python3 -m venv /tmp/jev-report-venv
/tmp/jev-report-venv/bin/python -m pip install matplotlib==3.10.6
/tmp/jev-report-venv/bin/python bench/public-comparison/render-report.py
```

The 60 measured rows include every formal attempt and its original millisecond precision. Exploratory pilot failures
are described in the report; full session diagnostics stay outside the repository. No generated artwork is used as
measurement evidence.

## 24 September: split executor and host-workflow study

Keep the earlier files unchanged. The [new protocol](../../docs/benchmarks/2026-09-24/protocol.md) defines separate
timing boundaries. For executor group A, load `split-native.js` into the supported CUA REPL and call
`await runSplitNativeRound(N, liveTab)` with an explicitly bound disposable in-app Tab. Prefix `split-local.js`
with `const benchmarkRound = N;` and run it through the connected Jev CLI as above. It asserts zero decisions and
API attempts. Run a symmetric round-zero warm-up, then five rounds: odd native/Jev, even Jev/native. Export
`splitNativeRows`; retain every formal sample, slow runs and failures. Use fresh output names on any new experiment.

For group B, give the protocol's natural-language briefs to the host; do not replay prepared task executables or
use the already-known answers as substitutes for reading the actual pages. `host-timer.py` only timestamps the
host's work; it contains no browser actions or task solution. Copy it into a new output directory and use
`python3 host-timer.py start b1-native` immediately before the first task observation, then
`python3 host-timer.py end b1-native '{"verified":true}'` immediately after verification. Record browser calls,
errors, handoffs and original timestamps. It refuses to overwrite an attempt. The allowed names follow the six
attempts in the protocol. Never count report production as task time or remove real authoring/recovery costs.

The recorded B study is a shared-context exploratory sample. A stronger future comparison needs repeated fresh
host contexts with the same model settings and task briefs, balanced randomized order, identical browser conditions
where possible, and tool-dispatch timestamps. Do not label a replay of these solutions as a fresh reasoning test.

Regenerate the new figure independently with `python bench/public-comparison/render-split-report.py` in the same
Matplotlib environment. Its panels deliberately keep prepared execution, initial navigation and host wall time
separate. Public JSON contains test-page evidence and compact traces, not private browser diagnostics or keys.
