// Run through the installed jev-browser-use CLI and extension.
// Prefix this file with const benchmarkRound = N; for measured rounds 1..5.
// Round zero is an authoring pilot and is excluded from measured comparisons.
const round = typeof benchmarkRound === "number" ? benchmarkRound : 0;
const p = await browser.getPage("split-executor-jev");
const value = "Browser benchmark " + round;
const multiline = "First line\nSecond line";
const rows = [];
let taskResults = [];
const assert = (ok, message) => { if (!ok) throw Error(message); };
const plan = (origin, targets, stages) => ({ origins: [origin], targets, stages });
const fill = (id, target, text) => ({ id, goal: "Fill " + target, action: { operation: "TYPE_TEXT", target, text } });
const click = (id, target, until) => ({ id, goal: "Click " + target + " and verify its result", action: { operation: "CLICK", target }, until, timeoutMs: 10000 });
async function runPlan(goal, program) {
  const result = await p.jev({ action: "run", goal, plan: program, stepLimit: 25 });
  taskResults.push(result);
  if (result.decisions !== 0 || result.requests?.length) throw Error("Local executor unexpectedly invoked Jev");
  if (result.status !== "done") {
    if (["needs_host", "needs_text", "paused"].includes(result.status)) await p.jev({ action: "stop", sessionId: result.sessionId });
    throw Error(result.status + ": " + result.stopReason);
  }
}
async function measure(task, url, executeTask) {
  taskResults = [];
  const started = performance.now();
  let loaded = started, actual = null, error = null;
  try { await p.goto(url); loaded = performance.now(); actual = await executeTask(); }
  catch (e) { error = String(e); }
  const finished = performance.now();
  const row = { arm: "jev-local-plan", round, task, verified: !error, error,
    navigationMs: loaded - started, executionMs: finished - loaded, workflowMs: finished - started,
    actual, decisions: taskResults.reduce((n, r) => n + r.decisions, 0),
    apiAttempts: taskResults.reduce((n, r) => n + (r.requests?.length || 0), 0),
    steps: taskResults.reduce((n, r) => n + r.steps, 0), results: [...taskResults] };
  rows.push(row);
  await saveFile("split-executor-jev-round-" + round + ".json", JSON.stringify({ at: new Date().toISOString(), round, rows }, null, 2));
  const { results, ...summary } = row;
  console.log(JSON.stringify(summary));
}
await measure("selenium-form", "https://www.selenium.dev/selenium/web/web-form.html", async () => {
  await runPlan("Complete the inspected Selenium form with supplied values", plan("https://www.selenium.dev", {
    text: { label: "Text input", role: "textbox" },
    area: { label: "Textarea" }, select: { label: "Dropdown (select)" },
    first: { label: "Checked checkbox", role: "checkbox" }, second: { label: "Default checkbox", role: "checkbox" },
    radio: { label: "Default radio", role: "radio" }
  }, [fill("text", "text", value), fill("area", "area", multiline),
    { id: "select", goal: "Choose Two", action: { operation: "SELECT", target: "select", option: { label: "Two" } } },
    { id: "second", goal: "Check Default checkbox", action: { operation: "CLICK", target: "second", checked: true } },
    { id: "first", goal: "Clear Checked checkbox", action: { operation: "CLICK", target: "first", checked: false } },
    click("radio", "radio", { fields: [{ label: "Default radio", checked: true }] })
  ]));
  const fields = await p.evaluate(() => ({ text: document.querySelector('[name="my-text"]').value,
    area: document.querySelector('textarea').value, select: document.querySelector('select').value,
    checks: Array.from(document.querySelectorAll('input[type="checkbox"]')).map(e => e.checked),
    radios: Array.from(document.querySelectorAll('input[type="radio"]')).map(e => e.checked) }));
  assert(fields.text === value && fields.area === multiline && fields.select === "2" &&
    JSON.stringify(fields.checks) === "[false,true]" && JSON.stringify(fields.radios) === "[false,true]", "Incorrect pre-submit fields");
  await runPlan("Submit once and verify acknowledgement", plan("https://www.selenium.dev", { submit: { label: "Submit", role: "button" } },
    [click("submit", "submit", { url: { origin: "https://www.selenium.dev", pathname: "/selenium/web/submitted-form.html" }, text: ["Form submitted", "Received!"] })]));
  const received = await p.evaluate(() => ({ url: location.href, text: document.body.innerText }));
  const params = new URL(received.url).searchParams;
  assert(received.text.includes("Received!") && params.get("my-text") === value && params.get("my-textarea").replace(/\r/g, "") === multiline && params.get("my-select") === "2", "Submission not verified");
  return { fields, received: true };
});
await measure("selenium-dynamic", "https://www.selenium.dev/selenium/web/dynamic.html", async () => {
  await runPlan("Reveal the new input and fill the supplied value", plan("https://www.selenium.dev", {
    reveal: { label: "Reveal a new input", role: "button" },
    field: { label: "textbox", role: "textbox" }
  }, [click("reveal", "reveal", { fields: [{ label: "textbox", value: "" }] }), fill("fill", "field", value)]));
  const actual = await p.evaluate(() => Array.from(document.querySelectorAll('input')).filter(e => e.type === 'text').map(e => ({ value: e.value, visible: e.checkVisibility() })));
  assert(actual.length === 1 && actual[0].value === value && actual[0].visible, "Revealed input not verified");
  return actual;
});
await measure("internet-controls", "https://the-internet.herokuapp.com/dropdown", async () => {
  await runPlan("Choose Option 2 in the native dropdown", plan("https://the-internet.herokuapp.com", {
    select: { label: "Please select an option Option 1 Option 2", role: "combobox" }
  }, [{ id: "select", goal: "Choose Option 2", action: { operation: "SELECT", target: "select", option: { label: "Option 2" } } }]));
  const selection = await p.evaluate(() => ({ value: document.querySelector('select').value, index: document.querySelector('select').selectedIndex }));
  assert(selection.value === "2" && selection.index === 2, "Dropdown not verified");
  await p.goto("https://the-internet.herokuapp.com/checkboxes");
  await runPlan("Check checkbox 1 and clear checkbox 2", plan("https://the-internet.herokuapp.com", {
    first: { label: "checkbox 1", role: "checkbox" }, second: { label: "checkbox 2", role: "checkbox" }
  }, [{ id: "first", goal: "Check checkbox 1", action: { operation: "CLICK", target: "first", checked: true } },
    { id: "second", goal: "Clear checkbox 2", action: { operation: "CLICK", target: "second", checked: false } }]));
  const checks = await p.evaluate(() => Array.from(document.querySelectorAll('input[type="checkbox"]')).map(e => e.checked));
  assert(JSON.stringify(checks) === "[true,false]", "Checkboxes not verified");
  return { selection, checks };
});
await measure("internet-dynamic", "https://the-internet.herokuapp.com/dynamic_controls", async () => {
  await runPlan("Remove and restore the checkbox; enable, fill and disable the input", plan("https://the-internet.herokuapp.com", {
    remove: { label: "Remove", role: "button" },
    add: { label: "Add", role: "button" }, enable: { label: "Enable", role: "button" },
    field: { label: "textbox", role: "textbox" }, disable: { label: "Disable", role: "button" }
  }, [click("remove", "remove", { text: ["It's gone!"] }), click("add", "add", { text: ["It's back!"] }),
    click("enable", "enable", { text: ["It's enabled!"] }), fill("fill", "field", value),
    click("disable", "disable", { text: ["It's disabled!"] })]));
  const actual = await p.evaluate(() => ({ value: document.querySelector('input[type="text"]').value,
    disabled: document.querySelector('input[type="text"]').disabled,
    checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
    message: document.body.innerText.includes("It's disabled!") }));
  assert(actual.value === value && actual.disabled && actual.checkboxes === 1 && actual.message, "Dynamic controls not verified");
  return actual;
});
({ file: "split-executor-jev-round-" + round + ".json", verified: rows.filter(r => r.verified).length, total: rows.length });
