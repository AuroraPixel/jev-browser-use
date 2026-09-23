import { test, expect } from "bun:test";
import { serveExtensionRelay } from "../../src/extension/relay.ts";

const origin = `chrome-extension://${"a".repeat(32)}`;

async function socket(url: string, extension = false): Promise<WebSocket> {
  const BunSocket = WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket };
  const ws = extension ? new BunSocket(url, { headers: { Origin: origin } }) : new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
  return ws;
}

function messages(ws: WebSocket) {
  const queue: any[] = [];
  const waiting: Array<(message: any) => void> = [];
  ws.addEventListener("message", event => {
    const value = JSON.parse(String(event.data));
    const waiter = waiting.shift();
    if (waiter) waiter(value); else queue.push(value);
  });
  return { next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>(resolve => waiting.push(resolve)) };
}

test("relay rejects website origins/rebinding and waits for an extension", async () => {
  const relay = serveExtensionRelay({ port: 0 });
  const url = `http://127.0.0.1:${relay.port}`;
  try {
    expect((await fetch(url).then(r => r.json())).extensionConnected).toBe(false);
    expect((await fetch(url + "/json/version")).status).toBe(503);
    expect((await fetch(url, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(url, { headers: { Origin: "null" } })).status).toBe(403);
    expect((await fetch(url, { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await fetch(url + "/extension")).status).toBe(403);
    expect((await fetch(url + "/cdp", { headers: { Origin: origin } })).status).toBe(403);
    expect((await fetch(url, { method: "HEAD", headers: { Origin: origin } })).status).toBe(200);
  } finally { await relay.stop(); }
});

test("relay routes commands once, preserves child parents, and clears state on disconnect", async () => {
  const relay = serveExtensionRelay({ port: 0 });
  const base = `ws://127.0.0.1:${relay.port}`;
  const ext = await socket(base + "/extension", true);
  const extMessages = messages(ext);
  const cdp = await socket(base + "/cdp");
  const inbox = messages(cdp);
  const send = (value: object) => cdp.send(JSON.stringify(value));
  const event = (params: object) => ext.send(JSON.stringify({ method: "forwardCDPEvent", params }));
  try {
    send({ id: 1, method: "Target.getBrowserContexts" });
    expect(await inbox.next()).toEqual({ id: 1, result: { browserContextIds: [] } });
    send({ id: 2, method: "Target.setAutoAttach", params: { autoAttach: true } });
    expect((await inbox.next()).id).toBe(2);
    const info = { targetId: "t1", type: "page", title: "Test", url: "about:blank", attached: true };
    event({ method: "Target.attachedToTarget", params: { sessionId: "pw-tab-1", targetInfo: info, waitingForDebugger: false } });
    expect((await inbox.next()).params.sessionId).toBe("pw-tab-1");
    event({ sessionId: "pw-tab-1", method: "Target.attachedToTarget", params: { sessionId: "child-1", targetInfo: { ...info, targetId: "frame", type: "iframe" } } });
    expect((await inbox.next()).sessionId).toBe("pw-tab-1");
    send({ id: 3, method: "Target.getTargets" });
    expect((await inbox.next()).result.targetInfos.map((t: any) => t.targetId)).toEqual(["jev-browser-use-extension", "t1"]);
    send({ id: 4, sessionId: "pw-tab-1", method: "Runtime.evaluate", params: { expression: "1+1" } });
    const request = await extMessages.next();
    expect(request.params).toEqual({ sessionId: "pw-tab-1", method: "Runtime.evaluate", params: { expression: "1+1" } });
    ext.send(JSON.stringify({ id: request.id, result: { result: { value: 2 } } }));
    expect(await inbox.next()).toEqual({ id: 4, sessionId: "pw-tab-1", result: { result: { value: 2 } } });
    send({ id: 5, method: "Browser.close" });
    expect((await inbox.next()).error.message).toContain("cannot close");
    const closed = new Promise<void>(resolve => cdp.addEventListener("close", () => resolve(), { once: true }));
    ext.close();
    await closed;
    const status = await fetch(`http://127.0.0.1:${relay.port}`).then(r => r.json());
    expect(status).toMatchObject({ extensionConnected: false, clientConnected: false, targets: 0 });
    const replacement = await socket(base + "/extension", true);
    expect((await fetch(`http://127.0.0.1:${relay.port}/json/version`)).status).toBe(200);
    replacement.close();
  } finally { cdp.close(); ext.close(); await relay.stop(); }
});

test("command timeout reports uncertainty without retrying the mutation", async () => {
  const relay = serveExtensionRelay({ port: 0, commandTimeoutMs: 30 });
  const ext = await socket(`ws://127.0.0.1:${relay.port}/extension`, true);
  let received = 0;
  ext.addEventListener("message", () => received++);
  const cdp = await socket(relay.wsEndpoint);
  const inbox = messages(cdp);
  try {
    cdp.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } }));
    const response = await inbox.next();
    expect(response.error.message).toContain("may already have executed");
    expect(received).toBe(1);
  } finally { cdp.close(); ext.close(); await relay.stop(); }
  // stop() must release the listener even after upgrading to WebSockets.
  const restarted = serveExtensionRelay({ port: relay.port });
  try {
    const state = await fetch(`http://127.0.0.1:${restarted.port}`).then(r => r.json());
    expect(state.extensionConnected).toBe(false);
  } finally { await restarted.stop(); }
});
