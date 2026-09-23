/** Offline matched runtime benchmark. Fake choices only: never calls a paid API. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JevController } from "../src/jev/controller.ts";
import { withPage, closeBrowser } from "../test/helpers/browser.ts";
import type { Decision, Observation, JevResult } from "../src/jev/types.ts";

const baseline = process.argv[2];
if (!baseline) throw new Error("Usage: bun scripts/bench-jev.ts <frozen-source-directory> [output.json]");
const Before = (await import(pathToFileURL(resolve(baseline, "src/jev/controller.ts")).href)).JevController as typeof JevController;
const output = process.argv[3] ?? "tmp/jev-runtime-comparison.json";
const fixture = '<title>0</title><main><h1>Local navigation fixture</h1><p>Advance through twelve states.</p><button onclick="document.title=String(Number(document.title)+1);document.querySelector(\'output\').textContent=document.title">Next</button><output>0</output></main>';
const policy = async (o: Observation): Promise<Decision> => ({
  operation: o.title === "12" ? "DONE" : "CLICK",
  target: o.title === "12" ? undefined : o.elements.find(e => e.label === "Next")!.ref,
  confidence: 1, latencyMs: 0, model: "offline-fixture-no-api",
});
const rows: Array<Record<string, unknown>> = [];
async function run(label: string, Controller: typeof JevController, pair: number) {
  return withPage(async p => {
    await p.setContent(fixture);
    const client = (p as unknown as { _client(): { send: (...args: any[]) => Promise<any> } })._client();
    const original = client.send;
    const methods: Record<string, number> = {};
    client.send = function(method: string, ...args: any[]) {
      methods[method] = (methods[method] ?? 0) + 1;
      return original.call(this, method, ...args);
    };
    const c = new Controller(p, policy);
    const start = performance.now();
    let calls = 1, r: JevResult;
    try {
      r = await c.call({ action: "run", goal: "Advance twelve states", stepLimit: 20 });
      while (r.status === "paused" && calls < 10) {
        calls++;
        r = await c.call({ action: "resume", sessionId: r.sessionId, requestId: r.requestId! });
      }
    } finally { client.send = original; }
    const runtimeMs = performance.now() - start;
    const actual = await p.$eval("output", e => e.textContent);
    const verified = r.status === "done" && actual === "12" && r.steps === 12;
    const row = { pair, arm: label, verified, runtimeMs: Math.round(runtimeMs), activeMs: r.elapsedMs,
      hostCalls: calls, decisions: r.decisions, actions: r.steps, protocolCalls: Object.values(methods).reduce((a,b) => a+b,0), methods,
      timing: r.timing, trace: r.trace };
    rows.push(row);
    console.log(JSON.stringify({ pair, arm: label, verified, runtimeMs: row.runtimeMs, hostCalls: calls, protocolCalls: row.protocolCalls }));
    if (!verified) throw new Error(`${label} failed independent verification`);
  });
}
try {
  for (let pair = 1; pair <= 3; pair++) {
    const arms = pair % 2 ? [["before", Before], ["after", JevController]] as const : [["after", JevController], ["before", Before]] as const;
    for (const [label, Controller] of arms) await run(label, Controller, pair);
  }
  const median = (xs: number[]) => xs.sort((a,b) => a-b)[Math.floor(xs.length/2)]!;
  const summary = Object.fromEntries(["before", "after"].map(arm => {
    const group = rows.filter(r => r.arm === arm);
    return [arm, Object.fromEntries(["runtimeMs", "hostCalls", "protocolCalls"].map(key => [key, median(group.map(r => r[key] as number))]))];
  }));
  const result = { kind: "offline-runtime-comparison", date: new Date().toISOString(), model: "deterministic fixture, no API", initialNavigationIncluded: false,
    hostThinkTimeIncluded: false, finalVerificationIncluded: false, repeatsPerArm: 3, summary, rows };
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ output: resolve(output), summary }));
} finally { await closeBrowser(); }
