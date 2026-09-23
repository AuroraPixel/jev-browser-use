import { expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { installRendering, withRendering } from "../../src/page/rendering.ts";

function fixture() {
  const changes: boolean[] = [];
  const page = { emulateFocusedPage: async (enabled: boolean) => { changes.push(enabled); }, isClosed: () => false } as unknown as Page;
  installRendering(page);
  return { page, changes };
}

test("rendering leases restore focus on success, failure and preserve caller overrides", async () => {
  const { page, changes } = fixture();
  await withRendering(page, () => withRendering(page, async () => expect(changes).toEqual([true])));
  expect(changes).toEqual([true, false]);
  await expect(withRendering(page, async () => { throw Error("cancelled"); })).rejects.toThrow("cancelled");
  expect(changes).toEqual([true, false, true, false]);
  await page.emulateFocusedPage(true);
  await withRendering(page, async () => {});
  expect(changes.at(-1)).toBe(true);
  await withRendering(page, async () => {
    await page.emulateFocusedPage(false);
    expect(changes.at(-1)).toBe(true);
  });
  expect(changes.at(-1)).toBe(false);
});

test("overlapping rendering leases cannot disable another active caller's frames", async () => {
  const { page, changes } = fixture();
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>(r => release = r), entered = new Promise<void>(r => ready = r);
  const first = withRendering(page, async () => { ready(); await gate; });
  await entered;
  await withRendering(page, async () => {});
  expect(changes).toEqual([true]);
  release();
  await first;
  expect(changes).toEqual([true, false]);
});
