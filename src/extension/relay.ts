/**
 * Loopback CDP bridge for the bundled jev-browser-use Chrome extension.
 * The extension owns chrome.debugger; this bridge supplies the browser-level
 * discovery/session methods Puppeteer needs. It never launches or closes Chrome.
 */
import type { ServerWebSocket } from "bun";

type Params = Record<string, any>;
type TargetInfo = { targetId: string; type: string; title: string; url: string; attached: boolean; [key: string]: unknown };
type Target = { sessionId: string; targetInfo: TargetInfo };
type Client = { kind: "cdp"; discover: boolean; autoAttach: boolean; attached: Set<string>; browserSessions: Set<string> };
type Socket = ServerWebSocket<Client | { kind: "extension" }>;
type Command = { id: number; method: string; params?: Params; sessionId?: string };

export interface ExtensionRelay {
  port: number;
  wsEndpoint: string;
  stop(): Promise<void>;
}

export function serveExtensionRelay(options: {
  port?: number;
  commandTimeoutMs?: number;
  log?: (message: string) => void;
} = {}): ExtensionRelay {
  const port = options.port ?? 9222;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("relay port must be 0..65535");
  const log = options.log ?? (() => {});
  const targets = new Map<string, Target>();
  const browserTarget: TargetInfo = { targetId: "jev-browser-use-extension", type: "browser", title: "jev-browser-use extension", url: "", attached: true };
  let extension: Socket | null = null;
  let client: Socket | null = null;
  let nextId = 0;
  let nextBrowserSession = 0;
  const sockets = new Set<Socket>();
  let allSocketsClosed: (() => void) | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const browserSession = (ws: Socket, id?: string) => !!id && ws.data.kind === "cdp" && ws.data.browserSessions.has(id);
  const send = (ws: Socket | null, value: object) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(value));
  };
  const rejectPending = (reason: string) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    pending.clear();
  };
  const forward = (method: string, params?: Params, sessionId?: string): Promise<any> => {
    const ws = extension;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error("Extension disconnected. Enable jev-browser-use in Chrome."));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out; an action may already have executed. Inspect the page before retrying.`));
      }, options.commandTimeoutMs ?? 30_000);
      pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ id, method: "forwardCDPCommand", params: { method, params, sessionId } })); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error("Extension connection closed")); }
    });
  };
  const attached = (ws: Socket, target: Target) => {
    if (ws.data.kind !== "cdp" || ws.data.attached.has(target.sessionId)) return;
    ws.data.attached.add(target.sessionId);
    send(ws, { method: "Target.attachedToTarget", params: { ...target, waitingForDebugger: false } });
  };
  const attachBrowser = (ws: Socket) => {
    if (ws.data.kind !== "cdp") throw new Error("CDP client required");
    const sessionId = `relay-browser-${++nextBrowserSession}`;
    ws.data.browserSessions.add(sessionId);
    send(ws, { method: "Target.attachedToTarget", params: { sessionId, targetInfo: browserTarget, waitingForDebugger: false } });
    return { sessionId };
  };

  async function route(ws: Socket, command: Command): Promise<unknown> {
    const { method, params = {}, sessionId } = command;
    if (!extension) throw new Error("Extension disconnected. Enable jev-browser-use in Chrome.");
    if (ws.data.kind !== "cdp") throw new Error("CDP client required");
    const root = !sessionId || browserSession(ws, sessionId);
    if (root) {
      switch (method) {
        case "Browser.getVersion":
          return { protocolVersion: "1.3", product: "Chrome/JevBrowserUseExtension", revision: "1", userAgent: "jev-browser-use-relay", jsVersion: "V8" };
        case "Browser.close": throw new Error("The extension relay cannot close the user's browser. Disconnect the client instead.");
        case "Target.getBrowserContexts": return { browserContextIds: [] };
        case "Target.getTargets": return { targetInfos: [browserTarget, ...[...targets.values()].map(t => t.targetInfo)] };
        case "Target.setDiscoverTargets":
          ws.data.discover = params.discover === true;
          if (ws.data.discover) for (const targetInfo of [browserTarget, ...[...targets.values()].map(t => t.targetInfo)]) {
            send(ws, { method: "Target.targetCreated", params: { targetInfo } });
          }
          return {};
        case "Target.setAutoAttach":
          // chrome.debugger exposes page targets directly, without Chrome's tab wrapper.
          // Root auto-attachment is emulated; child sessions keep their real parent.
          ws.data.autoAttach = params.autoAttach === true;
          if (ws.data.autoAttach) for (const target of targets.values()) attached(ws, target);
          return {};
        case "Target.attachToBrowserTarget": return attachBrowser(ws);
        case "Target.attachToTarget":
          if (params.targetId === browserTarget.targetId) return attachBrowser(ws);
          throw new Error("Extra page CDP sessions are not supported by the bundled extension. Use the normal page helpers.");
        case "Target.detachFromTarget":
          if (ws.data.browserSessions.delete(params.sessionId)) {
            send(ws, { method: "Target.detachedFromTarget", params: { sessionId: params.sessionId } });
            return {};
          }
          throw new Error("Cannot detach the extension's shared page session");
        case "Target.getTargetInfo": {
          const target = [...targets.values()].find(t => t.targetInfo.targetId === params.targetId);
          if (target) return { targetInfo: target.targetInfo };
          if (!params.targetId || params.targetId === browserTarget.targetId) return { targetInfo: browserTarget };
          throw new Error("Target not found");
        }
        case "Target.createTarget":
          if (params.browserContextId) throw new Error("Extension relay uses the existing Chrome profile only");
          return forward(method, params);
        case "Target.closeTarget":
        case "Target.activateTarget":
          if (![...targets.values()].some(t => t.targetInfo.targetId === params.targetId)) throw new Error("Target is not managed by the extension");
          return forward(method, params);
        default: throw new Error(`Browser-level ${method} is not supported by the extension relay`);
      }
    }
    return forward(method, params, sessionId);
  }

  function extensionEvent(message: Params) {
    const { method, params = {}, sessionId } = message;
    if (typeof method !== "string") return;
    // Only synthetic top-level tab attachments belong in the browser registry.
    // Iframe/worker events must retain the parent sessionId for Puppeteer.
    if (!sessionId && method === "Target.attachedToTarget" && typeof params.sessionId === "string" && params.targetInfo?.targetId) {
      const target: Target = { sessionId: params.sessionId, targetInfo: { ...params.targetInfo, attached: true } };
      targets.set(target.sessionId, target);
      if (client?.data.kind === "cdp") {
        if (client.data.discover) send(client, { method: "Target.targetCreated", params: { targetInfo: target.targetInfo } });
        if (client.data.autoAttach) attached(client, target);
      }
      return;
    }
    if (!sessionId && method === "Target.detachedFromTarget") {
      const target = targets.get(params.sessionId);
      targets.delete(params.sessionId);
      if (client?.data.kind === "cdp") {
        if (client.data.attached.delete(params.sessionId)) send(client, { method, params });
        if (target && client.data.discover) send(client, { method: "Target.targetDestroyed", params: { targetId: target.targetInfo.targetId } });
      }
      return;
    }
    if (method === "Target.targetInfoChanged" && params.targetInfo) {
      const target = [...targets.values()].find(t => t.targetInfo.targetId === params.targetInfo.targetId);
      if (target) {
        target.targetInfo = { ...params.targetInfo, attached: true };
        if (client?.data.kind === "cdp" && client.data.discover) send(client, { method, params: { targetInfo: target.targetInfo } });
        return;
      }
    }
    // chrome.debugger does not consistently emit targetInfoChanged after navigation.
    if (method === "Page.frameNavigated" && !params.frame?.parentId && targets.has(sessionId)) {
      const target = targets.get(sessionId)!;
      target.targetInfo = { ...target.targetInfo, url: params.frame.url };
      if (client?.data.kind === "cdp" && client.data.discover) send(client, { method: "Target.targetInfoChanged", params: { targetInfo: target.targetInfo } });
    }
    send(client, { method, params, ...(sessionId ? { sessionId } : {}) });
  }

  const server = Bun.serve<Client | { kind: "extension" }>({
    hostname: "127.0.0.1", port,
    fetch(req, srv) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const extensionOrigin = origin !== null && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      // Reject arbitrary website origins, opaque origins and DNS rebinding hosts.
      if (!["127.0.0.1", "localhost"].includes(url.hostname) || (origin !== null && !extensionOrigin)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      if (url.pathname === "/") return Response.json({ mode: "extension", extensionConnected: extension !== null, clientConnected: client !== null, targets: targets.size, wsEndpoint: `ws://127.0.0.1:${srv.port}/cdp` });
      if (url.pathname === "/json/version") {
        if (!extension) return new Response("Extension is not connected", { status: 503 });
        return Response.json({ Browser: "Chrome/JevBrowserUseExtension", "Protocol-Version": "1.3", webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/cdp` });
      }
      if (url.pathname === "/extension") {
        if (!extensionOrigin) return new Response("Chrome extension origin required", { status: 403 });
        if (extension) return new Response("An extension is already connected", { status: 409 });
        if (srv.upgrade(req, { data: { kind: "extension" } })) return;
      } else if (url.pathname === "/cdp") {
        if (origin !== null) return new Response("CDP is for local non-browser clients", { status: 403 });
        if (!extension) return new Response("Extension is not connected", { status: 503 });
        if (client) return new Response("A CDP client is already connected; reuse the jev-browser-use daemon", { status: 409 });
        if (srv.upgrade(req, { data: { kind: "cdp", discover: false, autoAttach: false, attached: new Set(), browserSessions: new Set() } })) return;
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      idleTimeout: 0, maxPayloadLength: 16 * 1024 * 1024,
      open(ws) {
        sockets.add(ws);
        if (ws.data.kind === "extension") {
          if (extension) { ws.close(4001, "Extension already connected"); return; }
          extension = ws;
          log("Chrome extension connected");
        } else {
          if (client || !extension) { ws.close(4001, "CDP connection unavailable"); return; }
          client = ws;
          log("CDP client connected");
        }
      },
      async message(ws, raw) {
        let message: Params;
        try { message = JSON.parse(typeof raw === "string" ? raw : raw.toString()); }
        catch { ws.close(1003, "Invalid JSON"); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { ws.close(1003, "Invalid message"); return; }
        if (ws.data.kind === "extension") {
          if (extension !== ws) return;
          if (typeof message.id === "number") {
            const p = pending.get(message.id);
            if (!p) return;
            pending.delete(message.id); clearTimeout(p.timer);
            if (message.error) p.reject(new Error(typeof message.error === "string" ? message.error : "Extension command failed"));
            else p.resolve(message.result ?? {});
          } else if (message.method === "forwardCDPEvent" && message.params && typeof message.params === "object") extensionEvent(message.params);
          // Never log extension console messages: they can include page content.
          return;
        }
        if (client !== ws) return;
        if (!Number.isSafeInteger(message.id) || typeof message.method !== "string") { ws.close(1003, "Invalid CDP command"); return; }
        const { id, sessionId } = message;
        try { send(ws, { id, sessionId, result: await route(ws, message as Command) }); }
        catch (error) { send(ws, { id, sessionId, error: { code: -32000, message: (error as Error).message } }); }
      },
      close(ws) {
        sockets.delete(ws);
        if (sockets.size === 0) allSocketsClosed?.();
        if (extension === ws) {
          extension = null;
          targets.clear();
          rejectPending("Extension disconnected; inspect the page before retrying an action");
          const oldClient = client; client = null;
          oldClient?.close(1011, "Extension disconnected");
          log("Chrome extension disconnected");
        } else if (client === ws) {
          client = null;
          rejectPending("CDP client disconnected; action outcome is unknown");
          log("CDP client disconnected");
        }
      },
    },
  });
  // Application messages keep the MV3 background worker alive (protocol pings do
  // not necessarily run its JS). The extension router safely ignores this method.
  const heartbeat = setInterval(() => send(extension, { id: -1, method: "ping" }), 20_000);
  return {
    port: server.port!, wsEndpoint: `ws://127.0.0.1:${server.port}/cdp`,
    async stop() {
      clearInterval(heartbeat);
      rejectPending("Relay stopped");
      // Complete all socket close callbacks before stopping the HTTP listener.
      if (sockets.size) {
        const closed = new Promise<void>(resolve => { allSocketsClosed = resolve; });
        for (const ws of sockets) ws.terminate();
        await closed;
      }
      // Bun 1.3.14 can retain its pendingWebSockets counter after terminate(), so
      // the stop promise may never resolve even though all transports are closed.
      // stop(true) closes the listener immediately; do not await that counter.
      void server.stop(true);
      server.unref();
      log("Relay stopped");
    },
  };
}

export async function relayCommand(args: string[]): Promise<number> {
  let port = 9222;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1] && /^\d+$/.test(args[i + 1]!)) port = Number(args[++i]);
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stdout.write("jev-browser-use relay [--port 9222]\nLoopback bridge for the jev-browser-use Chrome extension. Keep this process running.\n");
      return 0;
    } else { process.stderr.write("Usage: jev-browser-use relay [--port 9222]\n"); return 2; }
  }
  if (port < 1 || port > 65535) { process.stderr.write("relay --port must be 1..65535\n"); return 2; }
  const relay = serveExtensionRelay({ port, log: message => process.stderr.write(`[relay] ${message}\n`) });
  process.stderr.write(`[relay] Listening on http://127.0.0.1:${relay.port}; enable the Chrome extension.\n`);
  return new Promise(resolve => {
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      process.off("SIGTERM", stop); process.off("SIGINT", stop);
      void relay.stop().then(() => resolve(0));
    };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
  });
}
