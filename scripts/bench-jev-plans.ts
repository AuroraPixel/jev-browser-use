/** Alternating runtime comparison. Default is a simulated 250 ms chooser,
 * explicitly NOT a model benchmark. JEV_LIVE_TEST=1 opts in to real Jev.
 * All pages, forms and effects belong to this isolated local fixture. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { JevController } from "../src/jev/controller.ts";
import type { BrowserPlan } from "../src/jev/plan-types.ts";
import type { Choose } from "../src/jev/model.ts";
import { closeBrowser, withPage } from "../test/helpers/browser.ts";
import { startServer } from "../test/helpers/server.ts";

const live = process.env.JEV_LIVE_TEST === "1";
if (live && !process.env.TYPESAFE_API_KEY) throw Error("Live benchmarking requires a configured TYPESAFE_API_KEY");
const output = resolve(process.argv[2] ?? "tmp/jev-plan-benchmark.json");
const repeats = Number(process.env.JEV_BENCH_REPEATS ?? 3);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw Error("JEV_BENCH_REPEATS must be 1..10");
const variants = [
  { label: "Display name", tier: "Account tier", toggle: "Email updates", button: "Save profile", layout: "form" },
  { label: "Project title", tier: "Service level", toggle: "Track changes", button: "Apply changes", layout: "section" },
  { label: "Public alias", tier: "Membership", toggle: "Notifications", button: "Confirm settings", layout: "article" },
];
const fixture = (v: typeof variants[number]) => '<!doctype html><title>Profile editor</title><h1>Settings</h1><' + v.layout + '>' +
  '<label>Internal note <input id=other></label><label>' + v.label + '<input id=name></label>' +
  '<label>' + v.tier + '<select id=tier><option value=basic>Basic</option><option value=pro>Pro</option></select></label>' +
  '<label><input id=toggle type=checkbox>' + v.toggle + '</label>' +
  '<button type=button onclick="window.submits=(window.submits||0)+1;this.disabled=true;document.querySelector(\'output\').textContent=\'Saving\';document.querySelector(\'output\').setAttribute(\'aria-busy\',\'true\');setTimeout(()=>{document.querySelector(\'output\').textContent=\'Saved \'+document.querySelector(\'#name\').value;document.querySelector(\'output\').setAttribute(\'aria-busy\',\'false\');this.disabled=false},120)">' +
  v.button + '</button></' + v.layout + '><output role=status></output><aside></aside>' +
  '<script>setInterval(()=>document.querySelector("aside").textContent="Clock "+Date.now(),20)</script>';
const routes = Object.fromEntries(variants.map((v, i) => ["/" + i, fixture(v)]));
const server = await startServer(routes);
const rows: any[] = [];
const fake: Choose = async o => {
  await new Promise(r => setTimeout(r, 250));
  const text = o.elements.find(e => e.operations.includes("TYPE_TEXT") && e.label !== "Internal note");
  const select = o.elements.find(e => e.operations.includes("SELECT") && e.value !== "pro");
  const toggle = o.elements.find(e => e.role === "checkbox" && !e.checked);
  const save = o.elements.find(e => e.role === "button");
  const field = text || select || toggle || save;
  return { operation: text ? "TYPE_TEXT" : select ? "SELECT" : toggle || save ? "CLICK" : "DONE",
    target: select && !text ? select.ref + ":" + select.options!.find(x => x.value === "pro")!.index : field?.ref,
    confidence: 1, targetConfidence: 1, latencyMs: 250, model: "simulated-250ms-policy" };
};
async function run(pair: number, variant: number, arm: "jev-loop" | "plan") {
  await withPage(async p => {
    const v = variants[variant]!, url = server.url("/" + variant);
    await p.goto(url);
    const c = new JevController(p, live ? undefined : fake);
    for (const temperature of ["cold", "warm"] as const) {
      await p.evaluate(() => {
        (document.querySelector("#name") as HTMLInputElement).value = "";
        (document.querySelector("#tier") as HTMLSelectElement).selectedIndex = 0;
        (document.querySelector("#toggle") as HTMLInputElement).checked = false;
        document.querySelector("output")!.textContent = "";
        (window as any).submits = 0;
      });
      const text = temperature === "cold" ? "Ada" : "Grace";
      const goal = "Set " + v.label + " to " + text + ", choose Pro in " + v.tier + ", enable " + v.toggle +
        ", then click " + v.button + " once and wait for Saved " + text + ". Leave Internal note empty.";
      const until = { text: ["Saved " + text], fields: [
        { label: v.label, value: text }, { label: v.tier, value: "pro" }, { label: v.toggle, checked: true },
      ] };
      const plan: BrowserPlan = {
        origins: [new URL(url).origin],
        targets: {
          name: { description: "The field labeled " + v.label + " for the public identity, not Internal note", role: "textbox", reuse: true },
          tier: { label: v.tier }, toggle: { label: v.toggle }, save: { label: v.button, role: "button" },
        },
        stages: [
          { id: "name", goal: "Fill the public identity field", action: { operation: "TYPE_TEXT", target: "name", text } },
          { id: "tier", goal: "Choose Pro", action: { operation: "SELECT", target: "tier", option: { label: "Pro" } } },
          { id: "toggle", goal: "Enable the option", action: { operation: "CLICK", target: "toggle", checked: true } },
          { id: "save", goal: "Save once and check all fields", action: { operation: "CLICK", target: "save" }, until },
        ],
      };
      const started = performance.now();
      const result = await c.call({ action: "run", goal, stepLimit: 12,
        ...(arm === "plan" ? { plan } : { until, inputs: [{ url, label: v.label, text }] }),
      });
      const wallMs = Math.round(performance.now() - started);
      const actual = await p.evaluate(() => ({
        name: (document.querySelector("#name") as HTMLInputElement).value,
        note: (document.querySelector("#other") as HTMLInputElement).value,
        tier: (document.querySelector("#tier") as HTMLSelectElement).selectedIndex,
        toggle: (document.querySelector("#toggle") as HTMLInputElement).checked,
        result: document.querySelector("output")!.textContent, submits: (window as any).submits,
      }));
      const verified = actual.name === text && actual.note === "" && actual.tier === 1 && actual.toggle &&
        actual.result === "Saved " + text && actual.submits === 1;
      const row = { pair, variant, arm, temperature, wallMs, verified, autonomous: result.status === "done",
        decisions: result.decisions, apiAttempts: result.requests.length, timing: result.timing, progress: result.plan, actual, result };
      rows.push(row);
      console.log(JSON.stringify({ pair, variant, arm, temperature, wallMs, verified, status: result.status, decisions: result.decisions }));
      if (["needs_text", "needs_host", "paused"].includes(result.status)) await c.call({ action: "stop", sessionId: result.sessionId });
    }
  });
}
try {
  for (let pair = 1; pair <= repeats; pair++) for (let v = 0; v < variants.length; v++) {
    for (const arm of (pair % 2 ? ["jev-loop", "plan"] : ["plan", "jev-loop"]) as Array<"jev-loop" | "plan">) await run(pair, v, arm);
  }
} finally {
  await closeBrowser();
  await server.stop();
  const quantile = (ns: number[], q: number) => ns.sort((a, b) => a - b)[Math.min(ns.length - 1, Math.ceil(ns.length * q) - 1)];
  const summary = Object.fromEntries(["jev-loop:cold", "jev-loop:warm", "plan:cold", "plan:warm"].map(key => {
    const group = rows.filter(r => r.arm + ":" + r.temperature === key);
    return [key, { runs: group.length, verified: group.filter(r => r.verified).length,
      autonomous: group.filter(r => r.autonomous).length, medianMs: quantile(group.map(r => r.wallMs), 0.5),
      p95Ms: quantile(group.map(r => r.wallMs), 0.95), decisions: group.reduce((n, r) => n + r.decisions, 0),
      apiAttempts: group.reduce((n, r) => n + r.apiAttempts, 0) }];
  }));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), live, repeats,
    mode: live ? "real Jev API" : "simulated 250 ms policy, NOT measured Jev performance",
    boundaries: "Three owned HTML layouts, alternating arms, same Chrome and independently checked results. Every attempt retained. Both arms get the same task facts; plan cold dynamically binds the identity field, warm reuses that verified same-document binding. Initial navigation/reset and independent post-run verification excluded; native host plan-compilation time is NOT measured. No public accounts or messages.",
    summary, rows }, null, 2));
  console.log(JSON.stringify({ output, summary }));
}
if (!rows.length || rows.some(r => !r.verified || !r.autonomous)) process.exitCode = 1;
