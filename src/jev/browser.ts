import { createHash } from "node:crypto";
import type { CDPSession, ElementHandle, Frame, JSHandle, Page } from "puppeteer-core";
import { resolveRefFrame } from "../page/snapshot/index.ts";
import { withFront } from "../page/extend.ts";
import { observeFrames } from "./frames.ts";
import { pointerPoint, PointerNotReady } from "../page/pointer.ts";
import { currentRun } from "../daemon/run-context.ts";
import type { Decision, Observation } from "./types.ts";

interface DocumentContext { evaluate(expression: string): Promise<unknown>; evaluateHandle(expression: string): Promise<JSHandle> }
interface Realm extends DocumentContext { readonly context?: DocumentContext }
function realm(page: Page | Frame): Realm { return (("mainFrame" in page ? page.mainFrame() : page) as unknown as { isolatedRealm(): Realm }).isolatedRealm(); }
/** Observe window creation without attaching an extra CDP client. */
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
export async function observe(page: Page, signal: AbortSignal, checkpoint = false): Promise<Observation> {
  checkActive(signal);
  try { return await observeFrames(page, () => checkActive(signal), checkpoint); }
  catch (e) {
    if (/context.*destroyed|cannot find context|navigat|detached|document changed/i.test(String(e))) throw new StaleObservation();
    throw e;
  }
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
    let frame: Frame;
    try { frame = resolveRefFrame(page, ref); } catch { throw new StaleObservation("Frame navigated or detached"); }
    const world = realm(frame), context = world.context;
    if (!context) throw new StaleObservation();
    const frameKey = /^f\d+/.exec(ref)?.[0];
    const args = [ref, frameKey ? observed.guards.frames?.[frameKey] : observed.guards.page, observed.guards.targets[ref], decision.operation === "CLICK"].map(v => JSON.stringify(v)).join(",");
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
  // Keep resumed text in the same isolated realm as direct/prepared actions.
  // Main-world handles cannot access the private picker transaction state.
  const context = realm(resolveRefFrame(page, ref)).context;
  if (!context) throw new StaleObservation();
  const raw = await context.evaluateHandle(`window.__jevBrowserUse?.ref(${JSON.stringify(ref)})`).catch(() => null);
  const handle = raw?.asElement() as ElementHandle<Element> | null;
  if (!handle) { await raw?.dispose().catch(() => {}); throw new StaleObservation(); }
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
export async function execute(page: Page, observed: Observation, decision: Decision, handle: ElementHandle<Element> | null, text: string | undefined, signal: AbortSignal, onDispatch: () => void = () => {}): Promise<void> {
  checkActive(signal);
  await withFront(page, async () => {
    checkActive(signal);
    if (decision.operation !== "CLICK") onDispatch();
    if (decision.operation === "CLICK") {
      let point: { x: number; y: number };
      try {
        const safe = await handle!.evaluate(e => (window as any).__jevBrowserUse?.jevHit(e, true)).catch(() => false);
        if (!safe) throw new PointerNotReady("Target changed or became covered before click");
        point = await pointerPoint(handle!);
      } catch (error) {
        if (error instanceof PointerNotReady) throw new StaleObservation(error.message);
        throw new StaleObservation("Target/frame geometry became unavailable before click");
      }
      checkActive(signal);
      await handle!.evaluate(e => (window as any).__jevBrowserUse?.jevBeforeChoice(e));
      onDispatch();
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
      if (observed.elements.find(e => e.ref === decision.target)?.picker) {
        // Some legacy pickers bind their keyboard handlers lazily on mouseover.
        // Native movement also reaches delegated listeners. Recheck the captured
        // node afterward; a hover replacement/overlay must never receive text.
        const point = await pointerPoint(handle!);
        await page.mouse.move(point.x, point.y);
        checkActive(signal);
        const clear = await handle!.evaluate(e => (window as any).__jevBrowserUse?.jevHit(e)).catch(() => false);
        if (!clear) throw new Error("Picker changed or became covered during activation");
      }
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
        let legacyPicker = false;
        {
          if (e.tagName !== "INPUT" && e.tagName !== "TEXTAREA") throw new Error("Unsupported field");
          if (["password", "file", "checkbox", "radio", "hidden", "button", "reset", "submit", "image"].includes(e.type)) throw new Error("Unsupported field type");
          // Autocomplete widgets render their suggestions only while focused.
          // Focus the captured field before the DOM editing transaction; never
          // type into whichever element a handler may redirect focus to.
          legacyPicker = !!(window as any).__jevBrowserUse?.jevBeginEdit(e, value);
          e.focus();
          // Older paired-value pickers listen to keyboard events rather than
          // input. Keep every event bound to the captured node; never synthesize
          // Enter or type into a field that redirected focus.
          if (legacyPicker) e.dispatchEvent(new KeyboardEvent('keydown', {key:'Unidentified',bubbles:true,composed:true}));
          let active = e.ownerDocument.activeElement;
          while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
          if (!e.isConnected || active !== e) throw new Error("Field redirected focus or was replaced");
          const prototype = e.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(e, value);
          if (e.value !== value) throw new Error("Field rejected its value");
        }
        e.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
        let active = e.ownerDocument.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        if (legacyPicker && e.isConnected && active === e)
          e.dispatchEvent(new KeyboardEvent('keyup', {key:'Unidentified',bubbles:true,composed:true}));
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
  const autocomplete = decision.operation === "TYPE_TEXT" && (field?.role === "combobox" || !!field?.picker);
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
        const options = [...(picker || document).querySelectorAll('[role="option"],[role="listbox"] a,[role="listbox"] [role="button"],li,div')].filter(e => {
          if (e.matches('li,div') && !e.matches('[role="option"]') &&
            (getComputedStyle(e).cursor !== 'pointer' || !active || !(active as HTMLInputElement).value ||
              !(e.textContent || '').trim().startsWith((active as HTMLInputElement).value))) return false;
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
