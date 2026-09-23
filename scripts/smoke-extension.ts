/** Opt-in real extension check, always in a temporary Chrome profile.
 * JEV_BROWSER_USE_EXTENSION_DIR=/path/to/unpacked/extension bun run scripts/smoke-extension.ts
 */
import puppeteer, { type Browser } from "puppeteer-core";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveExtensionRelay } from "../src/extension/relay.ts";
import { findChrome } from "../src/shared/chrome.ts";
import { extendPage } from "../src/page/extend.ts";

const source = process.env.JEV_BROWSER_USE_EXTENSION_DIR;
if (!source) throw new Error("Set JEV_BROWSER_USE_EXTENSION_DIR to the unpacked jev-browser-use extension");
const home = mkdtempSync(join(tmpdir(), "jev-browser-use-extension-smoke-"));
const previousHome = process.env.JEV_BROWSER_USE_HOME;
process.env.JEV_BROWSER_USE_HOME = join(home, "runtime");
const relay = serveExtensionRelay({ port: 0, log: s => console.log(`[relay] ${s}`) });
const extensionPath = join(home, "extension");
cpSync(source, extensionPath, { recursive: true });
const background = join(extensionPath, "background.js");
const original = readFileSync(background, "utf8");
if (!original.includes("localhost:9222")) throw new Error("Unexpected extension relay endpoint");
writeFileSync(background, original.replaceAll("localhost:9222", `127.0.0.1:${relay.port}`));
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html><title>Extension relay test</title>
<h1>Extension connection test</h1><label>Name <input id=name></label>
<button onclick="document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value">Save</button><p id=result>Waiting</p>`, { headers: { "content-type": "text/html" } }) });
let chrome: Browser | undefined;
let attached: Browser | undefined;
try {
  chrome = await puppeteer.launch({ executablePath: findChrome()!.path, headless: true, pipe: true,
    userDataDir: join(home, "profile"), enableExtensions: [extensionPath],
    args: ["--no-sandbox", "--no-first-run", "--disable-search-engine-choice-screen"], protocolTimeout: 15_000 });
  const worker = await chrome.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 15_000 });
  const popup = await chrome.newPage();
  await popup.goto(worker.url().replace(/\/[^/]*$/, "/popup.html"));
  await popup.click("label.toggle");
  await popup.waitForFunction(() => document.querySelector("#connection-status")?.textContent === "Connected to relay", { timeout: 15_000 });
  console.log("Extension popup: Connected to relay");
  attached = await puppeteer.connect({ browserWSEndpoint: relay.wsEndpoint, defaultViewport: null, protocolTimeout: 15_000 });
  const page = extendPage(await attached.newPage());
  await page.goto(`http://127.0.0.1:${fixture.port}/`);
  const snapshot = await page.snapshot({ interactive: true });
  if (!JSON.stringify(snapshot).includes("Name")) throw new Error("Missing snapshot");
  await page.fill("#name", "Luna");
  await page.click("button");
  const actual = await page.$eval("#result", e => e.textContent);
  if (actual !== "Saved Luna") throw new Error("DOM assertion failed");
  const shot = await page.screenshot({ type: "png" });
  if (shot.length < 1000) throw new Error("Screenshot failed");
  console.log("Page create, navigate, snapshot, fill, click, screenshot: passed");
  const browserSession = await attached.target().createCDPSession();
  const { targetInfos } = await browserSession.send("Target.getTargets");
  if (!targetInfos.some(t => t.url === page.url())) throw new Error("Target URL was not updated");
  await browserSession.detach();
  if (await page.title() !== "Extension relay test") throw new Error("Browser session detach damaged page session");
  await attached.disconnect();
  // Closing the CDP client must leave Chrome and the extension-managed tab alive.
  attached = await puppeteer.connect({ browserWSEndpoint: relay.wsEndpoint, defaultViewport: null, protocolTimeout: 15_000 });
  const reconnected = (await attached.pages())[0]!;
  if (await reconnected.$eval("#result", e => e.textContent) !== "Saved Luna") throw new Error("Reconnect lost page state");
  await reconnected.close();
  if ((await attached.pages()).length !== 0) throw new Error("Closed target was not removed");
  console.log("Browser session, disconnect/reconnect, page state persistence, tab close: passed");
  await attached.disconnect(); attached = undefined;
  console.log(JSON.stringify({ passed: true, extensionPopup: "Connected to relay", isolatedProfile: true }));
} finally {
  await attached?.disconnect().catch(() => {});
  await chrome?.close().catch(() => {});
  await relay.stop();
  fixture.stop(true);
  if (previousHome === undefined) delete process.env.JEV_BROWSER_USE_HOME; else process.env.JEV_BROWSER_USE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
