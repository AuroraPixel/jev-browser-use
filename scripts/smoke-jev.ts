/** Opt-in paid integration smoke. Never imported by the ordinary test suite. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { JevResult } from "../src/jev/types.ts";

if (process.env.JEV_LIVE_TEST !== "1" || !process.env.TYPESAFE_API_KEY) {
  console.error("Opt-in required: JEV_LIVE_TEST=1 and TYPESAFE_API_KEY (optional TYPESAFE_PROXY)");
  process.exit(2);
}
const binary = resolve(import.meta.dir, "../dist/jev-browser-use");
if (!await Bun.file(binary).exists()) throw new Error("Run bun run build first");
const home = mkdtempSync(join(tmpdir(), "jev-browser-use-jev-live-"));
const env = { ...process.env, JEV_BROWSER_USE_HOME: home } as Record<string, string>;
delete env.NODE_PATH;
const noKey = { ...env };
delete noKey.TYPESAFE_API_KEY;
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch() { return new Response(`<!doctype html><title>Jev integration fixture</title><h1>Profile editor</h1>
    <label>Name <input id=name required></label>
    <label>Plan <select id=plan><option value=basic>Basic</option><option value=pro>Pro</option></select></label>
    <button onclick="window.submits=(window.submits||0)+1;document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value+' ('+document.querySelector('#plan').selectedOptions[0].text+')'">Save</button>
    <p id=result role=status>Nothing saved</p>`, { headers: { "Content-Type": "text/html" } }); },
});
const goal = "Enter Luna in Name, select the Pro plan, click Save, and confirm that Saved Luna (Pro) is visible.";
async function cli(args: string[], key = true): Promise<any> {
  const proc = Bun.spawn([binary, "--headless", "--quiet-page", "--json", "-t", "60", ...args], { env: key ? env : noKey, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 70000);
  const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`Live CLI exited ${code}`);
  const frames = out.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const error = frames.find(f => f.type === "error");
  if (error) throw new Error(`Live CLI ${error.name}`);
  return frames.find(f => f.type === "result")?.data;
}
const setup = (name: string) => `const p = await browser.getPage(${JSON.stringify(name)}); await p.goto(${JSON.stringify(`http://127.0.0.1:${server.port}/`)}); await p.title()`;
const check = (name: string) => `const p = await browser.getPage(${JSON.stringify(name)}); await p.evaluate(() => ({name: document.querySelector('#name').value, plan: document.querySelector('#plan').value, result: document.querySelector('#result').textContent, submits: window.submits}))`;
async function exercise(label: string, invoke: (args: object) => Promise<JevResult>, verify: () => Promise<any>, provided = false) {
  let hostCalls = 1;
  let r = await invoke({ page: label, action: "run", goal, stepLimit: 10, completion: { submitLabel: "Save", successText: "Saved Luna (Pro)" },
    ...(provided ? { inputs: [{ url: `http://127.0.0.1:${server.port}/`, label: "Name", text: "Luna" }] } : {}) });
  let textHandoffs = 0;
  let last: object | undefined;
  for (let i = 0; i < 6 && (r.status === "needs_text" || r.status === "paused"); i++) {
    last = { page: label, action: "resume", sessionId: r.sessionId, requestId: r.requestId };
    if (r.status === "needs_text") {
      if (!r.field?.label.includes("Name")) throw new Error(`${label}: unexpected text field`);
      // Host-side text derived from this fixture's explicit goal; no text-model call.
      last = { ...last, text: "Luna" };
      textHandoffs++;
    }
    hostCalls++;
    r = await invoke(last);
  }
  if (r.status !== "done" || r.stopReason !== "submission_confirmed" || r.verified !== false ||
      (provided ? textHandoffs !== 0 || hostCalls !== 1 : !textHandoffs)) throw new Error(`${label}: unexpected outcome ${r.status}`);
  if (last) {
    const replay = await invoke(last);
    if (JSON.stringify(replay) !== JSON.stringify(r)) throw new Error(`${label}: resume replay changed the recorded result`);
  }
  const actual = await verify();
  if (actual.name !== "Luna" || actual.plan !== "pro" || actual.result !== "Saved Luna (Pro)" || actual.submits !== 1) throw new Error(`${label}: independent DOM verification failed`);
  if (r.requests.length < r.decisions || !Number.isFinite(Date.parse(r.startedAt)) || !Number.isFinite(Date.parse(r.returnedAt))) throw new Error(`${label}: missing real request telemetry`);
  console.log(JSON.stringify({ transport: label, passed: true, provided, hostCalls, steps: r.steps, decisions: r.decisions, requests: r.requests, textHandoffs, elapsedMs: r.elapsedMs, timing: r.timing, trace: r.trace, stopReason: r.stopReason, submissions: actual.submits, independentVerification: true }));
}
async function exerciseCheckpoint(label: string, invoke: (args: object) => Promise<JevResult>, verify: () => Promise<any>) {
  const r = await invoke({ page: label, action: "run", goal: "Set Name to Luna and Plan to Pro. Stop once both fields match; do not click Save.",
    inputs: [{ url: `http://127.0.0.1:${server.port}/`, label: "Name", text: "Luna" }],
    until: { fields: [{ label: "Name", value: "Luna" }, { label: "Plan", value: "pro" }] } });
  const actual = await verify();
  if (r.status !== "done" || r.stopReason !== "checkpoint_reached" || r.verified !== false ||
      actual.name !== "Luna" || actual.plan !== "pro" || (actual.submits || 0) !== 0) throw new Error(`${label}: checkpoint verification failed`);
  const full = await invoke({ page: label, action: "status", sessionId: r.sessionId, diagnostics: "full" });
  if (full.decisions !== r.decisions || full.requests.length !== r.requests.length || !full.trace[0]?.probabilities || r.trace[0]?.probabilities) throw new Error(`${label}: diagnostic retrieval failed`);
  console.log(JSON.stringify({ transport: label, passed: true, decisions: r.decisions, requests: r.requests,
    timing: r.timing, stopReason: r.stopReason, summaryBytes: JSON.stringify(r).length, fullBytes: JSON.stringify(full).length,
    independentVerification: true, submissions: actual.submits || 0 }));
}
let mcp: ReturnType<typeof Bun.spawn> | undefined;
try {
  // Start the daemon without a key, then supply the key on subsequent requests.
  await cli(["-e", setup("cli")], false);
  await exercise("cli", args => cli(["jev", "-e", JSON.stringify(args)]), () => cli(["-e", check("cli")]));
  await cli(["-e", setup("cli-inputs")]);
  await exercise("cli-inputs", args => cli(["jev", "-e", JSON.stringify(args)]), () => cli(["-e", check("cli-inputs")]), true);
  await cli(["-e", setup("cli-checkpoint")]);
  await exerciseCheckpoint("cli-checkpoint", args => cli(["jev", "-e", JSON.stringify(args)]), () => cli(["-e", check("cli-checkpoint")]));
  const proc = Bun.spawn([binary, "mcp", "--headless", "--quiet-page", "-t", "60"], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  mcp = proc;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const pump = (async () => {
    let buf = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(`MCP error ${message.error.code}`)) : waiter.resolve(message.result); }
      }
    }
  })();
  const rpc = async (method: string, params: object) => {
    const id = nextId++;
    let timer: ReturnType<typeof setTimeout>;
    const reply = new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP smoke deadline")); }, 70000);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    try { return await reply; } finally { clearTimeout(timer!); }
  };
  const tool = (name: string, args: object) => rpc("tools/call", { name, arguments: args });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jev-smoke", version: "1" } });
  const opened = await tool("jev_browser_use_run", { script: setup("mcp-inputs") });
  if (opened.isError) throw new Error("MCP fixture setup failed");
  await exercise("mcp-inputs", async args => {
    const result = await tool("jev_browser_use_jev", args);
    if (!result.structuredContent) throw new Error("Missing MCP structuredContent");
    return result.structuredContent;
  }, async () => {
    const result = await tool("jev_browser_use_run", { script: check("mcp-inputs") });
    if (result.isError) throw new Error("MCP verification failed");
    return JSON.parse(result.content[0].text);
  }, true);
  await tool("jev_browser_use_run", { script: setup("mcp-checkpoint") });
  await exerciseCheckpoint("mcp-checkpoint", async args => {
    const result = await tool("jev_browser_use_jev", args);
    if (result.isError || !result.structuredContent) throw new Error("MCP checkpoint execution failed");
    return result.structuredContent;
  }, async () => {
    const result = await tool("jev_browser_use_run", { script: check("mcp-checkpoint") });
    if (result.isError) throw new Error("MCP checkpoint verification failed");
    return JSON.parse(result.content[0].text);
  });
  proc.stdin.end();
  await proc.exited;
  await pump;
} finally {
  mcp?.kill();
  await cli(["stop"], false).catch(() => {});
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
}
