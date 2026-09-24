import { afterAll, expect, test } from "bun:test";
import { JevController } from "../src/jev/controller.ts";
import { execute, observe, prepare } from "../src/jev/browser.ts";
import { withRun } from "../src/daemon/run-context.ts";
import type { Decision, JevResult, Observation, Operation } from "../src/jev/types.ts";
import { withPage, closeBrowser } from "./helpers/browser.ts";
import { startServer } from "./helpers/server.ts";

afterAll(closeBrowser);
const decision = (operation: Operation, target?: string): Decision => ({ operation, target, confidence: 1, latencyMs: 0, model: "fixture" });
const resume = (r: JevResult, text?: string, maxSteps?: number) => ({ action: "resume", sessionId: r.sessionId, requestId: r.requestId!, ...(text !== undefined ? { text } : {}), ...(maxSteps ? { maxSteps } : {}) });
const form = `<title>Local form</title><label>Name <input id=name></label><button onclick="window.submits=(window.submits||0)+1;document.querySelector('h1').textContent='Saved '+document.querySelector('input').value">Save</button><h1>Not saved</h1>`;

test("a new window hands off after one click, even without a named popup page", async () => withPage(async p => {
  await p.setContent(`<button onclick="window.opens=(window.opens||0)+1;window.open('about:blank','result')">Query</button>`);
  const c = new JevController(p, async o => decision('CLICK', o.elements[0]!.ref));
  const r = await c.call({ action: 'run', goal: 'Open the query results' });
  expect(r.status).toBe('needs_host');
  expect(r.stopReason).toBe('new_window');
  expect(r.openedWindows).toEqual(['about:blank']);
  expect(r.steps).toBe(1);
  expect(r.decisions).toBe(1);
  expect(await p.evaluate(() => (window as any).opens)).toBe(1);
  const client = (p as any)._client();
  expect(client.listenerCount('Page.windowOpen')).toBe(0);
}));

test("CSS city options and toggles retain distinct names, focus and observed state", async () => withPage(async p => {
  await p.setContent(`<input aria-label="Origin" value="Beijing"><ul style="cursor:pointer"><li>Beijing</li><li><span>Shanghai</span></li></ul><ul><li style="cursor:pointer" class="active">High speed<i></i></li></ul>`);
  await p.focus('input');
  const o = await observe(p, new AbortController().signal);
  expect(o.elements.find(e => e.label === 'Origin')).toMatchObject({ focused: true, value: 'Beijing' });
  for (const label of ['Beijing', 'Shanghai', 'High speed']) {
    const matches = o.elements.filter(e => e.label === label);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ operations: ['CLICK'], value: '' });
  }
  expect(o.elements.find(e => e.label === 'High speed')).toMatchObject({ className: 'active' });
  expect(o.elements.find(e => e.label === 'High speed')!.checked).toBeUndefined();
}));

test("unnamed toggles use only their adjacent caption, preserve accessible names and guard caption changes", async () => withPage(async p => {
  await p.setContent(`<form><input type=checkbox> checkbox 1<br><input type=checkbox checked><span>checkbox 2</span><br>
    <input type=checkbox aria-label="Explicit name">other caption<br><input type=checkbox><button>Unrelated</button>
    <input type=checkbox><span hidden>Hidden caption</span></form>`);
  const signal = new AbortController().signal;
  const o = await observe(p, signal);
  expect(o.elements.filter(e => e.role === 'checkbox').map(e => e.label)).toEqual(['checkbox 1', 'checkbox 2', 'Explicit name', 'checkbox', 'checkbox']);
  expect(o.elements.find(e => e.label === 'checkbox 2')?.checked).toBe(true);
  await p.$eval('span', e => e.textContent = 'Changed meaning');
  await expect(prepare(p, o, decision('CLICK', o.elements.find(e => e.label === 'checkbox 2')!.ref), signal)).rejects.toThrow('Page changed');
}));

test("async enable waits locally for prepared input without replaying the click or declaring blocked", async () => withPage(async p => {
  const srv = await startServer({ '/': `<input aria-label=Name disabled><button onclick="this.disabled=true;window.clicks=(window.clicks||0)+1;setTimeout(()=>{this.disabled=false;document.querySelector('input').disabled=false},400)">Enable</button>` });
  try {
    await p.goto(srv.url('/'));
    const c = new JevController(p, async o => {
      const field = o.elements.find(e => e.label === 'Name');
      if (field) return decision(field.value ? 'DONE' : 'TYPE_TEXT', field.value ? undefined : field.ref);
      const button = o.elements.find(e => e.label === 'Enable');
      return button ? decision('CLICK', button.ref) : decision('BLOCKED');
    });
    const r = await c.call({ action: 'run', goal: 'Enable and fill Name', inputs: [{ url: p.url(), label: 'Name', text: 'Alice' }] });
    expect(r.status).toBe('done');
    expect(r.decisions).toBe(3);
    expect(r.history.map(h => h.operation)).toEqual(['CLICK', 'TYPE_TEXT']);
    expect(await p.$eval('input', e => ({ disabled: e.disabled, value: e.value }))).toEqual({ disabled: false, value: 'Alice' });
    expect(await p.evaluate(() => (window as any).clicks)).toBe(1);
  } finally { await srv.stop(); }
}));

test("early BLOCKED and unsupported-control handoffs wait for an async click without standard loaders", async () => withPage(async p => {
  for (const operation of ['BLOCKED', 'HANDOFF'] as const) {
    await p.setContent(`<script>window.clicks=0</script><button onclick="this.remove();window.clicks=(window.clicks||0)+1;setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<h1>Ready</h1>'),350)">Start</button>`);
    const c = new JevController(p, async o => o.elements.length ? decision('CLICK', o.elements[0]!.ref) :
      o.text.includes('Ready') ? decision('DONE') : { ...decision(operation), handoffReason: 'unsupported_control' });
    const r = await c.call({ action: 'run', goal: 'Start and wait for Ready' });
    expect(r.status).toBe('done');
    expect(r.decisions).toBe(3);
    expect(r.trace[1]?.outcome).toBe('stale');
    expect(await p.evaluate(() => (window as any).clicks)).toBe(1);
  }
}));

test("WAIT after an action polls locally, while reasoning handoffs stay immediate", async () => withPage(async p => {
  await p.setContent(`<button onclick="this.remove();setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<h1>Ready</h1>'),450)">Start</button>`);
  const c = new JevController(p, async o => o.elements.length ? decision('CLICK', o.elements[0]!.ref) : decision(o.text.includes('Ready') ? 'DONE' : 'WAIT'));
  const r = await c.call({ action: 'run', goal: 'Start and wait for Ready' });
  expect(r.status).toBe('done');
  expect(r.decisions).toBe(3);
  expect(r.history.map(h => h.operation)).toEqual(['CLICK', 'WAIT']);
  await p.setContent('<button onclick="this.remove()">Start</button>');
  const host = new JevController(p, async o => o.elements.length ? decision('CLICK', o.elements[0]!.ref) : { ...decision('HANDOFF'), handoffReason: 'reasoning' });
  const handoff = await host.call({ action: 'run', goal: 'Start then ask the host to interpret' });
  expect(handoff.status).toBe('needs_host');
  expect(handoff.handoffReason).toBe('reasoning');
  expect(handoff.timing.settleMs).toBeLessThan(1000);
}));

test("a permanently disabled prepared control has a bounded wait and is never clicked twice", async () => withPage(async p => {
  const srv = await startServer({ '/': '<input aria-label=Name disabled><button onclick="this.disabled=true;window.clicks=(window.clicks||0)+1">Enable</button>' });
  try {
    await p.goto(srv.url('/'));
    const c = new JevController(p, async o => decision('CLICK', o.elements.find(e => e.label === 'Enable')!.ref));
    const r = await c.call({ action: 'run', goal: 'Enable and fill Name', inputs: [{ url: p.url(), label: 'Name', text: 'Alice' }] });
    expect(r.status).toBe('needs_host');
    expect(r.handoffReason).toBe('no_progress');
    expect(r.decisions).toBe(1);
    expect(r.timing.wallMs).toBeLessThan(7000);
    expect(await p.evaluate(() => (window as any).clicks)).toBe(1);
  } finally { await srv.stop(); }
}));

test("checkbox cycles stop before repeating a state, including across explicit bursts", async () => withPage(async p => {
  await p.setContent('<input type=checkbox onclick="window.clicks=(window.clicks||0)+1">Receive updates');
  const c = new JevController(p, async o => decision('CLICK', o.elements[0]!.ref));
  const first = await c.call({ action: 'run', goal: 'Set the checkbox', maxSteps: 1 });
  const second = await c.call(resume(first, undefined, 1));
  expect(first.history[0]).toMatchObject({ label: 'Receive updates', checkedBefore: false, checkedAfter: true });
  expect(second.history[1]).toMatchObject({ checkedBefore: true, checkedAfter: false });
  const third = await c.call(resume(second));
  expect(third.status).toBe('needs_host');
  expect(third.handoffReason).toBe('no_progress');
  expect(third.trace.at(-1)?.outcome).toBe('handoff');
  expect(await p.evaluate(() => (window as any).clicks)).toBe(2);
}));

test("prepared inputs do not mark a still-open autocomplete as confirmed", async () => withPage(async p => {
  const server = await startServer({ '/': `<input aria-label="Site search"><label>Origin<input id=origin onfocus="document.querySelector('ul').hidden=false"></label><ul hidden style="cursor:pointer"><li onclick="this.parentElement.hidden=true">Beijing</li></ul><label>Destination<input></label>` });
  try {
    await p.goto(server.url('/'));
    let calls = 0;
    const c = new JevController(p, async (o, goal) => {
      if (++calls === 1) return decision('TYPE_TEXT', o.elements.find(e => e.label === 'Origin')!.ref);
      expect(goal).toContain('Text insertion does not confirm an autocomplete selection');
      expect(goal).not.toContain('completed inputs');
      expect(goal).toContain('A covered field is not an invitation');
      expect(o.elements.find(e => e.label === 'Origin')!.operations).not.toContain('TYPE_TEXT');
      expect(o.elements.find(e => e.label === 'Beijing')).toBeDefined();
      return decision('HANDOFF');
    });
    const result = await c.call({ action: 'run', goal: 'Search Beijing to Shanghai', inputs: [
      { url: p.url(), label: 'Origin', text: 'Beijing' },
      { url: p.url(), label: 'Destination', text: 'Shanghai' },
    ] });
    expect(result.status).toBe('needs_host');
    expect(result.steps).toBe(1);
    expect(await p.$eval('[aria-label="Site search"]', e => (e as HTMLInputElement).value)).toBe('');
  } finally { await server.stop(); }
}));
function formDecision(p: Observation): Decision {
  if (p.text.includes("Saved Alice")) return decision("DONE");
  const field = p.elements.find(e => e.label === "Name")!;
  return field.value ? decision("CLICK", p.elements.find(e => e.label === "Save")!.ref) : decision("TYPE_TEXT", field.ref);
}

test("observes visible accessible fields/options and frames, filters disabled/password/file", async () => withPage(async p => {
  await p.setContent(`<label>Name <input></label><input aria-label=Password type=password value=secret><input type=file><button disabled>Disabled</button><button style="display:none">Hidden</button><select aria-label=Plan><option value=a>A</option><option disabled>B</option><option value=c>C</option></select><iframe srcdoc="<button>Inside</button>"></iframe>`);
  const o = await observe(p, new AbortController().signal);
  expect(o.elements.map(e => e.label)).toContain("Name");
  expect(o.elements.some(e => /Password|Disabled|Hidden|Choose File/.test(e.label))).toBe(false);
  expect(o.elements.find(e => e.label === 'Inside')?.ref).toMatch(/^f\d+e\d+$/);
  expect(JSON.stringify(o)).not.toContain("secret");
  expect(o.elements.find(e => e.label === "Plan")!.options!.map(e => e.index)).toEqual(["0", "2"]);
  expect(o.unsupportedFrames).toBe(false);
}));

test("host text handoff -> fill -> click -> unverified DONE; replay does not submit twice", async () => withPage(async p => {
  await p.setContent(form);
  const c = new JevController(p, async o => formDecision(o));
  const first = await c.call({ action: "run", goal: "Save the name Alice" });
  expect(first.status).toBe("needs_text");
  expect(first.field?.label).toBe("Name");
  expect(await p.$eval("input", e => e.value)).toBe("");
  const input = resume(first, "Alice");
  const done = await c.call(input);
  expect(done.status).toBe("done");
  expect(done.verified).toBe(false);
  expect(done.history.map(h => h.operation)).toEqual(["TYPE_TEXT", "CLICK"]);
  expect(await p.$eval("h1", e => e.textContent)).toBe("Saved Alice");
  expect(await c.call(input)).toEqual(done);
  expect(await p.evaluate(() => (window as any).submits)).toBe(1);
  await expect(c.call(resume(first, "Bob"))).rejects.toThrow("different input");
}));

test("stale text is discarded after navigation even when refs collide", async () => withPage(async p => {
  const srv = await startServer({ "/a": form, "/b": form });
  try {
    await p.goto(srv.url("/a"));
    const c = new JevController(p, async o => formDecision(o));
    const first = await c.call({ action: "run", goal: "Save Alice" });
    await p.goto(srv.url("/b"));
    const stale = await c.call(resume(first, "Alice"));
    expect(stale.status).toBe("paused");
    expect(stale.reason).toContain("discarded");
    expect(await p.$eval("input", e => e.value)).toBe("");
    const fresh = await c.call(resume(stale));
    expect(fresh.status).toBe("needs_text");
    expect(fresh.requestId).not.toBe(first.requestId);
    expect((await c.call(resume(fresh, "Alice"))).status).toBe("done");
  } finally { await srv.stop(); }
}));

test("replaced nodes, changed values and overlays invalidate a pending text request", async () => withPage(async p => {
  for (const change of [
    "document.querySelector('input').outerHTML='<input id=name aria-label=Name>'",
    "document.querySelector('input').value='Edited externally'",
    "document.body.insertAdjacentHTML('beforeend','<div style=\"position:fixed;inset:0;z-index:999;background:white\">Overlay</div>')",
  ]) {
    await p.setContent(form);
    const c = new JevController(p, async o => formDecision(o));
    const first = await c.call({ action: "run", goal: "Save Alice" });
    await p.evaluate(change);
    const next = await c.call(resume(first, "Alice"));
    expect(next.status).toBe("paused");
    expect(await p.$eval("input", e => e.value)).not.toBe("Alice");
  }
}));

test("a changed page during inference is observed again before clicking", async () => withPage(async p => {
  await p.setContent("<button onclick=\"document.title='old clicked'\">Old</button>");
  let calls = 0;
  const c = new JevController(p, async o => {
    if (++calls === 1) { await p.setContent("<title>New page</title><button onclick=\"document.title='new clicked'\">New</button>"); return decision("CLICK", o.elements[0]!.ref); }
    return decision("DONE");
  });
  expect((await c.call({ action: "run", goal: "Click only the old control" })).status).toBe("done");
  expect(calls).toBe(2);
  expect(await p.title()).toBe("New page");
}));

test("native SELECT selects the observed option and empty host text clears a field", async () => withPage(async p => {
  await p.setContent('<label>Plan <select><option value=a>Basic</option><option value=b>Pro</option></select></label><label>Name <input value=Old></label>');
  const c = new JevController(p, async o => {
    const plan = o.elements.find(e => e.label === "Plan")!;
    const name = o.elements.find(e => e.label === "Name")!;
    return plan.value !== "b" ? decision("SELECT", `${plan.ref}:1`) : name.value ? decision("TYPE_TEXT", name.ref) : decision("DONE");
  });
  const result = await c.call({ action: "run", goal: "Select Pro and clear Name" });
  expect(result.status).toBe("needs_text");
  expect(await p.$eval("select", e => e.value)).toBe("b");
  expect((await c.call(resume(result, ""))).status).toBe("done");
  expect(await p.$eval("input", e => e.value)).toBe("");
}));

test("action failure is uncertain and never retried", async () => withPage(async p => {
  await p.setContent('<button onclick="document.title=String(Number(document.title||0)+1)">Increment</button>');
  const original = Object.getPrototypeOf(p.mouse).click;
  p.mouse.click = async function (...args) { await original.apply(this, args); throw new Error("reply lost"); };
  const c = new JevController(p, async o => decision("CLICK", o.elements[0]!.ref));
  const r = await c.call({ action: "run", goal: "Increment once" });
  expect(r.status).toBe("error");
  expect(r.reason).toContain("will not be retried");
  expect(r.history[0]!.outcome).toBe("uncertain");
  expect(await p.title()).toBe("1");
}));

test("native clicks work when viewport observers stop firing on a hidden desktop", async () => withPage(async p => {
  await p.setContent('<button onclick="window.trusted=event.isTrusted;document.title=String(Number(document.title||0)+1)">Increment</button>');
  // Model the suspended observer callbacks seen on a locked Mac, in the
  // isolated world where Puppeteer's pre-click visibility check runs.
  const realm = (p.mainFrame() as any).isolatedRealm();
  await realm.evaluate(() => {
    (window as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  });
  const c = new JevController(p, async o => o.title === "1" ? decision("DONE") : decision("CLICK", o.elements[0]!.ref));
  const result = await c.call({ action: "run", goal: "Increment once", stepLimit: 2 });
  expect(result.status).toBe("done");
  expect(result.steps).toBe(1);
  expect(await p.title()).toBe("1");
  expect(await p.evaluate(() => (window as any).trusted)).toBe(true);
}), 5000);

test("a target covered after preflight receives no native click", async () => withPage(async p => {
  await p.setContent('<button onclick="document.title=\'clicked\'">Open</button>');
  const signal = new AbortController().signal;
  const observation = await observe(p, signal);
  const d = decision("CLICK", observation.elements[0]!.ref);
  const handle = await prepare(p, observation, d, signal);
  try {
    await p.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div onclick="document.title=\'overlay clicked\'" style="position:fixed;inset:0;z-index:999">Overlay</div>'));
    await expect(execute(p, observation, d, handle, undefined, signal)).rejects.toThrow("covered");
    expect(await p.title()).toBe("");
  } finally { await handle?.dispose(); }
}));

test("burst pauses and total session budget terminates a looping policy", async () => withPage(async p => {
  await p.setContent("<h1>Loading</h1>");
  const c = new JevController(p, async () => decision("WAIT"));
  const r = await c.call({ action: "run", goal: "Wait for content", maxSteps: 1, stepLimit: 2 });
  expect(r.status).toBe("paused");
  await expect(c.call(resume(r, "unsolicited"))).rejects.toThrow("does not accept text");
  const end = await c.call(resume(r));
  expect(end.status).toBe("blocked");
  expect(end.steps).toBe(2);
}));

test("stop and caller cancellation discard a late model decision; same-page input is locked", async () => withPage(async p => {
  for (const mode of ["stop", "abort"] as const) {
    await p.setContent('<button onclick="document.title=\'clicked\'">Click</button>');
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(r => ready = r);
    const wait = new Promise<void>(r => release = r);
    const c = new JevController(p, async o => { ready(); await wait; return decision("CLICK", o.elements[0]!.ref); });
    const abort = new AbortController();
    const job = withRun({ id: "test", emit() {}, signal: abort.signal }, () => c.call({ action: "run", goal: "Click" }));
    await entered;
    await expect(p.click("button")).rejects.toThrow("running Jev");
    await expect(c.call({ action: "run", goal: "Competing" })).rejects.toThrow("active Jev");
    if (mode === "abort") abort.abort();
    else {
      // The caller can obtain the id via status of its result in real usage; inspect this test controller's state.
      const id = (c as any).session.id;
      expect((await c.call({ action: "stop", sessionId: id })).status).toBe("stopped");
    }
    release();
    expect((await job).status).toBe("stopped");
    expect(await p.title()).not.toBe("clicked");
  }
}));

test("invalid continuation cannot write and missing credentials return an actionable error", async () => withPage(async p => {
  await p.setContent(form);
  const c = new JevController(p, async o => formDecision(o));
  const r = await c.call({ action: "run", goal: "Save Alice" });
  await expect(c.call({ ...resume(r, "Alice"), requestId: "wrong" })).rejects.toThrow("requestId");
  await expect(c.call(resume(r))).rejects.toThrow("Supply text");
  expect(await p.$eval("input", e => e.value)).toBe("");
  const missing = await withRun({ id: "test", emit() {}, jev: {} }, () => p.jev({ action: "run", goal: "Fill the form" }));
  expect(missing.status).toBe("error");
  expect(missing.reason).toContain("TYPESAFE_API_KEY");
}));

test("SELECT uses the exact observed option even when values are duplicated", async () => withPage(async p => {
  await p.setContent('<select aria-label=Choice><option value=same>First</option><option value=same>Second</option></select>');
  const c = new JevController(p, async o => decision("SELECT", `${o.elements[0]!.ref}:1`));
  expect((await c.call({ action: "run", goal: "Choose Second", maxSteps: 1 })).status).toBe("paused");
  expect(await p.$eval("select", e => e.selectedIndex)).toBe(1);
}));

test("text cannot be redirected to another field by a focus/input handler", async () => withPage(async p => {
  for (const replace of [false, true]) {
    await p.setContent(`<input aria-label=Name id=name oninput="${replace ? "this.outerHTML='<input aria-label=Name id=name>';" : ""}document.querySelector('#other').focus()"><input aria-label=Other id=other>`);
    const c = new JevController(p, async o => decision("TYPE_TEXT", o.elements.find(e => e.label === "Name")!.ref));
    const first = await c.call({ action: "run", goal: "Enter Alice in Name" });
    const next = await c.call(resume(first, "Alice", 1));
    expect(await p.$eval("input#other", e => e.value)).toBe("");
    if (replace) {
      expect(next.status).toBe("error");
      expect(next.history[0]!.outcome).toBe("uncertain");
    } else {
      expect(next.status).toBe("paused");
      expect(await p.$eval("input#name", e => e.value)).toBe("Alice");
    }
  }
}));

test("default call continues past ten clicks without host round trips and records timings", async () => withPage(async p => {
  await p.setContent('<title>0</title><button onclick="document.title=String(Number(document.title)+1)">Next</button>');
  const c = new JevController(p, async o => o.title === "12" ? decision("DONE") : decision("CLICK", o.elements[0]!.ref));
  const r = await c.call({ action: "run", goal: "Advance twelve times", stepLimit: 20 });
  expect(r.status).toBe("done");
  expect(r.steps).toBe(12);
  expect(r.decisions).toBe(13);
  expect(r.trace).toHaveLength(13);
  expect(r.trace.at(-1)?.outcome).toBe("done");
  expect(r.timing.hostWaitMs).toBe(0);
  expect(r.timing.preflightMs).toBeGreaterThan(0);
  expect(r.timing.wallMs).toBeGreaterThanOrEqual(r.elapsedMs);
  expect(await p.title()).toBe("12");
}));

test("Jev can request host reasoning and resume after host work without repeating actions", async () => withPage(async p => {
  await p.setContent('<title>Compare</title><p>Two options need interpretation</p>');
  const c = new JevController(p, async o => o.title === "Resolved" ? decision("DONE") : { ...decision("HANDOFF"), handoffReason: "reasoning" });
  const first = await c.call({ action: "run", goal: "Review the options" });
  expect(first.status).toBe("needs_host");
  expect(first.handoffReason).toBe("reasoning");
  expect(first.steps).toBe(0);
  await new Promise(r => setTimeout(r, 25));
  await p.evaluate(() => document.title = "Resolved");
  const input = resume(first);
  const done = await c.call(input);
  expect(done.status).toBe("done");
  expect(done.timing.hostWaitMs).toBeGreaterThanOrEqual(20);
  expect(done.trace[0]?.outcome).toBe("handoff");
  expect(await c.call(input)).toEqual(done);
}));

test("unrelated visible updates do not invalidate a click but changed target context does", async () => withPage(async p => {
  for (const relevant of [false, true]) {
    await p.setContent('<header id=ticker>Tick 0</header><article><p id=context>Original item</p><button onclick="document.title=\'clicked\'">Open</button></article>');
    let calls = 0;
    const c = new JevController(p, async o => {
      if (++calls === 1) {
        await p.$eval(relevant ? "#context" : "#ticker", e => e.textContent = "Changed");
        return decision("CLICK", o.elements.find(e => e.label === "Open")!.ref);
      }
      return decision("DONE");
    });
    const r = await c.call({ action: "run", goal: "Open original item" });
    expect(r.status).toBe("done");
    expect(r.steps).toBe(relevant ? 0 : 1);
    expect(r.trace[0]?.outcome).toBe(relevant ? "stale" : "executed");
    expect(await p.title()).toBe(relevant ? "" : "clicked");
  }
}));

test("scoped click guards reject replacement, changed fields, disabled controls and overlays", async () => withPage(async p => {
  for (const mutation of [
    "document.querySelector('button').outerHTML='<button>Open</button>'",
    "document.querySelector('input').value='Changed externally'",
    "document.querySelector('button').disabled=true",
    "document.body.insertAdjacentHTML('beforeend','<div style=\"position:fixed;inset:0;z-index:99;background:white\">Overlay</div>')",
  ]) {
    await p.setContent('<input aria-label=Name><button onclick="document.title=\'clicked\'">Open</button>');
    let calls = 0;
    const c = new JevController(p, async o => {
      if (++calls > 1) return decision("DONE");
      await p.evaluate(mutation);
      return decision("CLICK", o.elements.find(e => e.label === "Open")!.ref);
    });
    const r = await c.call({ action: "run", goal: "Open only the observed item" });
    expect(r.steps).toBe(0);
    expect(await p.title()).not.toBe("clicked");
  }
}));

test("native rich-text input updates editors that reject synthetic events, including replacement", async () => withPage(async p => {
  for (const text of ["你好 Jev 👋", "first\nsecond", ""]) {
    await p.setContent('<div role=textbox contenteditable=true aria-label=Comment>Old draft</div><button disabled>Reply</button><script>document.querySelector("[contenteditable]").addEventListener("input",e=>{if(e.isTrusted){window.accepted=true;document.querySelector("button").disabled=false}})</script>');
    const c = new JevController(p, async o => decision("TYPE_TEXT", o.elements.find(e => e.label === "Comment")!.ref));
    const first = await c.call({ action: "run", goal: "Fill comment" });
    const result = await c.call(resume(first, text, 1));
    expect(result.status).toBe("paused");
    expect(await p.$eval("[contenteditable]", e => e.textContent ? (e as HTMLElement).innerText : "")).toBe(text);
    expect((await observe(p, new AbortController().signal)).elements.find(e => e.label === "Comment")?.value).toBe(text);
    expect(await p.$eval("button", e => e.disabled)).toBe(false);
    expect(await p.evaluate(() => (window as any).accepted)).toBe(true);
  }
}));

test("rich-text focus redirection never writes to another field", async () => withPage(async p => {
  await p.setContent('<div role=textbox contenteditable=true aria-label=Comment onfocus="document.querySelector(\'input\').focus()">Old</div><input aria-label=Other>');
  const c = new JevController(p, async o => decision("TYPE_TEXT", o.elements.find(e => e.label === "Comment")!.ref));
  const first = await c.call({ action: "run", goal: "Fill Comment" });
  const r = await c.call(resume(first, "Private text", 1));
  expect(r.status).toBe("error");
  expect(await p.$eval("input", e => e.value)).toBe("");
  expect(await p.$eval("[contenteditable]", e => e.textContent)).toBe("Old");
}));

test("DONE while results are loading is rechecked locally; no-progress clicks hand off", async () => withPage(async p => {
  await p.setContent('<main aria-busy=true><h1>Waiting</h1></main>');
  let calls = 0;
  const c = new JevController(p, async () => {
    if (++calls === 2) await p.$eval("main", e => { e.removeAttribute("aria-busy"); e.textContent = "Results ready"; });
    return decision("DONE");
  });
  const r = await c.call({ action: "run", goal: "Wait for results" });
  expect(r.status).toBe("done");
  expect(calls).toBeGreaterThanOrEqual(3);
  expect(r.page?.text).toContain("Results ready");
  await p.setContent('<button>Does nothing</button>');
  const stuck = new JevController(p, async o => decision("CLICK", o.elements[0]!.ref));
  const end = await stuck.call({ action: "run", goal: "Advance" });
  expect(end.status).toBe("needs_host");
  expect(end.handoffReason).toBe("no_progress");
  expect(end.steps).toBe(3);
}));

test("unrelated changes during field choice allow handoff, but stale supplied text is still discarded", async () => withPage(async p => {
  await p.setContent('<header>Dynamic ticker</header><form><label>Search <input></label></form>');
  const c = new JevController(p, async o => {
    await p.$eval("header", e => e.textContent = "Ticker updated");
    return decision("TYPE_TEXT", o.elements.find(e => e.label === "Search")!.ref);
  });
  const first = await c.call({ action: "run", goal: "Search Jev" });
  expect(first.status).toBe("needs_text");
  expect(first.decisions).toBe(1);
  expect(first.page?.text).toContain("Ticker updated");
  await p.$eval("header", e => e.textContent = "Changed while the host was writing");
  const stale = await c.call(resume(first, "Jev"));
  expect(stale.status).toBe("paused");
  expect(stale.stopReason).toBe("stale_page");
  expect(await p.$eval("input", e => e.value)).toBe("");
}));

test("an editor that asynchronously duplicates text stops before submission and is not retried", async () => withPage(async p => {
  await p.setContent('<div contenteditable=true role=textbox aria-label=Comment></div><button onclick="window.submitted=true">Submit</button><script>document.querySelector("[contenteditable]").addEventListener("input",e=>setTimeout(()=>e.target.append(e.target.textContent),0))</script>');
  const c = new JevController(p, async o => {
    const field=o.elements.find(e=>e.label==="Comment")!;
    return field.value ? decision("CLICK",o.elements.find(e=>e.label==="Submit")!.ref) : decision("TYPE_TEXT",field.ref);
  });
  const first=await c.call({action:"run",goal:"Write one comment and submit"});
  const end=await c.call(resume(first,"Once"));
  expect(end.status).toBe("error");
  expect(end.reason).toContain("will not be retried");
  expect(end.steps).toBe(1);
  expect(await p.evaluate(()=>(window as any).submitted)).toBeUndefined();
  expect(await p.$eval('[contenteditable]',e=>e.textContent)).toBe("OnceOnce");
}));

test("submission boundary waits for new feedback then stops without another model decision", async () => withPage(async p => {
  await p.setContent('<label>Comment <input></label><button onclick="window.submits=(window.submits||0)+1;setTimeout(()=>{document.querySelector(\'input\').value=\'\';document.querySelector(\'output\').textContent=\'Your post was sent.\'},180)">Reply</button><output></output>');
  let calls = 0;
  const c = new JevController(p, async o => {
    if (++calls > 2) throw Error("The policy would write a second reply");
    return calls === 1 ? decision("TYPE_TEXT", o.elements.find(e => e.label === "Comment")!.ref) : decision("CLICK", o.elements.find(e => e.label === "Reply")!.ref);
  });
  const first = await c.call({ action: "run", goal: "Reply once", completion: { submitLabel: "Reply", successText: "Your post was sent." } });
  const input = resume(first, "One comment");
  const result = await c.call(input);
  expect(result.status).toBe("done");
  expect(result.stopReason).toBe("submission_confirmed");
  expect(result.completionEvidence?.text).toBe("Your post was sent.");
  expect(result.verified).toBe(false);
  expect(calls).toBe(2);
  expect(await p.evaluate(() => (window as any).submits)).toBe(1);
  expect(await c.call(input)).toEqual(result);
}));

test("old feedback and success words in ordinary content cannot confirm a submit; resume only observes", async () => withPage(async p => {
  await p.setContent('<article>Your post was sent.</article><div role=status>Saved previously</div><button onclick="window.submits=(window.submits||0)+1">Send</button>');
  let calls = 0;
  const c = new JevController(p, async o => { calls++; return decision("CLICK", o.elements.find(e => e.label === "Send")!.ref); });
  const result = await c.call({ action: "run", goal: "Send once", completion: { submitLabel: "Send", successText: "Saved previously" }, stepLimit: 1 });
  expect(result.status).toBe("needs_host");
  expect(result.stopReason).toBe("submission_unconfirmed");
  expect(calls).toBe(1);
  // A late server acknowledgement changes the live region. Resuming must not
  // repeat the click, even though the action budget was already exhausted.
  await p.$eval('[role=status]', e => e.textContent = "Saved previously; record 42 confirmed");
  const end = await c.call(resume(result));
  expect(end.status).toBe("done");
  expect(end.steps).toBe(1);
  expect(calls).toBe(1);
  expect(await p.evaluate(() => (window as any).submits)).toBe(1);
}));

test("plain page text cannot impersonate a submission success live region", async () => withPage(async p => {
  await p.setContent('<button onclick="document.querySelector(\'p\').textContent=\'Sent successfully\'">Send</button><p></p>');
  const c = new JevController(p, async o => decision("CLICK", o.elements[0]!.ref));
  const result = await c.call({ action: "run", goal: "Send once", completion: { submitLabel: "Send", successText: "Sent successfully" } });
  expect(result.status).toBe("needs_host");
  expect(result.steps).toBe(1);
  expect(result.completionEvidence).toBeUndefined();
}));

test("submission completion wins over the action budget and premature model DONE is rejected", async () => withPage(async p => {
  await p.setContent('<button onclick="document.querySelector(\'output\').textContent=\'Sent\'">Send</button><output></output>');
  const c = new JevController(p, async o => decision("CLICK", o.elements[0]!.ref));
  const r = await c.call({ action: "run", goal: "Send once", stepLimit: 1, completion: { submitLabel: "Send", successText: "Sent" } });
  expect(r.status).toBe("done");
  expect(r.steps).toBe(1);
  const premature = new JevController(p, async () => decision("DONE"));
  const end = await premature.call({ action: "run", goal: "Another authorized send", completion: { submitLabel: "Send", successText: "Sent" } });
  expect(end.status).toBe("needs_host");
  expect(end.steps).toBe(0);
}));

test("covered controls are omitted and an open listbox prevents background scrolling", async () => withPage(async p => {
  await p.setContent('<button>Background</button><div style="height:3000px"></div><div role=dialog style="position:fixed;inset:0;background:white"><button>Inside</button></div>');
  const o = await observe(p, new AbortController().signal);
  expect(o.elements.some(e => e.label === "Background")).toBe(false);
  expect(o.elements.some(e => e.label === "Inside")).toBe(true);
  expect(o.scroll.down).toBe(false);
  await p.setContent('<input role=combobox aria-label=Search oninput="if(document.activeElement===this)document.querySelector(\'[role=listbox]\').hidden=false"><div role=listbox hidden><div role=option>Search for Jev</div></div><div style="height:3000px"></div>');
  const c = new JevController(p, async o => decision("TYPE_TEXT", o.elements.find(e => e.label === "Search")!.ref));
  const first = await c.call({ action: "run", goal: "Search Jev" });
  await c.call(resume(first, "Jev", 1));
  const after = await observe(p, new AbortController().signal);
  expect(after.elements.some(e => e.label === "Search for Jev")).toBe(true);
  expect(after.scroll.down).toBe(false);
}));

test("unrelated ticker updates do not invalidate a supported main-page scroll", async () => withPage(async p => {
  await p.setContent('<header>Tick</header><main style="height:3000px">Content</main>');
  const c = new JevController(p, async () => {
    await p.$eval("header", e => e.textContent = "Changed ticker");
    return decision("SCROLL_DOWN");
  });
  const r = await c.call({ action: "run", goal: "Scroll", maxSteps: 1 });
  expect(r.steps).toBe(1);
  expect(r.trace[0]?.outcome).toBe("executed");
  expect(await p.evaluate(() => scrollY)).toBeGreaterThan(0);
}));

test("URL-bound provided inputs run through one submission without a host text round trip", async () => withPage(async p => {
  const srv = await startServer({ "/form": '<header>Tick</header><label>Name <input></label><button onclick="window.submits=(window.submits||0)+1;document.querySelector(\'output\').textContent=\'Saved Alice\'">Save</button><output></output>' });
  try {
    await p.goto(srv.url("/form"));
    const c = new JevController(p, async o => {
      const field = o.elements.find(e => e.label === "Name")!;
      if (!field.value) { await p.$eval("header", e => e.textContent = "Unrelated ticker changed"); return decision("TYPE_TEXT", field.ref); }
      expect(field.operations).not.toContain("TYPE_TEXT");
      return decision("CLICK", o.elements.find(e => e.label === "Save")!.ref);
    });
    const r = await c.call({ action: "run", goal: "Save Alice", inputs: [{ url: srv.url("/form"), label: "Name", text: "Alice" }], completion: { submitLabel: "Save", successText: "Saved Alice" } });
    expect(r.status).toBe("done");
    expect(r.stopReason).toBe("submission_confirmed");
    expect(r.trace[0]).toMatchObject({ operation: "TYPE_TEXT", textSource: "provided", outcome: "executed" });
    expect(r.decisions).toBe(2);
    expect(await p.$eval("input", e => e.value)).toBe("Alice");
    expect(await p.evaluate(() => (window as any).submits)).toBe(1);
  } finally { await srv.stop(); }
}));

test("provided input never crosses a URL boundary or fills an ambiguous field", async () => withPage(async p => {
  const srv = await startServer({ "/a": '<input aria-label=Name><input aria-label=Name>', "/b": '<input aria-label=Name>' });
  try {
    const known = { url: srv.url("/a"), label: "Name", text: "Private draft" };
    for (const path of ["/a", "/b"]) {
      await p.goto(srv.url(path));
      const c = new JevController(p, async o => decision("TYPE_TEXT", o.elements[0]!.ref));
      const r = await c.call({ action: "run", goal: "Fill Name", inputs: [known] });
      expect(r.status).toBe(path === "/a" ? "needs_host" : "needs_text");
      expect(r.steps).toBe(0);
      expect(await p.$eval("input", e => e.value)).toBe("");
    }
  } finally { await srv.stop(); }
}));

test("provided inputs survive stale preflight but never retry an uncertain dispatch", async () => withPage(async p => {
  const srv = await startServer({ "/form": '<label>Name <input></label>' });
  try {
    await p.goto(srv.url("/form"));
    let choices = 0;
    const c = new JevController(p, async o => {
      if (++choices === 1) await p.$eval("input", e => e.outerHTML = '<input aria-label=Name>');
      return o.elements.some(e => e.operations.includes("TYPE_TEXT")) ? decision("TYPE_TEXT", o.elements.find(e => e.operations.includes("TYPE_TEXT"))!.ref) : decision("DONE");
    });
    const r = await c.call({ action: "run", goal: "Fill Name once", inputs: [{ url: srv.url("/form"), label: "Name", text: "Alice" }] });
    expect(r.status).toBe("done");
    expect(r.trace[0]?.outcome).toBe("stale");
    expect(r.history.filter(h => h.operation === "TYPE_TEXT")).toHaveLength(1);
    await p.setContent('<input aria-label=Name oninput="window.inputs=(window.inputs||0)+1;this.remove()">');
    const failing = new JevController(p, async o => decision("TYPE_TEXT", o.elements[0]!.ref));
    const end = await failing.call({ action: "run", goal: "Fill once", inputs: [{ url: p.url(), label: "Name", text: "Alice" }] });
    expect(end.status).toBe("error");
    expect(await p.evaluate(() => (window as any).inputs)).toBe(1);
  } finally { await srv.stop(); }
}));

test("fast observation retains labels, clickable articles and shadow fields without repeated article bodies", async () => withPage(async p => {
  await p.setContent('<style>.custom-action{cursor:pointer}</style><article tabindex=0 style="cursor:pointer"><p>Unique article sentence.</p></article><div class=custom-action><span>Custom action</span></div><div id=shadow></div><div style="margin-top:3000px">Offscreen noise</div>');
  await p.$eval('.custom-action', e => e.addEventListener('click', () => document.title = 'custom clicked'));
  await p.$eval("#shadow", e => e.attachShadow({ mode: "open" }).innerHTML = '<label for=q>Shadow query</label><input id=q>');
  const o = await observe(p, new AbortController().signal);
  expect(o.text.split("Unique article sentence.")).toHaveLength(2);
  expect(o.text).not.toContain("Offscreen noise");
  expect(o.elements.some(e => e.role === "article" && e.operations.includes("CLICK"))).toBe(true);
  expect(o.elements.some(e => e.label === "Shadow query" && e.operations.includes("TYPE_TEXT"))).toBe(true);
  const custom = o.elements.filter(e => e.role === "generic" && e.operations.includes("CLICK"));
  expect(custom).toHaveLength(1);
  const action = decision("CLICK", custom[0]!.ref);
  const signal = new AbortController().signal;
  const handle = await prepare(p, o, action, signal);
  try { await execute(p, o, action, handle, undefined, signal); } finally { await handle?.dispose(); }
  expect(await p.title()).toBe("custom clicked");
}));

test("satisfied provided inputs are consumed, and a cleared field needs fresh host text", async () => withPage(async p => {
  const srv = await startServer({ "/form": '<input aria-label=Name oninput="window.inputs=(window.inputs||0)+1"><button onclick="document.querySelector(\'input\').value=\'\'">Clear</button>' });
  try {
    for (const alreadyFilled of [false, true]) {
      await p.goto(srv.url("/form"));
      if (alreadyFilled) await p.$eval('input', e => e.value = 'Alice');
      const c = new JevController(p, async o => {
        const field = o.elements.find(e => e.label === "Name")!;
        if (!field.value) return decision("TYPE_TEXT", field.ref);
        expect(field.operations).not.toContain("TYPE_TEXT");
        return decision("CLICK", o.elements.find(e => e.label === "Clear")!.ref);
      });
      const r = await c.call({ action: "run", goal: "Fill then clear Name", inputs: [{ url: p.url(), label: "Name", text: "Alice" }] });
      expect(r.status).toBe("needs_text");
      expect(r.trace.at(-1)?.textSource).toBe("host");
      expect(await p.$eval('input', e => e.value)).toBe("");
      expect(await p.evaluate(() => (window as any).inputs || 0)).toBe(alreadyFilled ? 0 : 1);
    }
  } finally { await srv.stop(); }
}));

test("a prepared replacement prevents submitting the old value", async () => withPage(async p => {
  const srv = await startServer({ "/form": '<input aria-label=Name value=Old><button onclick="window.submits=(window.submits||0)+1;document.querySelector(\'output\').textContent=\'Saved Alice\'">Save</button><output></output>' });
  try {
    await p.goto(srv.url('/form'));
    const c = new JevController(p, async (o, goal) => {
      if (o.elements.find(e => e.label === 'Name')?.value === 'Old') expect(goal).toContain('even if they currently contain an old value');
      // Deliberately ignore the prompt: the runtime must still not submit old text.
      return decision('CLICK', o.elements.find(e => e.label === 'Save')!.ref);
    });
    const r = await c.call({ action: 'run', goal: 'Save Alice', inputs: [{ url: p.url(), label: 'Name', text: 'Alice' }], completion: { submitLabel: 'Save', successText: 'Saved Alice' } });
    expect(r.status).toBe('needs_host');
    expect(r.steps).toBe(0);
    expect(await p.evaluate(() => (window as any).submits || 0)).toBe(0);
    await p.$eval('input', e => e.value = 'Alice');
    expect((await c.call(resume(r))).status).toBe('done');
    expect(await p.evaluate(() => (window as any).submits)).toBe(1);
  } finally { await srv.stop(); }
}));

test("container clicks never activate a nested control at the hit point", async () => withPage(async p => {
  await p.setContent('<article style="position:relative;width:300px;height:100px;cursor:pointer" onclick="window.outerClicks=(window.outerClicks||0)+1">Post</article>');
  const signal = new AbortController().signal;
  const o = await observe(p, signal);
  const d = decision('CLICK', o.elements.find(e => e.role === 'article')!.ref);
  const handle = await prepare(p, o, d, signal);
  try {
    await p.$eval('article', e => e.insertAdjacentHTML('beforeend', '<button style="position:absolute;inset:0" onclick="window.innerClicks=1">Play video</button>'));
    const current = await observe(p, signal);
    expect(current.elements.some(e => e.role === 'article' && e.operations.includes('CLICK'))).toBe(false);
    expect(current.elements.some(e => e.label === 'Play video' && e.operations.includes('CLICK'))).toBe(true);
    await expect(execute(p, o, d, handle, undefined, signal)).rejects.toThrow('covered');
    expect(await p.evaluate(() => (window as any).outerClicks || (window as any).innerClicks || 0)).toBe(0);
  } finally { await handle?.dispose(); }
}));

test("permalinks tolerate article timer updates but reject changed destinations", async () => withPage(async p => {
  const srv = await startServer({ '/feed': '<article><a href=/post>Post permalink</a><span>0:01</span></article>', '/post': '<h1>The selected post</h1>' });
  try {
    for (const changedHref of [false, true]) {
      await p.goto(srv.url('/feed'));
      let calls = 0;
      const c = new JevController(p, async o => {
        if (++calls > 1) return decision('HANDOFF');
        await p.$eval('span', e => e.textContent = '0:02');
        if (changedHref) await p.$eval('a', e => e.href = '/other');
        return decision('CLICK', o.elements.find(e => e.role === 'link')!.ref);
      });
      const r = await c.call({ action: 'run', goal: 'Open the selected post', maxSteps: 1 });
      expect(r.steps).toBe(changedHref ? 0 : 1);
      expect(r.trace[0]?.outcome).toBe(changedHref ? 'stale' : 'executed');
      expect(p.url()).toBe(srv.url(changedHref ? '/feed' : '/post'));
    }
  } finally { await srv.stop(); }
}));

test("articles with permalinks offer the precise link with its post context", async () => withPage(async p => {
  await p.setContent('<article style="cursor:pointer;width:400px;height:200px"><a href="https://example.com/post"><time>Today</time></a><p>Jev Ultrafast release</p><div>Media overlay</div></article>');
  const o = await observe(p, new AbortController().signal);
  expect(o.elements.some(e => e.role === 'article')).toBe(false);
  const link = o.elements.find(e => e.label === 'Today')!;
  expect(link.href).toBe('https://example.com/post');
  expect(link.context).toContain('Jev Ultrafast release');
}));

test("a premature BLOCKED after navigation waits locally for delayed content", async () => withPage(async p => {
  const srv = await startServer({ '/start': '<a href=/shell>Open results</a>', '/shell': '<main>Loading results</main><script>setTimeout(()=>document.querySelector("main").innerHTML="<button>Ready result</button>",400)</script>' });
  try {
    await p.goto(srv.url('/start'));
    const c = new JevController(p, async o => {
      const link = o.elements.find(e => e.label === 'Open results');
      if (link) return decision('CLICK', link.ref);
      return decision(o.elements.some(e => e.label === 'Ready result') ? 'DONE' : 'BLOCKED');
    });
    const r = await c.call({ action: 'run', goal: 'Open the results and wait for Ready result' });
    expect(r.status).toBe('done');
    expect(r.trace.some(t => t.operation === 'BLOCKED' && t.outcome === 'stale')).toBe(true);
    expect(r.timing.hostWaitMs).toBe(0);
    expect(await p.$eval('button', e => e.textContent)).toBe('Ready result');
  } finally { await srv.stop(); }
}));

test("navigation loaders settle locally without paying for empty-page predictions", async () => withPage(async p => {
  const srv = await startServer({ '/start': '<a href=/results>Open results</a>', '/results': '<main aria-busy=true>Waiting</main><script>setTimeout(()=>{document.querySelector("main").removeAttribute("aria-busy");document.querySelector("main").textContent="Results ready"},400)</script>' });
  try {
    await p.goto(srv.url('/start'));
    const c = new JevController(p, async o => {
      expect(o.loading).toBe(false);
      const link = o.elements.find(e => e.label === 'Open results');
      return link ? decision('CLICK', link.ref) : decision('DONE');
    });
    const r = await c.call({ action: 'run', goal: 'Open results and wait for Results ready' });
    expect(r.status).toBe('done');
    expect(r.decisions).toBe(2);
    expect(r.page?.text).toContain('Results ready');
    expect(r.timing.hostWaitMs).toBe(0);
  } finally { await srv.stop(); }
}));
