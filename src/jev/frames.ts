import type { ElementHandle, Frame, Page } from "puppeteer-core";
import { INPAGE_SCRIPT } from "../page/snapshot/inpage.ts";
import { frameDocument, frameKeyFor, getSnapshotState, pruneDetachedFrames } from "../page/snapshot/snapshot.ts";
import type { Observation } from "./types.ts";

type Clip = { left: number; top: number; right: number; bottom: number };
type FrameObservation = Observation & { iframes?: Array<{ ref: string }> };

/** Read only visible, reachable frame surfaces. Refs share the host snapshot's
 * per-document registry, including cross-origin/OOP frames. Limits fail closed. */
export async function observeFrames(page: Page, check: () => void, checkpoint = false): Promise<Observation> {
  const state = getSnapshotState(page);
  pruneDetachedFrames(state);
  let count = 0;
  const visit = async (frame: Frame, prefix: string, depth: number, clip?: Clip): Promise<FrameObservation> => {
    check(); count++;
    const document = await frameDocument(frame);
    const out = await document.evaluate(`${INPAGE_SCRIPT}; window.__jevBrowserUse.jevSnapshot(${JSON.stringify({ refPrefix: prefix, clip, checkpoint })})`) as FrameObservation;
    if (await frameDocument(frame) !== document) throw new Error("Frame document changed during observation");
    const iframes = out.iframes ?? []; delete out.iframes;
    out.frames = [];
    for (const info of iframes) {
      check();
      if (depth >= 16 || count >= 24 || out.elements.length >= 150 || out.text.length >= 6000) {
        out.unsupportedFrames = true; out.truncated = true; break;
      }
      let handle: ElementHandle<HTMLIFrameElement> | null = null;
      try {
        const js = await document.evaluateHandle(`window.__jevBrowserUse.ref(${JSON.stringify(info.ref)})`) as ElementHandle<HTMLIFrameElement>;
        handle = js.asElement() as ElementHandle<HTMLIFrameElement> | null;
        if (!handle) { await js.dispose(); throw new Error("Frame unavailable"); }
        const child = await handle.contentFrame();
        if (!child) throw new Error("Frame unavailable");
        const bounds = await handle.evaluate((e, clip) => {
          const r = e.getBoundingClientRect(), v = clip ?? { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
          const transform = getComputedStyle(e).transform;
          if (transform !== 'none') { const m = new DOMMatrix(transform); if (m.b || m.c || !m.is2D) return null; }
          const sx = r.width / e.offsetWidth, sy = r.height / e.offsetHeight;
          const x = r.left + e.clientLeft * sx, y = r.top + e.clientTop * sy;
          return { left: Math.max(0, (v.left - x) / sx), top: Math.max(0, (v.top - y) / sy),
            right: Math.min(e.clientWidth, (v.right - x) / sx), bottom: Math.min(e.clientHeight, (v.bottom - y) / sy) };
        }, clip);
        if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) throw new Error("Frame geometry unavailable");
        const childDocument = await frameDocument(child);
        const key = frameKeyFor(state, child, childDocument);
        const nested = await visit(child, key, depth + 1, bounds);
        if (await frameDocument(child) !== childDocument) throw new Error("Frame document changed");
        out.frames.push({ ref: key, url: nested.url, depth: depth + 1 }, ...(nested.frames ?? []));
        out.elements.push(...nested.elements.map(e => ({ ...e, frame: e.frame ?? { ref: key, url: nested.url } })));
        (out.pendingSelections ??= []).push(...nested.pendingSelections ?? []);
        (out.rows ??= []).push(...nested.rows ?? []);
        while (out.rows.length > 100 || out.rows.join('').length > 6000) { out.rows.pop(); out.truncated = true; }
        out.text += `\n[Frame ${key}]\n${nested.text}`;
        out.disabledControls!.push(...nested.disabledControls ?? []);
        out.feedback!.push(...nested.feedback ?? []);
        out.loading ||= nested.loading;
        out.unsupportedFrames ||= nested.unsupportedFrames;
        out.truncated ||= nested.truncated || out.elements.length > 150 || out.text.length > 6000;
        Object.assign(out.guards!.targets, nested.guards!.targets);
        Object.assign(out.guards!.frames ??= {}, { [key]: nested.guards!.page }, nested.guards!.frames);
        out.elements = out.elements.slice(0, 150); out.text = out.text.slice(0, 6000);
      } catch {
        out.unsupportedFrames = true;
      } finally { await handle?.dispose().catch(() => {}); }
    }
    if (await frameDocument(frame) !== document) throw new Error("Frame document changed during observation");
    check(); return out;
  };
  return visit(page.mainFrame(), "", 0);
}
