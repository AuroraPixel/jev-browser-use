import { createHash } from "node:crypto";
import type { CDPSession, ElementHandle, JSHandle, Page } from "puppeteer-core";
import { INPAGE_SCRIPT } from "../page/snapshot/inpage.ts";
import { resolveRef } from "../page/snapshot/index.ts";
import { withFront } from "../page/extend.ts";
import { currentRun } from "../daemon/run-context.ts";
import type { Decision, Observation } from "./types.ts";

interface DocumentContext { evaluate(expression: string): Promise<unknown>; evaluateHandle(expression: string): Promise<JSHandle> }
interface Realm extends DocumentContext { readonly context?: DocumentContext }
function realm(page: Page): Realm { return (page.mainFrame() as unknown as { isolatedRealm(): Realm }).isolatedRealm(); }
/** Use the existing session: the extension cannot attach a second CDP client,
 * and a popup may not be exposed as a Puppeteer Page by the bundled extension. */
export function watchWindowOpen(page: Page, opened: (url: string) => void): () => void {
  const client = (page as Page & { _client?: () => CDPSession })._client?.();
  const listener = (event: { url: string }) => opened(event.url);
  client?.on('Page.windowOpen', listener);
  return () => { client?.off('Page.windowOpen', listener); };
}
export class StaleObservation extends Error {
  constructor(detail = "document or target became unavailable") { super(`Page changed before execution (${detail}); observe and choose again`); this.name = "StaleObservation"; }
}
export function checkActive(signal: AbortSignal): void {
  if (signal.aborted || currentRun()?.gate?.finished) throw new Error("Jev execution cancelled");
}
export function fingerprint(observation: Observation): string {
  // Guard internals include offscreen ancestor text and live-region identities.
  // Compare the actual observed semantics; selected targets get their own guard.
  return createHash("sha256").update(JSON.stringify({ ...observation,
    guards: observation.guards?.page,
    feedback: observation.feedback?.map(f => f.text),
  })).digest("hex");
}
export async function observe(page: Page, signal: AbortSignal): Promise<Observation> {
  checkActive(signal);
  const world = realm(page);
  if (!world.context) await world.evaluate("0");
  const document = world.context;
  if (!document) throw new StaleObservation();
  let result: Observation;
  try { result = await document.evaluate(`${INPAGE_SCRIPT}; window.__jevBrowserUse.jevSnapshot()`) as Observation; }
  catch (e) {
    if (/context.*destroyed|cannot find context|navigat|detached/i.test(String(e))) throw new StaleObservation();
    throw e;
  }
  if (world.context !== document) throw new StaleObservation();
  checkActive(signal);
  return result;
}

/** Preflight only: callers may retry this phase, never a dispatched mutation. */
export async function prepare(page: Page, observed: Observation, decision: Decision, signal: AbortSignal, choosingText = false): Promise<ElementHandle<Element> | null> {
  checkActive(signal);
  // Waiting cannot mutate the page; loading updates are the reason to wait.
  if (decision.operation === "WAIT") return null;
  if (decision.operation === "SCROLL_UP" || decision.operation === "SCROLL_DOWN") {
    const current = await observe(page, signal);
    const direction = decision.operation === "SCROLL_UP" ? "up" : "down";
    if (current.documentId !== observed.documentId || current.url !== observed.url ||
        current.scroll.x !== observed.scroll.x || current.scroll.y !== observed.scroll.y || !current.scroll[direction]) throw new StaleObservation("scroll/document boundary changed");
    return null;
  }
  // Scoped text checks apply only to field selection or an explicit URL-bound
  // provided value. Generated text after a host pause validates observed semantics.
  if (observed.guards && decision.target && (decision.operation === "CLICK" || decision.operation === "SELECT" || (choosingText && decision.operation === "TYPE_TEXT"))) {
    const ref = decision.target.split(":")[0]!;
    if (!observed.elements.some(e => e.ref === ref && e.operations.includes(decision.operation as "CLICK" | "SELECT" | "TYPE_TEXT"))) throw new Error("Jev target is not an observed compatible element");
    const world = realm(page), context = world.context;
    if (!context) throw new StaleObservation();
    const args = [ref, observed.guards.page, observed.guards.targets[ref], decision.operation === "CLICK"].map(v => JSON.stringify(v)).join(",");
    const result = await context.evaluateHandle(`window.__jevBrowserUse?.jevTarget(${args})`).catch(() => null);
    const element = result?.asElement() as ElementHandle<Element> | null;
    if (!element || context !== world.context) { await result?.dispose().catch(() => {}); throw new StaleObservation("target identity, context, visibility or form guard changed"); }
    try { checkActive(signal); } catch (e) { await element.dispose().catch(() => {}); throw e; }
    return element;
  }
  const current = await observe(page, signal);
  if (fingerprint(current) !== fingerprint(observed)) {
    const changed = (Object.keys(current) as Array<keyof Observation>).filter(key =>
      JSON.stringify(key === "guards" ? current.guards?.page : current[key]) !== JSON.stringify(key === "guards" ? observed.guards?.page : observed[key]));
    throw new StaleObservation(`observation fields: ${changed.join(", ")}`);
  }
  if (!decision.target) return null;
  const ref = decision.target.split(":")[0]!;
  const element = observed.elements.find((e) => e.ref === ref && e.operations.includes(decision.operation as "CLICK" | "TYPE_TEXT" | "SELECT"));
  if (!element) throw new Error("Jev target is not an observed compatible element");
  let handle: ElementHandle<Element>;
  try { handle = await resolveRef(page, ref); } catch { throw new StaleObservation(); }
  const valid = await handle.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const x = Math.max(0, r.left) + (Math.min(innerWidth, r.right) - Math.max(0, r.left)) / 2;
    const y = Math.max(0, r.top) + (Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) / 2;
    let top = e.ownerDocument.elementFromPoint(x, y);
    while (top?.shadowRoot) { const next = top.shadowRoot.elementFromPoint(x, y); if (!next || next === top) break; top = next; }
    return e.isConnected && !e.matches(":disabled") && !e.closest('[inert],[aria-disabled="true"]') &&
      e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width > 0 && r.height > 0 &&
      x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && !!top && (e === top || e.contains(top));
  }).catch(() => false);
  if (!valid) { await handle.dispose().catch(() => {}); throw new StaleObservation(); }
  try { checkActive(signal); } catch (e) { await handle.dispose().catch(() => {}); throw e; }
  return handle;
}

/** Dispatch once. Any failure is uncertain and must be inspected by the host. */
export async function execute(page: Page, observed: Observation, decision: Decision, handle: ElementHandle<Element> | null, text: string | undefined, signal: AbortSignal): Promise<void> {
  checkActive(signal);
  await withFront(page, async () => {
    checkActive(signal);
    if (decision.operation === "CLICK") {
      // Jev only selects controls inside the viewport. ElementHandle.click()
      // waits on IntersectionObserver before scrolling, which can stall while
      // the desktop is locked. Recheck the actual hit point and send native
      // mouse input without depending on a renderer visibility callback.
      const point = await handle!.evaluate(e => {
        const r = e.getBoundingClientRect();
        const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
        const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
        const x = (left + right) / 2, y = (top + bottom) / 2;
        let hit = e.ownerDocument.elementFromPoint(x, y);
        while (hit?.shadowRoot) { const next = hit.shadowRoot.elementFromPoint(x, y); if (!next || next === hit) break; hit = next; }
        if (!e.isConnected || e.matches(":disabled") || e.closest('[inert],[aria-disabled="true"]') ||
            !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
            right <= left || bottom <= top || !hit || (e !== hit && !e.contains(hit)) || !(window as any).__jevBrowserUse?.jevHit(e, true)) {
          throw new Error("Click target changed or became covered");
        }
        return { x, y };
      });
      checkActive(signal);
      await page.mouse.click(point.x, point.y);
    }
    else if (decision.operation === "SELECT") {
      const [ref, index] = decision.target!.split(":");
      const option = observed.elements.find((e) => e.ref === ref)?.options?.find((o) => o.index === index);
      if (!option) throw new Error("Unobserved select option");
      await handle!.evaluate((node, expected) => {
        const e = node as HTMLSelectElement;
        const option = e.options[Number(expected.index)];
        if (!e.isConnected || e.disabled || e.multiple || !option || option.disabled || option.closest("optgroup[disabled]") || option.value !== expected.value || option.label !== expected.label) throw new Error("Select changed");
        // Select the observed index: duplicate values may have different labels/meaning.
        e.selectedIndex = Number(expected.index);
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
      }, option);
    } else if (decision.operation === "TYPE_TEXT") {
      if (text === undefined) throw new Error("Host text is required");
      const richText = await handle!.evaluate(e => (e as HTMLElement).isContentEditable);
      if (richText) {
        // Chrome Input.insertText cooperates with editors' beforeinput handling.
        // execCommand can double-insert in Draft.js; textContent bypasses it.
        await handle!.evaluate(node => {
          const e = node as HTMLElement;
          if (!e.isConnected || e.getAttribute("aria-readonly") === "true") throw new Error("Editor changed");
          e.focus();
          let active = e.ownerDocument.activeElement;
          while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
          if (active !== e && !e.contains(active)) throw new Error("Editor redirected focus");
          const selection = e.ownerDocument.getSelection();
          if (!selection) throw new Error("Editor selection unavailable");
          const range = e.ownerDocument.createRange();
          range.selectNodeContents(e);
          selection.removeAllRanges(); selection.addRange(range);
        });
        // Recheck after focus handlers/microtasks, before any keyboard input.
        const focused = await handle!.evaluate(node => {
          const e = node as HTMLElement;
          let active = e.ownerDocument.activeElement;
          while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
          const selection = e.ownerDocument.getSelection();
          return e.isConnected && (active === e || e.contains(active)) && !!selection?.rangeCount &&
            e.contains(selection.getRangeAt(0).commonAncestorContainer);
        });
        if (!focused) throw new Error("Editor focus or selection changed");
        checkActive(signal);
        if (text) await page.keyboard.sendCharacter(text);
        else await page.keyboard.press("Backspace");
        return;
      }
      // One DOM operation on the captured node. Keyboard typing after clear/focus can
      // leak text into another field if an input/focus handler redirects focus.
      await handle!.evaluate((node, value) => {
        const e = node as HTMLInputElement;
        if (!e.isConnected || e.matches(":disabled") || e.readOnly || e.getAttribute("aria-readonly") === "true") throw new Error("Field changed");
        {
          if (e.tagName !== "INPUT" && e.tagName !== "TEXTAREA") throw new Error("Unsupported field");
          if (["password", "file", "checkbox", "radio", "hidden", "button", "reset", "submit", "image"].includes(e.type)) throw new Error("Unsupported field type");
          // Autocomplete widgets render their suggestions only while focused.
          // Focus the captured field before the DOM editing transaction; never
          // type into whichever element a handler may redirect focus to.
          e.focus();
          let active = e.ownerDocument.activeElement;
          while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
          if (!e.isConnected || active !== e) throw new Error("Field redirected focus or was replaced");
          const prototype = e.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(e, value);
          if (e.value !== value) throw new Error("Field rejected its value");
        }
        e.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        if (!e.isConnected) throw new Error("Field replaced during input");
      }, text);
    } else if (decision.operation === "SCROLL_UP" || decision.operation === "SCROLL_DOWN") {
      await page.evaluate((direction) => window.scrollBy(0, direction * Math.max(200, innerHeight * 0.75)), decision.operation === "SCROLL_DOWN" ? 1 : -1);
    } else if (decision.operation === "WAIT") await delay(200, signal);
  });
}
/** Bounded render/autocomplete wait after logging execution, never a mutation retry. */
export async function settle(page: Page, observed: Observation, decision: Decision, signal: AbortSignal): Promise<void> {
  checkActive(signal);
  if (decision.operation === "WAIT") return;
  const field = observed.elements.find(e => e.ref === decision.target);
  const autocomplete = decision.operation === "TYPE_TEXT" && field?.role === "combobox";
  try {
    await page.evaluate((autocomplete) => new Promise<void>(resolve => {
      let stopped = false, frames = 0, lastOptions = "", lastChange = performance.now();
      const started = performance.now();
      const finish = () => { if (!stopped) { stopped = true; clearTimeout(timer); clearTimeout(poll); resolve(); } };
      let poll: ReturnType<typeof setTimeout>;
      const timer = setTimeout(finish, autocomplete ? 800 : 50);
      // Observe only the active picker's content, not sidebar clocks/animations.
      const active = document.activeElement;
      const controls = active?.getAttribute('aria-controls') || active?.getAttribute('aria-owns');
      const picker = controls?.split(/\s+/).map(id => document.getElementById(id)).find(Boolean);
      const ready = () => {
        if (stopped) return;
        const options = [...(picker || document).querySelectorAll('[role="option"],[role="listbox"] a,[role="listbox"] [role="button"]')].filter(e => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
        });
        const signature = JSON.stringify(options.map(e => [e.textContent, e.getAttribute('aria-label'), e.getAttribute('href'), e.getAttribute('aria-disabled')]));
        if (signature !== lastOptions) { lastOptions = signature; lastChange = performance.now(); }
        if (++frames >= 2 && (!autocomplete || (options.length && performance.now() - started >= 300 && performance.now() - lastChange >= 150))) finish();
        else if (autocomplete) poll = setTimeout(ready, 40);
        else requestAnimationFrame(ready);
      };
      if (autocomplete) ready(); else requestAnimationFrame(ready);
    }), autocomplete);
  } catch (e) {
    if (!/context.*destroyed|cannot find context|navigat|detached/i.test(String(e))) throw e;
  }
  checkActive(signal);
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("Jev execution cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
