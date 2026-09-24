import { beforeEach, expect, it, vi } from "vitest";
import { TabManager } from "../services/TabManager";
import { CDPRouter } from "../services/CDPRouter";

const attach = vi.fn(), detach = vi.fn(), command = vi.fn(), group = vi.fn();
const logger = {log: vi.fn(), debug: vi.fn(), error: vi.fn()};
let tabs: TabManager, router: CDPRouter, send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('chrome', {debugger: {attach, detach, sendCommand: command}, tabs:{group}, tabGroups:{get:vi.fn(),update:vi.fn()}});
  attach.mockResolvedValue(undefined); detach.mockResolvedValue(undefined); group.mockResolvedValue(7);
  command.mockImplementation(async ({tabId}) => ({targetInfo:{targetId:'target-'+tabId,type:'page',url:'https://example.org/child'}}));
  send = vi.fn(); tabs = new TabManager({logger,sendMessage:send}); router = new CDPRouter({logger,tabManager:tabs});
  tabs.set(1, {state:'connected',sessionId:'parent',targetId:'target-1'});
});

it('adopts only a managed opener child, once under concurrent events', async () => {
  await router.adoptPopup({id:3, openerTabId:99} as chrome.tabs.Tab);
  await router.adoptPopup({id:4} as chrome.tabs.Tab);
  expect(attach).not.toHaveBeenCalled();
  await Promise.all([router.adoptPopup({id:2,openerTabId:1} as chrome.tabs.Tab),router.adoptPopup({id:2,openerTabId:1} as chrome.tabs.Tab)]);
  expect(attach).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
  expect(tabs.getByTargetId('target-2')?.tabId).toBe(2);
});

it('late attachment cannot resurrect a disconnected session', async () => {
  let finish!: () => void;
  attach.mockImplementation(() => new Promise<void>(r => finish=r));
  const job = router.adoptPopup({id:2,openerTabId:1} as chrome.tabs.Tab);
  await Promise.resolve(); tabs.detachAll(); finish();
  await expect(job).rejects.toThrow('cancelled');
  expect(tabs.has(2)).toBe(false); expect(send).not.toHaveBeenCalled();
  expect(detach).toHaveBeenCalledWith({tabId:2});
});

it('a child closed during attach stays absent', async () => {
  let finish!: () => void;
  attach.mockImplementation(() => new Promise<void>(r => finish=r));
  const job = router.adoptPopup({id:2,openerTabId:1} as chrome.tabs.Tab);
  await Promise.resolve(); tabs.detach(2,false); finish();
  await expect(job).rejects.toThrow('cancelled'); expect(send).not.toHaveBeenCalled();
});

it('OOP iframe Runtime.enable keeps its child CDP session', async () => {
  tabs.trackChildSession('oop-frame',1);
  await router.handleCommand({id:1,method:'forwardCDPCommand',params:{method:'Runtime.enable',sessionId:'oop-frame'}});
  expect(command).toHaveBeenCalledExactlyOnceWith({tabId:1,sessionId:'oop-frame'},'Runtime.enable',undefined);
});

it('a popup in another window remains attached if grouping is unavailable', async () => {
  group.mockRejectedValue(new Error('Cannot group this window'));
  await router.adoptPopup({id:2,openerTabId:1} as chrome.tabs.Tab);
  expect(tabs.has(2)).toBe(true); expect(send).toHaveBeenCalledTimes(1);
});

it('an initially empty popup URL is discoverable and later navigation preserves its opener', async () => {
  command.mockResolvedValue({targetInfo:{targetId:'child',type:'page',url:'',title:''}});
  await router.adoptPopup({id:2,openerTabId:1} as chrome.tabs.Tab);
  expect(send.mock.calls[0]![0].params.params.targetInfo).toMatchObject({url:'about:blank',openerId:'target-1'});
  tabs.update(2,{url:'https://example.org/result',title:'Result'});
  expect(send.mock.lastCall![0].params).toMatchObject({method:'Target.targetInfoChanged',params:{targetInfo:{targetId:'child',url:'https://example.org/result',openerId:'target-1'}}});
  tabs.detach(2,false); send.mockClear(); tabs.update(2,{url:'https://example.org/late'});
  expect(send).not.toHaveBeenCalled();
});
