/** Opt-in real extension check, always in a temporary Chrome profile.
 * JEV_BROWSER_USE_EXTENSION_DIR=/path/to/unpacked/extension bun run scripts/smoke-extension.ts
 */
import puppeteer, { type Browser } from "puppeteer-core";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveExtensionRelay } from "../src/extension/relay.ts";
import { findChrome } from "../src/shared/chrome.ts";
import { extendPage } from "../src/page/extend.ts";
import { JevController } from "../src/jev/controller.ts";
import { chartTrials } from "./test-chart-transcription.ts";

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
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
  const url = new URL(req.url), depth = Number(url.searchParams.get('depth') ?? 0);
  let html = `<!doctype html><title>Extension relay test</title>
<h1>Extension connection test</h1><label>Name <input id=name></label>
<button onclick="document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value">Save</button><p id=result>Waiting</p>`;
  if (url.pathname === '/parent') html = '<button onclick="window.open(\'/child\',\'_blank\')">Open child</button>';
  if (url.pathname === '/child') html = '<h1>Managed popup ready</h1>';
  if (url.pathname === '/frames') html = '<body style="margin:0">' + (depth === 9 ? '<button onclick="this.textContent=\'Nine frames complete\'">Finish frames</button>' : `<iframe style="border:0;width:100%;height:450px" src="http://${depth % 2 ? '127.0.0.1' : 'localhost'}:${url.port}/frames?depth=${depth + 1}"></iframe>`);
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
let chrome: Browser | undefined;
let attached: Browser | undefined;
try {
  chrome = await puppeteer.launch({ executablePath: findChrome()!.path, headless: true, pipe: true,
    userDataDir: join(home, "profile"), enableExtensions: [extensionPath],
    args: ["--no-sandbox", "--no-first-run", "--disable-search-engine-choice-screen"], protocolTimeout: 15_000 });
  const worker = await chrome.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 15_000 });
  const workerSession = await worker.createCDPSession();
  await workerSession.send('Runtime.enable');
  workerSession.on('Runtime.consoleAPICalled', e => {
    const line = e.args.map(a=>a.value ?? a.description).join(' ');
    if (/Popup|Attaching debugger|Tab attached/.test(line)) console.log('[extension fixture]', line);
  });
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
  const planned = await page.jev({ action: "run", goal: "Save the updated name once", plan: {
    origins: [new URL(page.url()).origin],
    targets: { name: { label: "Name" }, save: { label: "Save" } },
    stages: [
      { id: "name", goal: "Update Name", action: { operation: "TYPE_TEXT", target: "name", text: "Ada" } },
      { id: "save", goal: "Save and verify the updated name", action: { operation: "CLICK", target: "save" },
        until: { text: ["Saved Ada"], fields: [{ label: "Name", value: "Ada" }] } },
    ],
  } });
  if (planned.status !== "done" || planned.steps !== 2 || planned.decisions !== 0 ||
      await page.$eval("#result", e => e.textContent) !== "Saved Ada") throw new Error("Conditional plan through extension failed: " + planned.reason);
  console.log("Conditional plan through real extension relay, zero model calls: passed");
  const browserSession = await attached.target().createCDPSession();
  const { targetInfos } = await browserSession.send("Target.getTargets");
  if (!targetInfos.some(t => t.url === page.url())) throw new Error("Target URL was not updated");
  await browserSession.detach();
  if (await page.title() !== "Extension relay test") throw new Error("Browser session detach damaged page session");
  await attached.disconnect();
  // Closing the CDP client must leave Chrome and the extension-managed tab alive.
  attached = await puppeteer.connect({ browserWSEndpoint: relay.wsEndpoint, defaultViewport: null, protocolTimeout: 15_000 });
  const reconnected = (await attached.pages())[0]!;
  if (await reconnected.$eval("#result", e => e.textContent) !== "Saved Ada") throw new Error("Reconnect lost page state");
  await reconnected.close();
  if ((await attached.pages()).length !== 0) throw new Error("Closed target was not removed");
  console.log("Browser session, disconnect/reconnect, page state persistence, tab close: passed");
  const parent = extendPage(await attached.newPage());
  await parent.goto(`http://127.0.0.1:${fixture.port}/parent`);
  const popupRun = await new JevController(parent, async o => ({operation:'CLICK',target:o.elements[0]!.ref,confidence:1,latencyMs:0,model:'fixture'}))
    .call({action:'run',goal:'Open the child tab'});
  if (popupRun.stopReason !== 'new_window' || popupRun.openedPages?.length !== 1) {
    console.log('Managed targets',attached.targets().map(t=>({url:t.url(),id:(t as any)._targetId,opener:(t.opener() as any)?._targetId})));
    console.log('Isolated Chrome tabs',await (await worker.worker())!.evaluate(async()=>await (globalThis as any).chrome.tabs.query({})));
    throw new Error('Popup not exposed: '+JSON.stringify(popupRun));
  }
  const target = attached.targets().find(t => (t as any)._targetId === popupRun.openedPages![0]!.targetId)!;
  const child = await target.page();
  if (!child || !await child.$('h1') || await child.$eval('h1', e => e.textContent) !== 'Managed popup ready') throw new Error('Popup content unavailable');
  if (target.opener() !== parent.target()) throw new Error('Popup opener relationship lost');
  await child.close(); await parent.close();
  const framed = extendPage(await attached.newPage());
  await framed.goto(`http://127.0.0.1:${fixture.port}/frames`,{waitUntil:'load'});
  const framesRun = await framed.jev({action:'run',goal:'Finish the deepest frame',plan:{
    origins:[`http://127.0.0.1:${fixture.port}`,`http://localhost:${fixture.port}`],targets:{finish:{label:'Finish frames'}},
    stages:[{id:'finish',goal:'Click once and verify nested result',action:{operation:'CLICK',target:'finish'},until:{text:['Nine frames complete']}}],
  }});
  if (framesRun.status !== 'done' || framesRun.steps !== 1 || framesRun.page?.frames?.length !== 9) throw new Error('Cross-origin frame plan failed: '+JSON.stringify(framesRun));
  await framed.close();
  console.log('Managed popup adoption/opener and nine cross-origin nested frames through extension: passed');
  if (process.env.JEV_BROWSER_USE_LIVE_SMOKE_REPORT) {
    mkdirSync(process.env.JEV_BROWSER_USE_LIVE_SMOKE_REPORT,{recursive:true});
    const live = extendPage(await attached.newPage());
    await live.goto(`http://127.0.0.1:${fixture.port}/frames`,{waitUntil:'load'});
    const result = await live.jev({action:'run',goal:'Click Finish frames in the deepest nested iframe and confirm Nine frames complete.',until:{text:['Nine frames complete']}});
    writeFileSync(join(process.env.JEV_BROWSER_USE_LIVE_SMOKE_REPORT,'frames-live.json'),JSON.stringify(result,null,2));
    if (result.status !== 'done' || result.steps !== 1) throw new Error('Live Jev iframe test failed: '+result.reason);
    await live.close();
    await chartTrials(attached,join(process.env.JEV_BROWSER_USE_LIVE_SMOKE_REPORT,'chart-live'),true);
  }
  if (process.env.JEV_BROWSER_USE_CHART_REPORT) await chartTrials(attached, process.env.JEV_BROWSER_USE_CHART_REPORT);
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
