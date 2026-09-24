import type { ElementHandle, Page } from "puppeteer-core";

export class PointerNotReady extends Error {}

/** Compute a current native-input point and verify every ancestor iframe's
 * hit surface. Puppeteer boundingBox is in the main viewport, including OOPIFs. */
export async function pointerPoint(handle: ElementHandle<Element>): Promise<{ x: number; y: number }> {
  const local = await handle.evaluate(e => {
    const r = e.getBoundingClientRect();
    const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
    const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    const x = (left + right) / 2, y = (top + bottom) / 2;
    let hit = e.ownerDocument.elementFromPoint(x, y);
    while (hit?.shadowRoot) { const next = hit.shadowRoot.elementFromPoint(x, y); if (!next || next === hit) break; hit = next; }
    if (!e.isConnected || right <= left || bottom <= top || !e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) ||
        e.matches(':disabled') || e.closest('[inert],[aria-disabled="true"]') || !hit || (hit !== e && !e.contains(hit))) return null;
    return { x, y, left: r.left, top: r.top, width: r.width, height: r.height };
  }).catch(() => null);
  const box = local && await handle.boundingBox().catch(() => null);
  if (!local || !box) throw new PointerNotReady("Target was replaced, hidden or covered before dispatch");
  const point = { x: box.x + (local.x - local.left) * box.width / local.width,
    y: box.y + (local.y - local.top) * box.height / local.height };
  for (let frame = handle.frame; frame.parentFrame(); frame = frame.parentFrame()!) {
    const owner = await frame.frameElement();
    if (!owner) throw new PointerNotReady("Frame owner detached");
    try {
      const ownerBox = await owner.boundingBox();
      const clear = ownerBox && await owner.evaluate((e, args) => {
        const r = e.getBoundingClientRect(), [p, b] = args;
        const x = r.left + (p.x - b.x) * r.width / b.width, y = r.top + (p.y - b.y) * r.height / b.height;
        let hit = e.ownerDocument.elementFromPoint(x, y);
        while (hit?.shadowRoot) { const next = hit.shadowRoot.elementFromPoint(x, y); if (!next || next === hit) break; hit = next; }
        return e.isConnected && hit === e;
      }, [point, ownerBox] as const);
      if (!clear) throw new PointerNotReady("Ancestor frame is covered or clipped");
    } finally { await owner.dispose(); }
  }
  // The frame traversal itself takes time: reject a detached target at its end.
  if (!await handle.evaluate(e => e.isConnected).catch(() => false)) throw new PointerNotReady("Target detached before dispatch");
  return point;
}

export interface InteractOptions {
  operation: "click" | "hover";
  selector: string;
  /** Default requires exactly one match; explicit index may target a chart mark. */
  index?: number;
  /** Expected match count detects a partially rendered chart/list. */
  count?: number;
  timeoutMs?: number;
  /** Read visible text after hover; includes binds the tooltip to this mark. */
  read?: { selector: string; includes: string };
}
export interface InteractResult { attempts: number; elapsedMs: number; text?: string }

/** Re-resolve dynamic selectors only before dispatch. Hover is repeatable;
 * clicks are never retried after Input.dispatchMouseEvent has been attempted. */
export async function interact(page: Page, options: InteractOptions): Promise<InteractResult> {
  if (!['click', 'hover'].includes(options.operation) || typeof options.selector !== 'string' || !options.selector ||
      (options.index !== undefined && (!Number.isInteger(options.index) || options.index < 0)) ||
      (options.count !== undefined && (!Number.isInteger(options.count) || options.count < 1)) ||
      (options.read && (options.operation !== 'hover' || !options.read.selector || !options.read.includes))) throw new TypeError("Invalid interact options");
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new TypeError("interact timeoutMs must be 100..30000");
  const started = performance.now(), deadline = started + timeout;
  const documentHandle = await page.mainFrame().evaluateHandle(() => document);
  let signature: string | undefined, attempts = 0, lastError = 'Target unavailable';
  try {
    while (performance.now() < deadline) {
      attempts++;
      let handle: ElementHandle<Element> | undefined;
      const handles = await page.$$(options.selector);
      try {
        if ((options.count !== undefined && handles.length !== options.count) || (options.index === undefined && handles.length !== 1)) throw new PointerNotReady("Target count not ready or ambiguous");
        handle = handles[options.index ?? 0];
        if (!handle) throw new PointerNotReady("Target not present");
        const next = await handle.evaluate(e => {
          if (!e.isConnected) return null;
          const r = e.getBoundingClientRect();
          if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) e.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
          return JSON.stringify([e.tagName, e.getAttribute('role'), e.getAttribute('aria-label'), e.getAttribute('href'), e.getAttribute('title'), e.textContent]);
        }).catch(() => null);
        if (next === null) throw new PointerNotReady("Target detached before dispatch");
        if (signature !== undefined && signature !== next) throw new Error("Target meaning changed during relocation; inspect before continuing");
        signature = next;
        const first = await pointerPoint(handle);
        await new Promise(r => setTimeout(r, 40));
        const point = await pointerPoint(handle);
        if (Math.abs(first.x - point.x) > 1 || Math.abs(first.y - point.y) > 1) throw new PointerNotReady("Target still moving");
        if (!await documentHandle.evaluate(d => d === window.document).catch(() => false)) throw new Error("Document changed during relocation; inspect before continuing");
        if (options.operation === 'click') {
          // Errors after this boundary are deliberately not PointerNotReady.
          try { await page.mouse.click(point.x, point.y); }
          catch (error) { throw new Error("Click may have executed; no retry was attempted", { cause: error }); }
          return { attempts, elapsedMs: Math.round(performance.now() - started) };
        }
        await page.mouse.move(0, 0);
        await page.mouse.move(point.x, point.y);
        if (!options.read) return { attempts, elapsedMs: Math.round(performance.now() - started) };
        let previous: string | undefined;
        const readUntil = Math.min(deadline, performance.now() + 800);
        while (performance.now() < readUntil) {
          const text = await page.$$eval(options.read.selector, es => es.filter(e => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
          }).map(e => (e as HTMLElement).innerText ?? e.textContent ?? '').join('\n'));
          if (text.includes(options.read.includes) && text === previous) return { text, attempts, elapsedMs: Math.round(performance.now() - started) };
          previous = text;
          await new Promise(r => setTimeout(r, 40));
        }
        throw new PointerNotReady("Tooltip did not match the requested mark");
      } catch (error) {
        if (!(error instanceof PointerNotReady)) throw error;
        lastError = error.message;
      } finally { await Promise.all(handles.map(h => h.dispose().catch(() => {}))); }
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error(`Interaction timed out without dispatching a click: ${lastError}`);
  } finally { await documentHandle.dispose().catch(() => {}); }
}
