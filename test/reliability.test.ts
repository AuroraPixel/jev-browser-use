import { afterAll, expect, test } from "bun:test";
import { JevController } from "../src/jev/controller.ts";
import { execute, observe, prepare, StaleObservation } from "../src/jev/browser.ts";
import type { Decision, Operation } from "../src/jev/types.ts";
import { withPage, closeBrowser } from "./helpers/browser.ts";
import { startServer } from "./helpers/server.ts";

afterAll(closeBrowser);
const choice = (operation: Operation, target?: string): Decision => ({ operation, target, confidence: 1, latencyMs: 0, model: "fixture" });
const signal = () => new AbortController().signal;

test("submit preconditions are freshly rechecked after inference; repair resumes once", () => withPage(async p => {
  await p.setContent('<form><input aria-label=Quantity value=2><button type=button onclick="window.n=(window.n||0)+1;document.querySelector(\'main\').textContent=\'Receipt 123\'">Submit</button></form><main></main>');
  let calls = 0;
  const c = new JevController(p, async o => {
    if (++calls === 1) await p.$eval('input', e => e.value = '3');
    return choice('CLICK', o.elements.find(e => e.label === 'Submit')!.ref);
  });
  const first = await c.call({ action: 'run', goal: 'Submit exactly two items', completion: { submitLabel: 'Submit', before: { fields: [{ label: 'Quantity', value: '2' }] }, after: { text: ['Receipt 123'] } } });
  expect(first.status).toBe('needs_host'); expect(first.steps).toBe(0);
  expect(first.taskState?.before?.matched).toBe(false);
  expect(await p.evaluate(() => (window as any).n ?? 0)).toBe(0);
  await p.$eval('input', e => e.value = '2');
  const done = await c.call(first.handoff!.resume);
  expect(done.stopReason).toBe('submission_confirmed');
  expect(done.taskState?.phase).toBe('evidence_matched');
  expect(await p.evaluate(() => (window as any).n)).toBe(1);
  expect(done.completionEvidence?.checks?.every(c => c.matched)).toBe(true);
}));

test("pre-existing post-submit evidence never authorizes a duplicate submission", () => withPage(async p => {
  await p.setContent('<main>Receipt 123</main><div style="height:1000px"></div><button onclick="window.n=1">Submit</button>');
  await p.$eval('button',e=>e.scrollIntoView());
  const c = new JevController(p, async o => choice('CLICK', o.elements[0]!.ref));
  const r = await c.call({ action: 'run', goal: 'Submit once', completion: { submitLabel: 'Submit', after: { text: ['Receipt 123'] } } });
  expect(r.status).toBe('needs_host'); expect(r.steps).toBe(0);
  expect(await p.evaluate(() => (window as any).n)).toBeUndefined();
}));

test("hidden receipt text is not pre-existing evidence; only its rendered result confirms submission", () => withPage(async p => {
  await p.setContent('<button onclick="document.querySelector(\'main\').style.display=\'block\'">Submit</button><main style="display:none">Receipt 123</main>');
  const c = new JevController(p,async o=>choice('CLICK',o.elements[0]!.ref));
  const r = await c.call({action:'run',goal:'Submit once',completion:{submitLabel:'Submit',after:{text:['Receipt 123']}}});
  expect(r.stopReason).toBe('submission_confirmed');expect(r.steps).toBe(1);
}));

test("satisfied text stays out of action candidates while finding an offscreen submit", () => withPage(async p => {
  await p.setContent('<textarea aria-label=CSV>00:00,42,19</textarea><div style="height:900px"></div><button onclick="window.scrollTo(0,0);document.querySelector(\'main\').textContent=\'Receipt\'">Submit</button><main style="position:fixed;top:10px;right:10px"></main>');
  const c = new JevController(p, async o => {
    expect(o.elements.find(e=>e.label==='CSV')?.operations ?? []).toEqual([]);
    const submit = o.elements.find(e=>e.label==='Submit');
    return submit ? choice('CLICK',submit.ref) : choice('SCROLL_DOWN');
  });
  const r = await c.call({action:'run',goal:'Submit completed CSV',completion:{submitLabel:'Submit',before:{fields:[{label:'CSV',value:'00:00,42,19'}]},after:{text:['Receipt']}}});
  expect(r.status).toBe('done'); expect(r.taskState?.before?.matched).toBe(true);
  expect(r.history.filter(h=>h.operation==='CLICK')).toHaveLength(1);
}));

test("uncertain submission stays observe-only across resume", () => withPage(async p => {
  await p.setContent('<button onclick="window.n=(window.n||0)+1">Submit</button><main>Pending</main>');
  const c = new JevController(p, async o => choice('CLICK', o.elements[0]!.ref));
  const r = await c.call({ action: 'run', goal: 'Submit once', completion: { submitLabel: 'Submit', after: { text: ['Receipt 123'] } } });
  expect(r.stopReason).toBe('submission_unconfirmed');
  expect(r.taskState?.phase).toBe('submitted');
  await p.$eval('main', e => e.textContent = 'Receipt 123');
  const done = await c.call(r.handoff!.resume);
  expect(done.stopReason).toBe('submission_confirmed'); expect(done.decisions).toBe(1);
  expect(await p.evaluate(() => (window as any).n)).toBe(1);
}));

test("full-session task counts survive bursts longer than recent history", () => withPage(async p => {
  await p.setContent('<button onclick="document.querySelector(\'output\').textContent=++window.n">Add</button><output>0</output><script>window.n=0</script>');
  const c = new JevController(p, async o => choice('CLICK', o.elements[0]!.ref));
  let r = await c.call({ action: 'run', goal: 'Add twelve', maxSteps: 6, until: { text: ['12'] } });
  r = await c.call({ action: 'resume', sessionId: r.sessionId, requestId: r.requestId!, maxSteps: 6 });
  expect(r.status).toBe('done'); expect(r.history.length).toBe(10);
  expect(r.taskState?.actions).toEqual([{ operation: 'CLICK', label: 'Add', executed: 12, uncertain: 0 }]);
}));

test("nine nested frames expose executable refs and visible completion evidence", () => withPage(async p => {
  const s = await startServer();
  for (let i = 0; i < 10; i++) s.set('/f' + i, `<body style="margin:0">${i === 9 ? '<button onclick="this.textContent=\'Completed nine frames\'">Finish</button>' : `<iframe style="border:0;width:100%;height:500px" src="/f${i + 1}"></iframe>`}`);
  try {
    await p.goto(s.url('/f0'), {waitUntil: 'load'});
    const o = await observe(p, signal());
    expect(o.unsupportedFrames).toBe(false); expect(o.frames?.length).toBe(9);
    expect(o.elements.find(e => e.label === 'Finish')?.ref).toMatch(/^f\d+e\d+$/);
    const c = new JevController(p, async o => choice('CLICK', o.elements.find(e => e.label === 'Finish')!.ref));
    const r = await c.call({ action: 'run', goal: 'Finish nested frame', until: {text: ['Completed nine frames']} });
    expect(r.status).toBe('done'); expect(r.steps).toBe(1);
    expect(await p.snapshot()).toContain('Completed nine frames');
  } finally { await s.stop(); }
}));

test("iframe refs expire on navigation and native clicks respect parent overlays", () => withPage(async p => {
  const s = await startServer({ '/': '<iframe style="width:600px;height:400px" src="/a"></iframe>', '/a': '<button onclick="window.n=1">Frame action</button>', '/b': '<button>Replacement action</button>' });
  try {
    await p.goto(s.url('/'), {waitUntil: 'load'});
    const o = await observe(p, signal()), d = choice('CLICK', o.elements[0]!.ref);
    const h = await prepare(p, o, d, signal());
    await p.evaluate(() => { const cover = document.createElement('div'); cover.style.cssText='position:fixed;inset:0;background:red;z-index:999';document.body.append(cover); });
    let dispatched = 0;
    await expect(execute(p, o, d, h, undefined, signal(), () => dispatched++)).rejects.toBeInstanceOf(StaleObservation);
    expect(dispatched).toBe(0); await h?.dispose();
    const frame = p.frames().find(f => f.url().endsWith('/a'))!;
    await frame.goto(s.url('/b'));
    await expect(prepare(p, o, d, signal())).rejects.toBeInstanceOf(StaleObservation);
  } finally { await s.stop(); }
}));

test("dynamic replacement before dispatch selects a fresh ref without double clicking", () => withPage(async p => {
  await p.setContent('<button onclick="window.n=(window.n||0)+1;this.textContent=\'Complete\'">Go</button>');
  let calls = 0;
  const c = new JevController(p, async o => {
    if (++calls === 1) await p.$eval('button', e => e.replaceWith(e.cloneNode(true)));
    return choice('CLICK', o.elements[0]!.ref);
  });
  const r = await c.call({ action: 'run', goal: 'Go once', until: { text: ['Complete'] } });
  expect(r.status).toBe('done'); expect(r.steps).toBe(1); expect(r.decisions).toBe(2);
  expect(r.trace[0]?.outcome).toBe('stale');
  expect(await p.evaluate(() => (window as any).n)).toBe(1);
}));

test("stable pointer relocation tolerates SVG replacement and reads the matching tooltip", () => withPage(async p => {
  await p.setContent(`<svg width=300 height=180><rect x=30 y=30 width=60 height=100></rect><rect x=150 y=40 width=60 height=90></rect></svg><div id=tip></div>
  <script>document.querySelector('svg').onmousemove=e=>{if(e.target.tagName==='rect')document.querySelector('#tip').textContent=e.target.getAttribute('x')==='30'?'00:00 Primary : 12 Secondary : 19':'01:00 Primary : 27 Secondary : 11'};
  let i=0;const timer=setInterval(()=>{const e=document.querySelector('rect');e.replaceWith(e.cloneNode(true));if(++i===5)clearInterval(timer)},25)</script>`);
  const first = await p.interact({operation: 'hover', selector: 'rect', index: 0, count: 2, read: {selector: '#tip', includes: '00:00'}});
  const second = await p.interact({operation: 'hover', selector: 'rect', index: 1, count: 2, read: {selector: '#tip', includes: '01:00'}});
  expect(first.text).toContain('Primary : 12'); expect(second.text).toContain('Primary : 27');
  await expect(p.interact({operation: 'hover', selector:'rect', index:0, read:{selector:'#tip',includes:'WRONG TIME'},timeoutMs:300})).rejects.toThrow('Tooltip did not match');
}));

test("a stale captured Jev handle fails before the dispatch receipt", () => withPage(async p => {
  await p.setContent('<button>Go</button>');
  const o = await observe(p, signal()), d = choice('CLICK', o.elements[0]!.ref);
  const h = await prepare(p, o, d, signal());
  await p.$eval('button', e => e.replaceWith(e.cloneNode(true)));
  let dispatched = 0;
  await expect(execute(p, o, d, h, undefined, signal(), () => dispatched++)).rejects.toBeInstanceOf(StaleObservation);
  expect(dispatched).toBe(0); await h?.dispose();
}));
