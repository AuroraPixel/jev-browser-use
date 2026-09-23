import { AsyncLocalStorage } from "node:async_hooks";
import type { Page } from "puppeteer-core";
const owners = new WeakMap<Page, symbol>();
const context = new AsyncLocalStorage<symbol>();
export function assertJevAvailable(page: Page): void {
  const owner = owners.get(page);
  if (owner && context.getStore() !== owner) throw new Error("This page is running Jev; wait for its current call or stop the session first");
}
export async function withJevLock<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  if (owners.has(page)) throw new Error("This page already has an active Jev call");
  const owner = Symbol("jev");
  owners.set(page, owner);
  try { return await context.run(owner, fn); } finally { owners.delete(page); }
}
