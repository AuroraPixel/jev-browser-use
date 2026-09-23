/**
 * `jev-browser-use mcp`: stdio JSON-RPC server over the same frame contract.
 */
import { test, expect, afterAll, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
let home: string;
let proc: import("bun").Subprocess<"pipe", "pipe", "inherit">;
let reader: ReadableStreamDefaultReader<Uint8Array>;
let buf = "";
const pending = new Map<number, (v: any) => void>();
let nextId = 1;

async function pump(): Promise<void> {
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  }
}

function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  const p = new Promise<any>((resolve) => pending.set(id, resolve));
  (proc.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-browser-use-mcp-"));
  const env = { ...process.env, JEV_BROWSER_USE_HOME: home } as Record<string, string>;
  delete env.NODE_PATH;
  delete env.TYPESAFE_API_KEY; // Regular tests must never make paid model calls.
  proc = Bun.spawn([process.execPath, path.join(ROOT, "src/cli/main.ts"), "mcp", "--headless"], {
    cwd: ROOT,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  void pump();
});

afterAll(async () => {
  try {
    await rpc("tools/call", { name: "jev_browser_use_stop", arguments: {} });
  } catch {
    /* ignore */
  }
  proc.kill();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(home, { recursive: true, force: true });
});

test("initialize + tools/list", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  expect(init.result.serverInfo.name).toBe("jev-browser-use");
  expect(init.result.capabilities.tools).toBeDefined();
  (proc.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t: any) => t.name);
  expect(names).toEqual(["jev_browser_use_run", "jev_browser_use_jev", "jev_browser_use_pages", "jev_browser_use_browsers", "jev_browser_use_stop", "jev_browser_use_help"]);
}, 20_000);

test("jev_browser_use_run returns text + image content, errors set isError", async () => {
  const r = await rpc("tools/call", {
    name: "jev_browser_use_run",
    arguments: { script: 'const p = await browser.getPage("m"); await p.setContent("<title>mcp</title><h1>hi</h1>"); console.log("log line"); await p.shot({ name: "mcp.jpg" }); await p.title()' },
  });
  expect(r.result.isError).toBe(false);
  const text = r.result.content.find((c: any) => c.type === "text").text as string;
  expect(text).toContain("log line");
  expect(text).toContain("mcp\n");
  expect(text).toContain("[image]");
  const img = r.result.content.find((c: any) => c.type === "image");
  expect(img.mimeType).toBe("image/jpeg");
  expect(img.data.length).toBeGreaterThan(1000);

  const e = await rpc("tools/call", { name: "jev_browser_use_run", arguments: { script: "throw new TypeError('boom')" } });
  expect(e.result.isError).toBe(true);
  expect(e.result.content[0].text).toContain("TypeError: boom");

  const pages = await rpc("tools/call", { name: "jev_browser_use_pages", arguments: {} });
  expect(pages.result.content[0].text).toContain("  m  ");
  const help = await rpc("tools/call", { name: "jev_browser_use_help", arguments: { topic: "refs" } });
  expect(help.result.content[0].text).toMatch(/^## refs/);
  const bad = await rpc("nope", {});
  expect(bad.error.code).toBe(-32601);
}, 60_000);

test("Jev MCP returns structured handoff/error state without a text model; validates inputs", async () => {
  const bad = await rpc("tools/call", { name: "jev_browser_use_jev", arguments: { page: "m", action: "run", goal: "test", apiKey: "must-not-be-accepted" } });
  expect(bad.result.isError).toBe(true);
  expect(bad.result.content[0].text).not.toContain("must-not-be-accepted");
  const r = await rpc("tools/call", { name: "jev_browser_use_jev", arguments: { page: "m", action: "run", goal: "Inspect the heading" } });
  expect(r.result.isError).toBe(true);
  expect(r.result.structuredContent.status).toBe("error");
  expect(r.result.structuredContent.reason).toContain("TYPESAFE_API_KEY");
  const status = await rpc("tools/call", { name: "jev_browser_use_jev", arguments: { page: "m", action: "status", sessionId: r.result.structuredContent.sessionId } });
  expect(status.result.structuredContent.sessionId).toBe(r.result.structuredContent.sessionId);
});

test("MCP cancellation closes the run socket and prevents late script mutation", async () => {
  const id = nextId;
  const running = rpc("tools/call", { name: "jev_browser_use_run", arguments: { script: 'const p = await browser.getPage("cancel-mcp"); await p.setContent("<title>unchanged</title>"); await new Promise(r => setTimeout(r, 3000)); await p.evaluate(() => document.title = "late")' } });
  // A concurrent read confirms the run started, without waiting for that run to end.
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 50));
    const tabs = await rpc("tools/call", { name: "jev_browser_use_pages", arguments: {} });
    if (tabs.result.content[0].text.includes("unchanged")) { ready = true; break; }
  }
  expect(ready).toBe(true);
  (proc.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }) + "\n");
  const cancelled = await running;
  expect(cancelled.error.message).toContain("cancelled");
  await new Promise(r => setTimeout(r, 3200));
  const final = await rpc("tools/call", { name: "jev_browser_use_run", arguments: { script: 'const p = await browser.getPage("cancel-mcp"); await p.title()' } });
  expect(final.result.content[0].text.trim()).toBe("unchanged");
});
