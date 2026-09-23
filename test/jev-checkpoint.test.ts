import { afterAll, expect, test } from "bun:test";
import { JevController } from "../src/jev/controller.ts";
import { observe, prepare, settle } from "../src/jev/browser.ts";
import type { Decision, Operation } from "../src/jev/types.ts";
import { withPage, closeBrowser } from "./helpers/browser.ts";
import { startServer } from "./helpers/server.ts";

afterAll(closeBrowser);
const decision = (operation: Operation, target?: string): Decision => ({ operation, target, confidence: 1, latencyMs: 0, model: "fixture" });

test("a dynamic result checkpoint finishes at the last action without another paid choice", async () => withPage(async p => {
  const server = await startServer({ '/': `<button onclick="window.clicks=(window.clicks||0)+1;history.pushState({},'', '/post/1');document.querySelector('main').textContent='Jev result loaded'">Open</button><main></main><aside></aside><script>setInterval(()=>document.querySelector('aside').textContent=Date.now(),10)</script>` });
  try {
    await p.goto(server.url('/'));
    let calls = 0;
    const c = new JevController(p, async o => { calls++; return decision('CLICK', o.elements.find(e => e.label === 'Open')!.ref); });
    const r = await c.call({ action: 'run', goal: 'Open the Jev post', stepLimit: 1, until: { url: { origin: new URL(p.url()).origin, pathname: '/post/1' }, text: ['Jev result loaded'] } });
    expect(r.status).toBe('done');
    expect(r.stopReason).toBe('checkpoint_reached');
    expect(r.verified).toBe(false);
    expect(r.decisions).toBe(1);
    expect(calls).toBe(1);
    expect(r.completionEvidence?.kind).toBe('checkpoint');
    expect(r.checkpoint?.checks.every(c => c.matched)).toBe(true);
    expect(await p.$eval('main', e => e.textContent)).toBe('Jev result loaded');
    expect(await p.evaluate(() => (window as any).clicks)).toBe(1);
  } finally { await server.stop(); }
}));

test("field evidence includes every requested state and stops before toggling a correct checkbox again", async () => withPage(async p => {
  await p.setContent('<input type=checkbox aria-label=First><input type=checkbox aria-label=Second checked>');
  const c = new JevController(p, async o => {
    const target = o.elements.find(e => e.label === 'First' && !e.checked) || o.elements.find(e => e.label === 'Second' && e.checked);
    if (!target) throw Error('An unnecessary extra decision was requested');
    return decision('CLICK', target.ref);
  });
  const r = await c.call({ action: 'run', goal: 'Check First, uncheck Second', until: { fields: [{ label: 'First', checked: true }, { label: 'Second', checked: false }] } });
  expect(r.stopReason).toBe('checkpoint_reached');
  expect(r.decisions).toBe(2);
  expect(await p.$$eval('input', es => es.map(e => e.checked))).toEqual([true, false]);
}));

test("premature DONE returns unmet checks and a runtime handoff instead of falsely succeeding", async () => withPage(async p => {
  await p.setContent('<h1>Loading results shortly</h1>');
  const c = new JevController(p, async () => decision('DONE'));
  const r = await c.call({ action: 'run', goal: 'Read the ready result', until: { text: ['Verified result'] } });
  expect(r.status).toBe('needs_host');
  expect(r.checkpoint?.matched).toBe(false);
  expect(r.handoff).toMatchObject({ source: 'runtime', next: 'inspect_page', resume: { action: 'resume', sessionId: r.sessionId, requestId: r.requestId } });
  await p.$eval('h1', e => e.textContent = 'Verified result');
  const done = await c.call(r.handoff!.resume);
  expect(done.stopReason).toBe('checkpoint_reached');
  expect(done.decisions).toBe(1);
  expect(done.handoff).toBeUndefined();
}));

test("already satisfied checkpoints do not call Jev, but pending prepared replacements prevent early exit", async () => withPage(async p => {
  const server = await startServer({ '/': '<input aria-label=Name value=Old><h1>Profile</h1>' });
  try {
    await p.goto(server.url('/'));
    let calls = 0;
    const c = new JevController(p, async o => { calls++; return decision('TYPE_TEXT', o.elements[0]!.ref); });
    const r = await c.call({ action: 'run', goal: 'Use the new name', until: { text: ['Profile'] }, inputs: [{ url: p.url(), label: 'Name', text: 'New' }] });
    expect(r.status).toBe('done');
    expect(calls).toBe(1);
    expect(await p.$eval('input', e => e.value)).toBe('New');
    const again = await c.call({ action: 'run', goal: 'Verify profile', until: { fields: [{ label: 'Name', value: 'New' }] } });
    expect(again.decisions).toBe(0);
    expect(calls).toBe(1);
  } finally { await server.stop(); }
}));

test("model reasoning handoff survives unrelated animations and includes a native-host continuation", async () => withPage(async p => {
  await p.setContent('<main>Compare these options</main><aside>tick</aside>');
  const c = new JevController(p, async () => {
    await p.$eval('aside', e => e.textContent = 'changed during prediction');
    return { ...decision('HANDOFF'), handoffReason: 'reasoning' };
  });
  const r = await c.call({ action: 'run', goal: 'Compare the options' });
  expect(r.status).toBe('needs_host');
  expect(r.decisions).toBe(1);
  expect(r.handoff).toMatchObject({ source: 'model', next: 'inspect_page' });
  expect(r.page?.text).toContain('changed during prediction');
  expect(r.trace[0]?.outcome).toBe('handoff');
}));

test("terminal stale diagnostics identify changed semantic fields without leaking their contents", async () => withPage(async p => {
  await p.setContent('<h1>Old result</h1>');
  const signal = new AbortController().signal;
  const before = await observe(p, signal);
  await p.$eval('h1', e => e.textContent = 'PRIVATE_NEW_CONTENT');
  try { await prepare(p, before, decision('DONE'), signal); throw Error('Expected stale state'); }
  catch (error) {
    expect(String(error)).toContain('observation fields:');
    expect(String(error)).toContain('text');
    expect(String(error)).not.toContain('PRIVATE_NEW_CONTENT');
  }
}));

test("autocomplete waits for the relevant option content to settle while ignoring an animated sidebar", async () => withPage(async p => {
  await p.setContent('<input role=combobox aria-label=Search aria-controls=picker><div id=picker role=listbox></div><aside></aside>');
  await p.focus('input');
  const signal = new AbortController().signal;
  const before = await observe(p, signal);
  await p.evaluate(() => {
    setTimeout(() => document.querySelector('#picker')!.innerHTML = '<div role=option>Old option</div>', 180);
    setTimeout(() => document.querySelector('#picker')!.innerHTML = '<div role=option>Final option</div>', 270);
    (window as any).ticker = setInterval(() => document.querySelector('aside')!.textContent = String(Date.now()), 10);
  });
  await settle(p, before, decision('TYPE_TEXT', before.elements[0]!.ref), signal);
  expect(await p.$eval('[role=option]', e => e.textContent)).toBe('Final option');
  await p.evaluate(() => clearInterval((window as any).ticker));
}));

test("compact host results retain decisions and continuation data; full diagnostic status does not run another decision", async () => withPage(async p => {
  await p.setContent('<input aria-label=Name>');
  let calls = 0;
  const c = new JevController(p, async o => {
    calls++;
    return { ...decision('TYPE_TEXT', o.elements[0]!.ref), probabilities: { TYPE_TEXT: 1 }, targetProbabilities: { [o.elements[0]!.ref]: 1 } };
  });
  const r = await c.call({ action: 'run', goal: 'Fill Name' });
  expect(r.handoff).toMatchObject({ source: 'text', next: 'supply_text' });
  expect(r.trace[0]?.probabilities).toBeUndefined();
  const full = await c.call({ action: 'status', sessionId: r.sessionId, diagnostics: 'full' });
  expect(full.trace[0]?.probabilities).toEqual({ TYPE_TEXT: 1 });
  expect(full.requestId).toBe(r.requestId);
  expect(full.field?.label).toBe('Name');
  expect(calls).toBe(1);
  expect(full.startedAt).toBe(r.startedAt);
}));
