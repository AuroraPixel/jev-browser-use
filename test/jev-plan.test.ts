import { afterAll, expect, test } from "bun:test";
import { JevController } from "../src/jev/controller.ts";
import type { BrowserPlan } from "../src/jev/plan-types.ts";
import type { Decision, Operation } from "../src/jev/types.ts";
import { closeBrowser, withPage } from "./helpers/browser.ts";
import { startServer } from "./helpers/server.ts";

afterAll(closeBrowser);
const decision = (operation: Operation, target?: string, confidence = 1): Decision =>
  ({ operation, target, confidence, targetConfidence: confidence, latencyMs: 0, model: "fixture" });
const noModel = async (): Promise<Decision> => { throw Error("Unexpected model call"); };
const planFor = (url: string, overrides: Partial<BrowserPlan> = {}): BrowserPlan => ({
  origins: [new URL(url).origin], targets: {}, stages: [], ...overrides,
});

test("cold exact bindings fill, select duplicate-valued options, set toggles and submit once without inference", async () => withPage(async p => {
  const server = await startServer({ "/": '<form onsubmit="event.preventDefault();window.sent=(window.sent||0)+1;document.querySelector(\'output\').textContent=\'Saved\'"><input aria-label="Name"><select aria-label="Tier"><option value=x>Basic</option><option value=x>Pro</option></select><label><input type=checkbox>Updates</label><button>Save</button></form><output></output>' });
  try {
    await p.goto(server.url("/"));
    const c = new JevController(p, noModel);
    const plan = planFor(p.url(), {
      targets: { name: { label: "Name" }, tier: { label: "Tier" }, updates: { label: "Updates" }, save: { label: "Save", role: "button" } },
      stages: [
        { id: "name", goal: "Set Name", action: { operation: "TYPE_TEXT", target: "name", text: "Ada" } },
        { id: "tier", goal: "Use Pro", action: { operation: "SELECT", target: "tier", option: { label: "Pro" } } },
        { id: "updates", goal: "Enable updates", action: { operation: "CLICK", target: "updates", checked: true } },
        { id: "save", goal: "Save once", action: { operation: "CLICK", target: "save" }, until: { text: ["Saved"] } },
      ],
    });
    const r = await c.call({ action: "run", goal: "Update profile", plan });
    expect(r.status).toBe("done");
    expect(r.stopReason).toBe("plan_complete");
    expect(r.decisions).toBe(0);
    expect(r.steps).toBe(4);
    expect(r.plan?.localActions).toBe(4);
    expect(r.plan?.completed).toEqual(["name", "tier", "updates", "save"]);
    expect(await p.evaluate(() => ({ name: document.querySelector("input")!.value,
      tier: document.querySelector("select")!.selectedIndex, updates: (document.querySelector("input[type=checkbox]") as HTMLInputElement).checked,
      sent: (window as any).sent }))).toEqual({ name: "Ada", tier: 1, updates: true, sent: 1 });
  } finally { await server.stop(); }
}));

test("a semantic binding learns only after verified completion and is reused in the same document", async () => withPage(async p => {
  const server = await startServer({ "/": '<input aria-label="Alias"><input aria-label="Note">' });
  try {
    await p.goto(server.url("/"));
    let calls = 0;
    const c = new JevController(p, async o => { calls++; return decision("TYPE_TEXT", o.elements.find(e => e.label === "Alias")!.ref); });
    const plan = (text: string) => planFor(p.url(), {
      targets: { alias: { description: "The user's display alias field", role: "textbox", reuse: true } },
      stages: [{ id: "alias", goal: "Update display alias", action: { operation: "TYPE_TEXT", target: "alias", text } }],
    });
    const cold = await c.call({ action: "run", goal: "Set alias", plan: plan("first") });
    const warm = await c.call({ action: "run", goal: "Set alias", plan: plan("second") });
    expect(cold.status).toBe("done");
    expect(warm.status).toBe("done");
    expect(cold.decisions).toBe(1);
    expect(warm.decisions).toBe(0);
    expect(warm.plan?.bindingHits).toBe(1);
    expect(calls).toBe(1);
    expect(await p.$eval('input[aria-label=Alias]', e => e.value)).toBe("second");
  } finally { await server.stop(); }
}));

test("replaced controls and new competing candidates invalidate learned identities", async () => withPage(async p => {
  const server = await startServer({ "/": '<input aria-label="Name">' });
  try {
    await p.goto(server.url("/"));
    let calls = 0;
    const c = new JevController(p, async o => { calls++; return decision("TYPE_TEXT", o.elements.find(e => e.label === "Name")!.ref); });
    const plan = (text: string) => planFor(p.url(), { targets: { field: { description: "The name field", role: "textbox", reuse: true } },
      stages: [{ id: "fill", goal: "Fill name", action: { operation: "TYPE_TEXT", target: "field", text } }] });
    const first = await c.call({ action: "run", goal: "Fill name", plan: plan("A") });
    expect(first.status, first.reason).toBe("done");
    await p.$eval("input", e => { const replacement = e.cloneNode() as HTMLInputElement; e.replaceWith(replacement); });
    const replaced = await c.call({ action: "run", goal: "Fill name", plan: plan("B") });
    expect(replaced.status).toBe("done");
    expect(replaced.decisions).toBe(1);
    expect(replaced.plan?.bindingInvalidations).toBe(1);
    await p.evaluate(() => { const other = document.createElement("input"); other.setAttribute("aria-label", "Other name"); document.body.append(other); });
    const competitor = await c.call({ action: "run", goal: "Fill name", plan: plan("C") });
    expect(competitor.status).toBe("done");
    expect(competitor.plan?.bindingInvalidations).toBe(1);
    expect(calls).toBe(3);
  } finally { await server.stop(); }
}));

test("conditional stages branch on observed results and wait for asynchronous evidence locally", async () => withPage(async p => {
  const server = await startServer({ "/": '<button onclick="setTimeout(()=>document.querySelector(\'main\').textContent=\'Ready: manual entry\',250)">Start</button><main></main><input aria-label="Name">' });
  try {
    await p.goto(server.url("/"));
    const c = new JevController(p, noModel);
    const r = await c.call({ action: "run", goal: "Complete the appropriate route", plan: planFor(p.url(), {
      targets: { start: { label: "Start" }, name: { label: "Name" } },
      stages: [
        { id: "start", goal: "Start and wait", action: { operation: "CLICK", target: "start" }, until: { text: ["Ready:"] },
          branches: [{ when: { text: ["manual entry"] }, next: "manual" }], next: "wrong" },
        { id: "wrong", goal: "Unreachable branch", action: { operation: "TYPE_TEXT", target: "name", text: "wrong" }, next: null },
        { id: "manual", goal: "Fill the manual route", action: { operation: "TYPE_TEXT", target: "name", text: "correct" } },
      ],
    }) });
    expect(r.status).toBe("done");
    expect(r.plan?.completed).toEqual(["start", "manual"]);
    expect(r.decisions).toBe(0);
    expect(await p.$eval("input", e => e.value)).toBe("correct");
  } finally { await server.stop(); }
}));

test("a dispatched click is not repeated when feedback is late, including after a host resume", async () => withPage(async p => {
  const server = await startServer({ "/": '<button onclick="window.clicks=(window.clicks||0)+1">Send</button><output></output>' });
  try {
    await p.goto(server.url("/"));
    const c = new JevController(p, noModel);
    const r = await c.call({ action: "run", goal: "Send once", plan: planFor(p.url(), {
      targets: { send: { label: "Send" } },
      stages: [{ id: "send", goal: "Send", action: { operation: "CLICK", target: "send" }, until: { text: ["Sent successfully"] }, timeoutMs: 150 }],
    }) });
    expect(r.status).toBe("needs_host");
    expect(r.plan?.waitingForEvidence).toBe(true);
    const again = await c.call(r.handoff!.resume);
    expect(again.status).toBe("needs_host");
    expect(await p.evaluate(() => (window as any).clicks)).toBe(1);
    await p.$eval("output", e => e.textContent = "Sent successfully");
    expect((await c.call(again.handoff!.resume)).status).toBe("done");
    expect(await p.evaluate(() => (window as any).clicks)).toBe(1);
  } finally { await server.stop(); }
}));

test("ambiguous exact labels require Jev and low confidence hands off without mutation", async () => withPage(async p => {
  const server = await startServer({ "/": '<section><input aria-label="Name"></section><section><input aria-label="Name"></section>' });
  try {
    await p.goto(server.url("/"));
    const c = new JevController(p, async o => decision("TYPE_TEXT", o.elements[0]!.ref, 0.2));
    const r = await c.call({ action: "run", goal: "Fill the correct name", plan: planFor(p.url(), { targets: { name: { label: "Name" } },
      stages: [{ id: "fill", goal: "Fill first form", action: { operation: "TYPE_TEXT", target: "name", text: "Never guessed" } }] }) });
    expect(r.status).toBe("needs_host");
    expect(r.stopReason).toBe("low_confidence");
    expect(r.steps).toBe(0);
    expect(r.plan?.confidenceHandoffs).toBe(1);
    expect(await p.$$eval("input", es => es.map(e => e.value))).toEqual(["", ""]);
  } finally { await server.stop(); }
}));

test("host text resumes the same conditional program without another semantic decision", async () => withPage(async p => {
  const server = await startServer({ "/": '<textarea aria-label="Summary"></textarea>' });
  try {
    await p.goto(server.url("/"));
    const c = new JevController(p, noModel);
    const r = await c.call({ action: "run", goal: "Write a summary", plan: planFor(p.url(), { targets: { summary: { label: "Summary" } },
      stages: [{ id: "write", goal: "Write the native host's summary", action: { operation: "TYPE_TEXT", target: "summary" } }] }) });
    expect(r.status).toBe("needs_text");
    const done = await c.call({ ...r.handoff!.resume, text: "Native host summary" });
    expect(done.status).toBe("done");
    expect(done.decisions).toBe(0);
    expect(await p.$eval("textarea", e => e.value)).toBe("Native host summary");
  } finally { await server.stop(); }
}));

test("goal stages retain generic Jev interaction for a custom widget, then return to local actions", async () => withPage(async p => {
  const server = await startServer({ "/": '<button aria-label="Open picker" onclick="document.querySelector(\'section\').innerHTML=\'<button onclick=&quot;document.querySelector(\\\'output\\\').textContent=\\\'Date confirmed\\\'&quot;>Tomorrow</button>\'">Calendar</button><section></section><output></output><input aria-label="Note">' });
  try {
    await p.goto(server.url("/"));
    let calls = 0;
    const c = new JevController(p, async o => { calls++; return decision("CLICK", (o.elements.find(e => e.label === "Tomorrow") || o.elements.find(e => e.label === "Open picker"))!.ref); });
    const r = await c.call({ action: "run", goal: "Use tomorrow and add note", plan: planFor(p.url(), { targets: { note: { label: "Note" } },
      stages: [{ id: "date", goal: "Open the date picker and choose Tomorrow", until: { text: ["Date confirmed"] } },
        { id: "note", goal: "Fill note", action: { operation: "TYPE_TEXT", target: "note", text: "Ready" } }] }) });
    expect(r.status).toBe("done");
    expect(calls).toBe(2);
    expect(r.plan?.localActions).toBe(1);
    expect(await p.$eval("input", e => e.value)).toBe("Ready");
  } finally { await server.stop(); }
}));

test("navigation outside the authored origins cannot receive prepared text", async () => withPage(async p => {
  const server = await startServer({ "/": '<input aria-label="Name">' });
  try {
    await p.goto(server.url("/"));
    const c = new JevController(p, noModel);
    const r = await c.call({ action: "run", goal: "Fill profile", plan: { ...planFor(p.url(), { targets: { name: { label: "Name" } },
      stages: [{ id: "fill", goal: "Fill", action: { operation: "TYPE_TEXT", target: "name", text: "Must stay local" } }] }), origins: ["https://example.com"] } });
    expect(r.status).toBe("needs_host");
    expect(r.reason).toContain("allowed origins");
    expect(await p.$eval("input", e => e.value)).toBe("");
  } finally { await server.stop(); }
}));

test("satisfied branch cycles stop without calling a model or mutating the page", async () => withPage(async p => {
  const server = await startServer({ "/": "<h1>Ready</h1>" });
  try {
    await p.goto(server.url("/"));
    const r = await new JevController(p, noModel).call({ action: "run", goal: "Cyclic plan", plan: planFor(p.url(), {
      stages: [{ id: "again", goal: "Ready", until: { text: ["Ready"] }, next: "again" }],
    }) });
    expect(r.status).toBe("needs_host");
    expect(r.reason).toContain("cycle");
    expect(r.steps).toBe(0);
  } finally { await server.stop(); }
}));

test("a semantic decision invalidated during inference is re-evaluated instead of silently reused", async () => withPage(async p => {
  const server = await startServer({ "/": '<input aria-label="Name"><input aria-label="Other">' });
  try {
    await p.goto(server.url("/"));
    let calls = 0;
    const c = new JevController(p, async o => {
      calls++;
      const field = o.elements.find(e => e.label === (calls === 1 ? "Name" : "Updated name"))!;
      if (calls === 1) await p.$eval('input[aria-label=Name]', e => e.setAttribute("aria-label", "Updated name"));
      return decision("TYPE_TEXT", field.ref);
    });
    const r = await c.call({ action: "run", goal: "Fill name", plan: planFor(p.url(), {
      targets: { name: { description: "The name field", role: "textbox", reuse: true } },
      stages: [{ id: "fill", goal: "Fill name", action: { operation: "TYPE_TEXT", target: "name", text: "Ada" } }],
    }) });
    expect(r.status).toBe("done");
    expect(calls).toBe(2);
    expect(r.trace[0]?.outcome).toBe("stale");
    expect(await p.$$eval("input", es => es.map(e => e.value))).toEqual(["Ada", ""]);
  } finally { await server.stop(); }
}));

test("completion observation continues after the last allowed action", async () => withPage(async p => {
  const server = await startServer({ "/": '<button onclick="setTimeout(()=>document.querySelector(\'output\').textContent=\'Finished\',200)">Run</button><output></output>' });
  try {
    await p.goto(server.url("/"));
    const r = await new JevController(p, noModel).call({ action: "run", goal: "Run once", stepLimit: 1, maxSteps: 1,
      plan: planFor(p.url(), { targets: { run: { label: "Run" } }, stages: [
        { id: "run", goal: "Run once", action: { operation: "CLICK", target: "run" }, until: { text: ["Finished"] } },
      ] }) });
    expect(r.status).toBe("done");
    expect(r.steps).toBe(1);
    expect(r.decisions).toBe(0);
  } finally { await server.stop(); }
}));

test("an already-correct checkbox is never toggled while extra evidence is pending", async () => withPage(async p => {
  const server = await startServer({ "/": '<label><input type=checkbox checked onchange="window.changes=(window.changes||0)+1">Enabled</label>' });
  try {
    await p.goto(server.url("/"));
    const r = await new JevController(p, noModel).call({ action: "run", goal: "Keep enabled", plan: planFor(p.url(), {
      targets: { enabled: { label: "Enabled" } },
      stages: [{ id: "enabled", goal: "Keep enabled and wait", action: { operation: "CLICK", target: "enabled", checked: true }, until: { text: ["Ready"] }, timeoutMs: 100 }],
    }) });
    expect(r.status).toBe("needs_host");
    expect(r.steps).toBe(0);
    expect(await p.evaluate(() => (window as any).changes || 0)).toBe(0);
    expect(await p.$eval("input", e => e.checked)).toBe(true);
  } finally { await server.stop(); }
}));

test("plan execution does not invent text for an unplanned field or broaden an operation", async () => withPage(async p => {
  const server = await startServer({ "/": '<input aria-label="Name"><button>Delete</button>' });
  try {
    await p.goto(server.url("/"));
    const c = new JevController(p, async () => decision("CLICK", "not-offered"));
    const r = await c.call({ action: "run", goal: "Fill name", plan: planFor(p.url(), {
      targets: { name: { description: "The name input" } },
      stages: [{ id: "fill", goal: "Fill", action: { operation: "TYPE_TEXT", target: "name", text: "Ada" } }],
    }) });
    expect(r.status).toBe("error");
    expect(r.reason).toContain("outside the active plan");
    expect(r.steps).toBe(0);
  } finally { await server.stop(); }
}));

test("confirming the last burst action does not dispatch the following stage", async () => withPage(async p => {
  const server = await startServer({ "/": '<input aria-label="First"><input aria-label="Second">' });
  try {
    await p.goto(server.url("/"));
    const c = new JevController(p, noModel);
    const r = await c.call({ action: "run", goal: "Fill two fields", maxSteps: 1, plan: planFor(p.url(), {
      targets: { first: { label: "First" }, second: { label: "Second" } },
      stages: [
        { id: "first", goal: "Fill first", action: { operation: "TYPE_TEXT", target: "first", text: "A" } },
        { id: "second", goal: "Fill second", action: { operation: "TYPE_TEXT", target: "second", text: "B" } },
      ],
    }) });
    expect(r.status).toBe("paused");
    expect(r.steps).toBe(1);
    expect(r.plan?.completed).toEqual(["first"]);
    expect(await p.$$eval("input", es => es.map(e => e.value))).toEqual(["A", ""]);
    const done = await c.call(r.handoff!.resume);
    expect(done.status).toBe("done");
    expect(done.steps).toBe(2);
  } finally { await server.stop(); }
}));

test("unconfirmed actions and controls renamed during dispatch do not teach reusable bindings", async () => withPage(async p => {
  const server = await startServer({ "/": '<input aria-label="Name" oninput="this.setAttribute(\'aria-label\',\'Renamed\')"><output></output>' });
  try {
    await p.goto(server.url("/"));
    let calls = 0;
    const c = new JevController(p, async o => { calls++; return decision("TYPE_TEXT", o.elements[0]!.ref); });
    const plan = (text: string, extra = false) => planFor(p.url(), {
      targets: { field: { description: "The name input", role: "textbox", reuse: true } },
      stages: [{ id: "fill", goal: "Fill the name", action: { operation: "TYPE_TEXT", target: "field", text },
        ...(extra ? { until: { text: ["Confirmed"] }, timeoutMs: 100 } : {}) }],
    });
    const first = await c.call({ action: "run", goal: "Fill name", plan: plan("A") });
    expect(first.status).toBe("error");
    expect(first.reason).toContain("Input will not be retried");
    const second = await c.call({ action: "run", goal: "Fill name", plan: plan("B", true) });
    expect(second.status).toBe("needs_host");
    expect(second.decisions).toBe(1);
    await c.call({ action: "stop", sessionId: second.sessionId });
    const third = await c.call({ action: "run", goal: "Fill name", plan: plan("C") });
    expect(third.status).toBe("done");
    expect(third.decisions).toBe(1);
    expect(calls).toBe(3);
    await p.reload();
    await p.$eval("input", e => e.removeAttribute("oninput"));
    const reloaded = await c.call({ action: "run", goal: "Fill name", plan: plan("D") });
    expect(reloaded.status).toBe("done");
    expect(reloaded.decisions).toBe(1);
    expect(reloaded.plan?.bindingInvalidations).toBe(1);
  } finally { await server.stop(); }
}));

test("ambiguous select options hand off before dispatch", async () => withPage(async p => {
  const server = await startServer({ "/": '<select aria-label="Tier" onchange="window.changed=1"><option>Basic</option><option value=x>Pro</option><option value=y>Pro</option></select>' });
  try {
    await p.goto(server.url("/"));
    const r = await new JevController(p, noModel).call({ action: "run", goal: "Choose Pro", plan: planFor(p.url(), {
      targets: { tier: { label: "Tier" } },
      stages: [{ id: "tier", goal: "Choose Pro", action: { operation: "SELECT", target: "tier", option: { label: "Pro" } } }],
    }) });
    expect(r.status).toBe("needs_host");
    expect(r.reason).toContain("Several options");
    expect(r.steps).toBe(0);
    expect(await p.evaluate(() => (window as any).changed || 0)).toBe(0);
  } finally { await server.stop(); }
}));

test("positive preconditions and wait stages poll locally, with cancellation preventing later writes", async () => withPage(async p => {
  const server = await startServer({ "/": '<input aria-label="Name"><output></output>' });
  try {
    await p.goto(server.url("/"));
    const c = new JevController(p, noModel);
    const input = { action: "run", goal: "Wait then fill", plan: planFor(p.url(), {
      targets: { name: { label: "Name" } },
      stages: [
        { id: "ready", goal: "Wait for ready", wait: true, until: { text: ["Ready"] } },
        { id: "fill", goal: "Fill name", before: { text: ["Allowed"] }, action: { operation: "TYPE_TEXT", target: "name", text: "Ada" } },
      ],
    }) };
    await p.evaluate(() => {
      setTimeout(() => document.querySelector("output")!.textContent = "Ready", 100);
      setTimeout(() => document.querySelector("output")!.textContent = "Ready Allowed", 350);
    });
    const running = c.call(input);
    const done = await running;
    expect(done.status).toBe("done");
    expect(done.decisions).toBe(0);
    expect(done.timing.wallMs).toBeGreaterThanOrEqual(300);
    expect(await p.$eval("input", e => e.value)).toBe("Ada");
    await p.$eval("input", e => e.value = "");
    await p.$eval("output", e => e.textContent = "");
    const pending = c.call(input);
    await new Promise(r => setTimeout(r, 100));
    const sessionId = (c as any).session.id;
    await c.call({ action: "stop", sessionId });
    const stopped = await pending;
    expect(stopped.status).toBe("stopped");
    await p.$eval("output", e => e.textContent = "Ready Allowed");
    expect(stopped.steps).toBe(0);
    expect(await p.$eval("input", e => e.value)).toBe("");
  } finally { await server.stop(); }
}));
