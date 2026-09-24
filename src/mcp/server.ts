/**
 * `jev-browser-use mcp`: a Model Context Protocol server over stdio that exposes the
 * same request/frame contract the CLI uses. Hand-rolled JSON-RPC 2.0 (no SDK)
 * so the binary stays dependency-free.
 *
 * Tools:
 *   jev_browser_use_run      { script, browser?, headless?, connect?, timeout? }  -> text (+ image blocks for page.shot())
 *   jev_browser_use_pages    { browser?, connect? }
 *   jev_browser_use_browsers {}
 *   jev_browser_use_stop     { browser? }
 *   jev_browser_use_help     { topic? }
 *
 * Flags given to `jev-browser-use mcp` (-b, --headless, --connect, -t, --idle-timeout,
 * --quiet-page) are the defaults for every tool call.
 */
import { checkpointSchema, planSchema, routingSchema } from "../jev/schema.ts";
import { jevConfigFromEnv, jevScript } from "../shared/jev.ts";
import * as fs from "node:fs";
import type { GlobalFlags } from "../cli/args.ts";
import { sendRequest } from "../cli/client.ts";
import { sourceFromFlags } from "../cli/main.ts";
import { helpText, topicText } from "../cli/help.ts";
import { DEFAULTS, loadConfig, resolveIdleTimeoutMs } from "../shared/config.ts";
import { VERSION } from "../shared/version.ts";
import type { Frame, RunRequest, Request, PagesPayload, BrowserInfo } from "../shared/protocol.ts";
import { EXIT_OK } from "../shared/protocol.ts";

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const TOOLS = [
  {
    name: "jev_browser_use_run",
    description:
      "Run a JavaScript snippet in jev-browser-use's browser runtime (Puppeteer). Globals: browser.getPage(name) (persistent named tabs), page.snapshot(), page.ref('e5') / 'ref/e5' selectors, page.shot(), page.waitForLoad(), page.fill(), saveFile/readFile. The last expression is the return value. Returns console output, the return value, errors, and page.shot() images.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript (top-level await allowed). Last expression is returned." },
        browser: { type: "string", description: "Named browser profile (default \"default\")." },
        headless: { type: "boolean", description: "Launch headless (default: the server's --headless flag or config)." },
        connect: { type: "string", description: "Attach to a running Chrome: auto | http://host:port | ws://... | unix:/path" },
        timeout: { type: "number", description: "Deadline in seconds for the whole run (default 30)." },
      },
      required: ["script"],
    },
  },
  {
    name: "jev_browser_use_jev",
    description: "Execute a bounded browser task with a warm local loop. Prefer a host-authored plan for multi-step work: known targets run locally, unresolved semantic targets use Jev, and conditional stages advance on verified page evidence. Read help jev-plans; derive labels from observation, not guesses. A goal without plan retains the generic Jev loop. Omit maxSteps to avoid per-click host round trips. Initialize its URL with jev_browser_use_run. needs_text asks the native host to write text and resume; needs_host asks for interpretation or repair. Resume uses single-use sessionId/requestId. plan_complete or DONE still requires independent task verification. No separate text-model API key needed.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        page: { type: "string", description: "Persistent tab name or target id." },
        action: { type: "string", enum: ["run", "resume", "status", "stop"] },
        goal: { type: "string", description: "Bounded goal, required for run (max 4000 characters)." },
        sessionId: { type: "string", description: "Required for resume/status/stop." },
        requestId: { type: "string", description: "Single-use continuation token, required for resume." },
        text: { type: "string", description: "Host-generated field text; required only for needs_text. Empty clears." },
        maxSteps: { type: "integer", minimum: 1, maximum: 30, description: "Optional short burst. Omit to continue until text/help/completion or the session budget." },
        stepLimit: { type: "integer", minimum: 1, maximum: 100, description: "Total session actions (default 60), run only." },
        diagnostics: { type: "string", enum: ["summary", "full"], description: "Run/status only. Summary (default) omits probability maps from host results. Full retains distributions for debugging; status full retrieves them without rerunning actions." },
        until: checkpointSchema,
        plan: planSchema,
        routing: routingSchema,
        inputs: {
          type: "array", maxItems: 20,
          description: "Run-only known text, consumed once on an exact URL and unique accessible field label. Avoid host round trips for known queries or an already-written reply. Unknown fields still ask the host. Total text at most 20000 characters; do not include secrets.",
          items: { type: "object", additionalProperties: false, required: ["url", "label", "text"], properties: {
            url: { type: "string", maxLength: 4000, description: "Exact HTTP(S) page URL, including query/fragment; no credentials." },
            label: { type: "string", minLength: 1, maxLength: 200, description: "Exact unique accessible name of the text field." },
            text: { type: "string", maxLength: 20000 },
          } },
        },
        completion: {
          type: "object", additionalProperties: false, required: ["submitLabel"],
          oneOf: [{ required: ["successText"] }, { required: ["after"] }],
          description: "Run-only boundary for ONE authorized final submission. After clicking this exact button, only observe new success feedback; never issue another action. Use labels/messages established from the site. Independently verify the result.",
          properties: {
            submitLabel: { type: "string", minLength: 1, maxLength: 200, description: "Exact accessible name of the final submit button." },
            successText: { type: "string", minLength: 1, maxLength: 500, description: "Expected text in a new/changed visible alert/status/live region." },
            before: { ...checkpointSchema, description: "Required fresh pre-submit conditions. Any unmet check blocks submission." },
            after: { ...checkpointSchema, description: "Post-submit evidence, absent before dispatch. Use instead of successText when the result is ordinary page content." },
          },
        },
        browser: { type: "string" }, headless: { type: "boolean" }, connect: { type: "string" },
        timeout: { type: "number", exclusiveMinimum: 0, maximum: 120, description: "Whole call deadline in seconds (default server/config setting or 60)." },
      },
      required: ["page", "action"],
    },
  },
  {
    name: "jev_browser_use_pages",
    description: "List open pages (tabs) with target ids, names, URLs and titles.",
    inputSchema: { type: "object", properties: { browser: { type: "string" }, connect: { type: "string" } } },
  },
  { name: "jev_browser_use_browsers", description: "List running browsers managed by the jev-browser-use daemon.", inputSchema: { type: "object", properties: {} } },
  {
    name: "jev_browser_use_stop",
    description: "Stop one browser by name/key, or everything (and the daemon) when no browser is given.",
    inputSchema: { type: "object", properties: { browser: { type: "string" } } },
  },
  {
    name: "jev_browser_use_help",
    description: "The jev-browser-use usage guide (or one topic: quickstart, workflow, scripts, pages, snapshot, refs, screenshots, waiting, forms, errors, output, connect, extension, chrome, config, json, jev, jev-plans, examples, tips).",
    inputSchema: { type: "object", properties: { topic: { type: "string" } } },
  },
];

function textOf(s: string): Content {
  return { type: "text", text: s };
}

async function callTool(name: string, args: Record<string, unknown>, defaults: GlobalFlags, signal?: AbortSignal): Promise<{ content: Content[]; isError?: boolean; structuredContent?: Record<string, unknown> }> {
  const config = loadConfig();
  const flags: GlobalFlags = {
    ...defaults,
    browser: typeof args.browser === "string" ? args.browser : defaults.browser,
    headless: typeof args.headless === "boolean" ? args.headless : defaults.headless,
    connect: typeof args.connect === "string" ? args.connect : defaults.connect,
    timeout: typeof args.timeout === "number" ? args.timeout : defaults.timeout,
  };
  switch (name) {
    case "jev_browser_use_help":
      return { content: [textOf(typeof args.topic === "string" ? topicText(args.topic) : helpText())] };
    case "jev_browser_use_jev":
    case "jev_browser_use_run": {
      if (name === "jev_browser_use_jev") {
        const { browser, headless, connect, timeout, ...input } = args;
        if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 120)) return { content: [textOf("timeout must be > 0 and <= 120 seconds")], isError: true };
        try { args = { script: jevScript(input) }; } catch (e) { return { content: [textOf((e as Error).message)], isError: true }; }
      }
      if (typeof args.script !== "string") return { content: [textOf("script (string) is required")], isError: true };
      const req: RunRequest = {
        type: "run",
        id: `mcp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        script: args.script,
        scriptName: "<mcp>",
        source: sourceFromFlags(flags, config),
        timeoutMs: Math.round((flags.timeout ?? config.timeout ?? (name === "jev_browser_use_jev" ? 60 : DEFAULTS.timeoutSeconds)) * 1000),
        idleTimeoutMs: resolveIdleTimeoutMs(flags.idleTimeout, config),
        quietPage: flags.quietPage,
        cwd: process.cwd(),
        jev: jevConfigFromEnv(),
      };
      let stdout = "";
      let stderr = "";
      let result: string | undefined;
      let structuredContent: Record<string, unknown> | undefined;
      const images: Array<{ path: string; width: number; height: number }> = [];
      let exitCode = 1;
      await sendRequest(req, {
        signal,
        idleTimeoutMs: req.timeoutMs + 15_000,
        killOnIdle: true,
        onFrame: (f: Frame) => {
          switch (f.type) {
            case "stdout": stdout += f.data; break;
            case "stderr": stderr += f.data; break;
            case "result": result = f.value; if (name === "jev_browser_use_jev" && f.data && typeof f.data === "object") structuredContent = f.data as Record<string, unknown>; break;
            case "image": images.push({ path: f.path, width: f.width, height: f.height }); break;
            case "error": {
              let t = `${f.name}: ${f.message}\n`;
              if (f.stack) t += f.stack + "\n";
              for (const p of f.pages ?? []) t += `[page${p.name ? " " + p.name : ""}] ${p.url}${p.title ? ` "${p.title}"` : ""}\n`;
              stderr += t;
              break;
            }
            case "done": exitCode = f.exitCode; break;
            default: break;
          }
        },
      });
      const content: Content[] = [];
      let text = stdout;
      if (result !== undefined) text += (text && !text.endsWith("\n") ? "\n" : "") + result + "\n";
      for (const im of images) text += `[image] ${im.path} (${im.width}x${im.height})\n`;
      if (stderr) text += (text && !text.endsWith("\n") ? "\n" : "") + stderr;
      if (exitCode !== EXIT_OK) text += `(exit ${exitCode})\n`;
      content.push(textOf(text.length > 0 ? text : "(no output)"));
      for (const im of images) {
        try {
          const data = fs.readFileSync(im.path).toString("base64");
          content.push({ type: "image", data, mimeType: im.path.endsWith(".png") ? "image/png" : "image/jpeg" });
        } catch {
          /* file gone */
        }
      }
      return { content, isError: exitCode !== EXIT_OK || structuredContent?.status === "error", ...(structuredContent ? { structuredContent } : {}) };
    }
    case "jev_browser_use_pages":
    case "jev_browser_use_browsers":
    case "jev_browser_use_stop": {
      const req: Request =
        name === "jev_browser_use_pages"
          ? { type: "pages", source: flags.connect !== undefined || flags.browser ? sourceFromFlags(flags, config) : undefined }
          : name === "jev_browser_use_browsers"
            ? { type: "browsers" }
            : { type: "stop", browser: typeof args.browser === "string" ? args.browser : undefined };
      let payload: unknown;
      let error = "";
      let exitCode = 1;
      await sendRequest(req, {
        signal,
        idleTimeoutMs: 30_000,
        onFrame: (f) => {
          if (f.type === "data") payload = f.payload;
          else if (f.type === "error") error += `${f.name}: ${f.message}\n`;
          else if (f.type === "done") exitCode = f.exitCode;
        },
      });
      if (error) return { content: [textOf(error)], isError: true };
      if (name === "jev_browser_use_pages") {
        const list = (payload as PagesPayload[]) ?? [];
        const lines: string[] = [];
        for (const b of list) {
          lines.push(`${b.browser}:`);
          for (const p of b.pages) lines.push(`  ${p.id}  ${p.name ?? "-"}  ${p.url}${p.title ? `  "${p.title}"` : ""}`);
        }
        return { content: [textOf(lines.length ? lines.join("\n") : "no browsers running")], isError: exitCode !== EXIT_OK };
      }
      if (name === "jev_browser_use_browsers") {
        const list = (payload as BrowserInfo[]) ?? [];
        return {
          content: [textOf(list.length ? list.map((b) => `${b.key}  ${b.kind === "launch" ? (b.headless ? "headless" : "headed") : b.kind}  ${b.connected ? "connected" : "disconnected"}  ${b.pages} page(s)`).join("\n") : "no browsers running")],
        };
      }
      return { content: [textOf(JSON.stringify(payload))], isError: exitCode !== EXIT_OK };
    }
    default:
      return { content: [textOf(`unknown tool ${name}`)], isError: true };
  }
}

export async function mcpMain(flags: GlobalFlags): Promise<number> {
  const writer = Bun.stdout.writer();
  const send = (msg: object) => {
    writer.write(JSON.stringify(msg) + "\n");
    writer.flush();
  };
  const reply = (id: JsonRpcRequest["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcRequest["id"], code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

  const calls = new Map<number | string, AbortController>();
  const inflight = new Set<Promise<void>>();
  let buf = "";
  const handle = async (line: string) => {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      fail(null, -32700, "parse error");
      return;
    }
    const id = msg.id ?? null;
    const isNotification = msg.id === undefined;
    try {
      switch (msg.method) {
        case "initialize":
          reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "jev-browser-use", version: VERSION },
            instructions:
              "Use jev_browser_use_run to initialize a named page and observe it. For multi-step tasks, prefer a conditional plan in jev_browser_use_jev: grounded actions execute locally, semantic choices use Jev, and stages advance on verified evidence. Keep unfamiliar widgets as goal stages. Read help jev-plans; do not invent labels. Handle needs_text by writing with your native model and resuming. Handle needs_host by inspecting or replanning. Independently verify the final task. Direct Puppeteer scripts remain available for host work.",
          });
          return;
        case "notifications/initialized":
          return;
        case "notifications/cancelled": {
          const requestId = msg.params?.requestId;
          if (typeof requestId === "number" || typeof requestId === "string") calls.get(requestId)?.abort();
          return;
        }
        case "ping":
          reply(id, {});
          return;
        case "tools/list":
          reply(id, { tools: TOOLS });
          return;
        case "tools/call": {
          const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const abort = new AbortController();
          if (id !== null) calls.set(id, abort);
          try {
            const res = await callTool(String(params.name ?? ""), params.arguments ?? {}, flags, abort.signal);
            reply(id, res);
          } finally { if (id !== null) calls.delete(id); }
          return;
        }
        default:
          if (!isNotification) fail(id, -32601, `method not found: ${msg.method}`);
      }
    } catch (err) {
      if (!isNotification) fail(id, -32603, (err as Error)?.message ?? String(err));
    }
  };

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        const job = handle(line);
        inflight.add(job);
        void job.then(() => inflight.delete(job), () => inflight.delete(job));
      }
    }
  }
  for (const abort of calls.values()) abort.abort();
  await Promise.allSettled(inflight);
  return EXIT_OK;
}
