/** Matched search workflow, same known text and verification in both arms.
 * JEV_LIVE_TEST=1 uses real Jev; otherwise a clearly labelled 250ms fake policy.
 * Never points at a user's Chrome profile or sends a public message. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { JevController } from "../src/jev/controller.ts";
import { createChooser } from "../src/jev/model.ts";
import { jevConfigFromEnv } from "../src/shared/jev.ts";
import { withPage, closeBrowser } from "../test/helpers/browser.ts";
import { startServer } from "../test/helpers/server.ts";
import type { Choose } from "../src/jev/model.ts";

const baseline = process.argv[2];
if (!baseline) throw Error('Usage: bun scripts/bench-jev-checkpoints.ts <frozen-source-directory> [output.json]');
const Before = (await import(pathToFileURL(resolve(baseline, 'src/jev/controller.ts')).href)).JevController;
const beforeChooser = (await import(pathToFileURL(resolve(baseline, 'src/jev/model.ts')).href)).createChooser as typeof createChooser;
const live = process.env.JEV_LIVE_TEST === '1';
const output = resolve(process.argv[3] ?? 'tmp/jev-checkpoint-comparison.json');
const srv = await startServer({
  '/search': `<title>Demo search</title><main><h1>Search Jev demos</h1>
    <input role=combobox aria-label="Search" aria-controls="picker" oninput="clearTimeout(window.a);clearTimeout(window.b);document.querySelector('#picker').innerHTML='';window.a=setTimeout(()=>document.querySelector('#picker').innerHTML='<button role=option onclick=search()>Search for '+this.value+'</button>',80);window.b=setTimeout(()=>document.querySelector('#picker button').textContent='Search for '+this.value+' — updated results',260)">
    <div id=picker role=listbox></div><section></section></main><script>
    window.search=()=>{window.searches=(window.searches||0)+1;document.querySelector('#picker').innerHTML='';document.querySelector('section').innerHTML='<a href=/post/1>Open Jev browser demo</a>';};
    </script>`,
  '/post/1': '<title>Jev demo</title><main><h1>Jev browser demo</h1><p>Ready for review: a concrete browser automation example.</p><aside>Video 0</aside></main><script>setInterval(()=>document.querySelector("aside").textContent="Video "+Date.now(),25)</script>',
});
const goal = 'Search for Jev using the prepared Search text. Click the matching search suggestion, then open the Jev browser demo link. Finish on the post detail page once Ready for review is visible. Do not start another search.';
const fake: Choose = async o => {
  await new Promise(resolve => setTimeout(resolve, 250));
  const field = o.elements.find(e => e.label === 'Search' && !e.value);
  const link = o.elements.find(e => e.label === 'Open Jev browser demo');
  const option = o.elements.find(e => e.role === 'option');
  return { operation: field ? 'TYPE_TEXT' : link || option ? 'CLICK' : o.url.includes('/post/') ? 'DONE' : 'WAIT', target: (field || link || option)?.ref,
    confidence: 1, latencyMs: 250, model: 'simulated-250ms-policy' };
};
const rows: any[] = [];
async function run(arm: 'before' | 'after', pair: number) {
  await withPage(async p => {
    await p.goto(srv.url('/search'));
    const config = jevConfigFromEnv();
    let policyCalls = 0;
    const policy = live ? (arm === 'before' ? beforeChooser : createChooser)(config) : fake;
    const c = new (arm === 'before' ? Before : JevController)(p, async (...args: Parameters<Choose>) => { policyCalls++; return policy(...args); });
    const start = performance.now();
    const result = await c.call({ action: 'run', goal, stepLimit: 12, inputs: [{ url: p.url(), label: 'Search', text: 'Jev' }],
      ...(arm === 'after' ? { until: { url: { origin: new URL(p.url()).origin, pathname: '/post/1' }, text: ['Ready for review'] } } : {}),
    });
    const elapsedMs = Math.round(performance.now() - start);
    const actual = { url: p.url(), heading: await p.$eval('h1', e => e.textContent), text: await p.$eval('main', e => e.textContent) };
    const verified = actual.url === srv.url('/post/1') && actual.heading === 'Jev browser demo' && actual.text?.includes('Ready for review');
    const row = { arm, pair, verified, autonomousDone: result.status === 'done', elapsedMs, policyCalls,
      stale: result.trace.filter((t: any) => t.outcome === 'stale').length, result, actual };
    rows.push(row);
    console.log(JSON.stringify({ arm, pair, verified, autonomousDone: row.autonomousDone, elapsedMs, policyCalls, stale: row.stale }));
    if (['needs_text', 'needs_host', 'paused'].includes(result.status)) await c.call({ action: 'stop', sessionId: result.sessionId });
  });
}
try {
  for (let pair = 1; pair <= 3; pair++) for (const arm of (pair % 2 ? ['before', 'after'] : ['after', 'before']) as Array<'before' | 'after'>) await run(arm, pair);
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(['before', 'after'].map(arm => {
    const group = rows.filter(r => r.arm === arm);
    return [arm, { verified: group.filter(r => r.verified).length, autonomousDone: group.filter(r => r.autonomousDone).length, runs: group.length,
      medianMs: median(group.map(r => r.elapsedMs)), medianCalls: median(group.map(r => r.policyCalls)), stale: group.reduce((n, r) => n + r.stale, 0) }];
  }));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ date: new Date().toISOString(), live, modelMode: live ? 'real TypeSafe API' : 'simulated 250ms decisions, NOT a live API speed measurement',
    boundaries: 'Three alternating pairs on an owned local dynamic-search fixture. Same goal and prepared input. After uses a host-authored checkpoint. Initial navigation and independent DOM verification excluded. A verified result with needs_host is not autonomous completion. No simulated host thinking time.', summary, rows }, null, 2));
  console.log(JSON.stringify({ output, summary }));
  if (rows.some(r => !r.verified) || rows.filter(r => r.arm === 'after').some(r => !r.autonomousDone)) process.exitCode = 1;
} finally { await closeBrowser(); await srv.stop(); }
