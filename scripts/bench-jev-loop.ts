/** Matched before/after loop test. Opt into real TypeSafe calls with JEV_LIVE_TEST=1.
 * Local fixture only; no accounts or public submissions. No simulated host delay. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JevController } from "../src/jev/controller.ts";
import { buildRequest, createChooser } from "../src/jev/model.ts";
import { jevConfigFromEnv } from "../src/shared/jev.ts";
import { withPage, closeBrowser } from "../test/helpers/browser.ts";
import { startServer } from "../test/helpers/server.ts";
import type { Choose } from "../src/jev/model.ts";
import type { JevResult } from "../src/jev/types.ts";

const baseline = process.argv[2];
if (!baseline) throw new Error("Usage: bun scripts/bench-jev-loop.ts <frozen-source-directory> [output.json]");
const Before = (await import(pathToFileURL(resolve(baseline, "src/jev/controller.ts")).href)).JevController as typeof JevController;
const beforeModel = await import(pathToFileURL(resolve(baseline, "src/jev/model.ts")).href) as { buildRequest: typeof buildRequest; createChooser: typeof createChooser };
const live = process.env.JEV_LIVE_TEST === "1";
const output = process.argv[3] ?? "tmp/jev-loop-comparison.json";
const goal = "Find one-way flights from Zurich to London. Fill From with Zurich and To with London, set Trip to One way, then click Search once. Finish only after matching flight options are visible.";
const fixture = `<title>Flight search</title><main><h1>Search flights</h1><form onsubmit="event.preventDefault();window.submits=(window.submits||0)+1;document.querySelector('output').textContent='Results: '+this.from.value+' to '+this.to.value+' ('+this.trip.value+')'">
<label>From <input name=from></label><label>To <input name=to></label>
<label>Trip <select name=trip><option>Round trip</option><option>One way</option></select></label>
<button>Search</button></form><output role=status></output>
<section>${Array.from({ length: 180 }, (_, i) => `<article><h2>Travel guide ${i}</h2><div><p>Explore the route, local sights and travel details.</p><a href="#guide-${i}">Read guide ${i}</a></div></article>`).join("")}</section></main>`;
const known: Record<string, string> = { From: "Zurich", To: "London" };
const config = jevConfigFromEnv();
const srv = await startServer({ "/flights": fixture });
const rows: Array<Record<string, any>> = [];

const deterministic: Choose = async o => {
  let operation: any = "CLICK", target = o.elements.find(e => e.label === "Search")?.ref;
  const empty = o.elements.find(e => Object.hasOwn(known, e.label) && e.value !== known[e.label]);
  const trip = o.elements.find(e => e.label === "Trip")!;
  if (empty) { operation = "TYPE_TEXT"; target = empty.ref; }
  else if (trip.value !== "One way") { operation = "SELECT"; target = trip.ref + ":1"; }
  return { operation, target, model: "offline-fixture", confidence: 1, latencyMs: 0 };
};
async function run(arm: "before" | "after", pair: number) {
  await withPage(async p => {
    await p.goto(srv.url("/flights"));
    const model = arm === "before" ? beforeModel : { buildRequest, createChooser };
    const policy = live ? model.createChooser(config) : deterministic;
    const requests: Array<{ bytes: number; candidates: number; latencyMs: number }> = [];
    const choose: Choose = async (...args) => {
      const decision = await policy(...args);
      requests.push({ bytes: Buffer.byteLength(JSON.stringify(model.buildRequest(args[0], args[1], args[2], config.model))), candidates: args[0].elements.length, latencyMs: decision.latencyMs });
      return decision;
    };
    const Controller = arm === "before" ? Before : JevController;
    const c = new Controller(p, choose);
    const start = performance.now();
    let calls = 1, handoffs = 0;
    let r: JevResult = await c.call({ action: "run", goal, stepLimit: 14,
      completion: { submitLabel: "Search", successText: "Results: Zurich to London (One way)" },
      ...(arm === "after" ? { inputs: Object.entries(known).map(([label, text]) => ({ url: p.url(), label, text })) } : {}),
    });
    while (calls < 10 && (r.status === "needs_text" || (r.status === "paused" && r.stopReason === "stale_page"))) {
      const text = r.status === "needs_text" ? known[r.field?.label ?? ""] : undefined;
      if (r.status === "needs_text" && (text === undefined || r.page?.url !== srv.url("/flights"))) break;
      calls++; if (text !== undefined) handoffs++;
      r = await c.call({ action: "resume", sessionId: r.sessionId, requestId: r.requestId!, ...(text === undefined ? {} : { text }) });
    }
    const runtimeMs = Math.round(performance.now() - start);
    const actual = await p.evaluate(() => ({ from: (document.querySelector('[name=from]') as HTMLInputElement).value,
      to: (document.querySelector('[name=to]') as HTMLInputElement).value, trip: (document.querySelector('select') as HTMLSelectElement).value,
      result: document.querySelector('output')?.textContent, submits: (window as any).submits }));
    const verified = r.status === "done" && actual.from === "Zurich" && actual.to === "London" && actual.trip === "One way" && actual.submits === 1;
    const row = { pair, arm, verified, runtimeMs, hostCalls: calls, textHandoffs: handoffs,
      requestBytes: requests.reduce((n, r) => n + r.bytes, 0), requests, result: r, actual };
    rows.push(row);
    console.log(JSON.stringify({ pair, arm, verified, runtimeMs, hostCalls: calls, textHandoffs: handoffs, decisions: r.decisions, requestBytes: row.requestBytes }));
  });
}
try {
  for (let pair = 1; pair <= 3; pair++) for (const arm of (pair % 2 ? ["before", "after"] : ["after", "before"]) as Array<"before" | "after">) await run(arm, pair);
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const summary = Object.fromEntries(["before", "after"].map(arm => {
    const group = rows.filter(r => r.arm === arm);
    return [arm, { passed: group.filter(r => r.verified).length, runs: group.length,
      ...Object.fromEntries(["runtimeMs", "hostCalls", "textHandoffs", "requestBytes"].map(k => [k, median(group.map(r => r[k]))])) }];
  }));
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify({ date: new Date().toISOString(), live, task: goal, summary, rows,
    boundaries: "Initial navigation and independent verification excluded; no simulated host think time. Both arms supply the same known field strings. Three alternating pairs; local fixture, not a general web benchmark." }, null, 2));
  console.log(JSON.stringify({ output: resolve(output), summary }));
  if (rows.some(r => !r.verified)) process.exitCode = 1;
} finally { await closeBrowser(); await srv.stop(); }
