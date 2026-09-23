import type { Page } from "puppeteer-core";

interface RenderingState {
  requested: boolean;
  applied?: boolean;
  leases: number;
  tail: Promise<void>;
  set: (enabled: boolean) => Promise<void>;
}
const states = new WeakMap<Page, RenderingState>();

/** Preserve the caller's focus preference while navigation/Jev need frames. */
export function installRendering(page: Page): void {
  if (states.has(page)) return;
  const state: RenderingState = { requested: false, leases: 0, tail: Promise.resolve(), set: page.emulateFocusedPage.bind(page) };
  states.set(page, state);
  page.emulateFocusedPage = (enabled: boolean) => {
    state.requested = enabled;
    return apply(state);
  };
}

function apply(state: RenderingState): Promise<void> {
  const job = state.tail.catch(() => {}).then(async () => {
    const enabled = state.requested || state.leases > 0;
    if (state.applied === enabled) return;
    await state.set(enabled);
    state.applied = enabled;
  });
  state.tail = job;
  return job;
}

export async function withRendering<T>(page: Page, action: () => Promise<T>): Promise<T> {
  installRendering(page);
  const state = states.get(page)!;
  state.leases++;
  let failed = false;
  try {
    await apply(state);
    return await action();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    state.leases--;
    // Use the captured native method even after a script deadline. Cleanup must
    // restore a caller's preference; it must never mask an action's failure.
    try { await apply(state); } catch (error) { if (!failed && !page.isClosed()) throw error; }
  }
}
