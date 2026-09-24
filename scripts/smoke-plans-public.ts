/** Opt-in compatibility checks on Selenium's public browser test pages.
 * JEV_PUBLIC_TEST=1 bun run scripts/smoke-plans-public.ts [output.json]
 * Labels/options were inspected on these pages. No private browser or login. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { closeBrowser, withPage } from "../test/helpers/browser.ts";
import { JevController } from "../src/jev/controller.ts";
import type { BrowserPlan } from "../src/jev/plan-types.ts";

if (process.env.JEV_PUBLIC_TEST !== "1") throw Error("Set JEV_PUBLIC_TEST=1 to visit Selenium's public test pages");
const origin = "https://www.selenium.dev";
const output = resolve(process.argv[2] ?? "tmp/jev-plan-public.json");
const rows: any[] = [];
const cases: Array<{ path: string; plan: BrowserPlan }> = [
  { path: "/selenium/web/web-form.html", plan: {
    origins: [origin],
    targets: { text: { label: "Text input" }, area: { label: "Textarea" },
      select: { label: "Dropdown (select)" }, check: { label: "Default checkbox" } },
    stages: [
      { id: "text", goal: "Fill Text input", action: { operation: "TYPE_TEXT", target: "text", text: "Jev plan smoke" } },
      { id: "area", goal: "Fill multiline text", action: { operation: "TYPE_TEXT", target: "area", text: "First line\n第二行" } },
      { id: "select", goal: "Choose Two", action: { operation: "SELECT", target: "select", option: { label: "Two" } } },
      { id: "check", goal: "Enable Default checkbox", action: { operation: "CLICK", target: "check", checked: true } },
      { id: "verify", goal: "Check all requested fields", wait: true, until: { fields: [
        { label: "Text input", value: "Jev plan smoke" }, { label: "Textarea", value: "First line\n第二行" },
        { label: "Dropdown (select)", value: "2" }, { label: "Default checkbox", checked: true },
      ] } },
    ],
  } },
  { path: "/selenium/web/dynamic.html", plan: {
    origins: [origin],
    targets: { reveal: { label: "Reveal a new input" }, field: { label: "textbox", role: "textbox" } },
    stages: [
      { id: "reveal", goal: "Reveal the input and wait for it", action: { operation: "CLICK", target: "reveal" },
        until: { fields: [{ label: "textbox", role: "textbox", value: "" }] } },
      { id: "fill", goal: "Fill the newly revealed input", action: { operation: "TYPE_TEXT", target: "field", text: "Ready" } },
    ],
  } },
];
try {
  for (const task of cases) await withPage(async p => {
    await p.goto(origin + task.path);
    const c = new JevController(p, async () => { throw Error("Grounded public test unexpectedly needed a model"); });
    const result = await c.call({ action: "run", goal: "Execute the inspected public-page test", plan: task.plan });
    const actual = await p.evaluate(() => Array.from(document.querySelectorAll("input,textarea,select")).map(el => {
      const e = el as HTMLInputElement;
      const label = e.labels?.[0];
      return { label: label ? Array.from(label.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(" ").trim() : "",
        value: e.value, checked: e.checked, type: e.type, visible: e.checkVisibility() };
    }));
    const verified = task.path.endsWith("/dynamic.html")
      ? actual.some(e => e.type === "text" && e.visible && e.value === "Ready")
      : actual.some(e => e.label === "Text input" && e.value === "Jev plan smoke") &&
        actual.some(e => e.label === "Textarea" && e.value === "First line\n第二行") &&
        actual.some(e => e.label === "Dropdown (select)" && e.value === "2") &&
        actual.some(e => e.label === "Default checkbox" && e.checked) &&
        actual.filter(e => e.type === "password" || e.type === "file").every(e => e.value === "");
    rows.push({ url: p.url(), verified, result, actual });
    console.log(JSON.stringify({ url: p.url(), verified, status: result.status, steps: result.steps, decisions: result.decisions, wallMs: result.timing.wallMs }));
  });
} finally {
  await closeBrowser();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
}
if (rows.length !== cases.length || rows.some(r => !r.verified || r.result.status !== "done")) process.exitCode = 1;
