/**
 * TabManager - Manages tab state and debugger attachment.
 */

import type { TabInfo, TargetInfo } from "../utils/types";
import type { Logger } from "../utils/logger";

export type SendMessageFn = (message: unknown) => void;

export interface TabManagerDeps {
  logger: Logger;
  sendMessage: SendMessageFn;
}

export class TabManager {
  private tabs = new Map<number, TabInfo>();
  private childSessions = new Map<string, number>(); // sessionId -> parentTabId
  private targetInfos = new Map<number, TargetInfo>();
  private nextSessionId = 1;
  private epoch = 0;
  private attaching = new Map<number, Promise<TargetInfo>>();
  private logger: Logger;
  private sendMessage: SendMessageFn;

  constructor(deps: TabManagerDeps) {
    this.logger = deps.logger;
    this.sendMessage = deps.sendMessage;
  }

  /**
   * Get tab info by session ID.
   */
  getBySessionId(sessionId: string): { tabId: number; tab: TabInfo } | undefined {
    for (const [tabId, tab] of this.tabs) {
      if (tab.sessionId === sessionId) {
        return { tabId, tab };
      }
    }
    return undefined;
  }

  /**
   * Get tab info by target ID.
   */
  getByTargetId(targetId: string): { tabId: number; tab: TabInfo } | undefined {
    for (const [tabId, tab] of this.tabs) {
      if (tab.targetId === targetId) {
        return { tabId, tab };
      }
    }
    return undefined;
  }

  /**
   * Get parent tab ID for a child session (iframe, worker).
   */
  getParentTabId(sessionId: string): number | undefined {
    return this.childSessions.get(sessionId);
  }

  /**
   * Get tab info by tab ID.
   */
  get(tabId: number): TabInfo | undefined {
    return this.tabs.get(tabId);
  }

  /**
   * Check if a tab is tracked.
   */
  has(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  /**
   * Set tab info (used for intermediate states like "connecting").
   */
  set(tabId: number, info: TabInfo): void {
    this.tabs.set(tabId, info);
  }

  /**
   * Track a child session (iframe, worker).
   */
  trackChildSession(sessionId: string, parentTabId: number): void {
    this.logger.debug("Child target attached:", sessionId, "for tab:", parentTabId);
    this.childSessions.set(sessionId, parentTabId);
  }

  /**
   * Untrack a child session.
   */
  untrackChildSession(sessionId: string): void {
    this.logger.debug("Child target detached:", sessionId);
    this.childSessions.delete(sessionId);
  }

  /**
   * Attach debugger to a tab and register it.
   */
  async attach(tabId: number, allowed: () => boolean = () => true, openerId?: string): Promise<TargetInfo> {
    const pending = this.attaching.get(tabId);
    if (pending) return pending;
    if (this.tabs.get(tabId)?.state === "connected") {
      const info = await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo") as { targetInfo: TargetInfo };
      return info.targetInfo;
    }
    const epoch = this.epoch;
    const valid = () => epoch === this.epoch && this.attaching.get(tabId) === job && allowed();
    const job = Promise.resolve().then(() => this.attachOnce(tabId, valid, openerId));
    this.attaching.set(tabId, job);
    try { return await job; }
    finally { if (this.attaching.get(tabId) === job) this.attaching.delete(tabId); }
  }

  private async attachOnce(tabId: number, allowed: () => boolean, openerId?: string): Promise<TargetInfo> {
    const debuggee = { tabId };
    if (!allowed()) throw new Error("Tab attachment cancelled");
    this.logger.debug("Attaching debugger to tab:", tabId);
    await chrome.debugger.attach(debuggee, "1.3");
    let result: { targetInfo: TargetInfo };
    try {
      if (!allowed()) throw new Error("Tab attachment cancelled");
      result = await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo") as { targetInfo: TargetInfo };
      if (!allowed()) throw new Error("Tab attachment cancelled");
    } catch (error) {
      await chrome.debugger.detach(debuggee).catch(() => {});
      throw error;
    }

    // A popup may be registered before its first navigation. A blank URL keeps
    // Puppeteer waiting for target initialization, so Page.enable never runs.
    const targetInfo = { ...result.targetInfo, url: result.targetInfo.url || "about:blank",
      ...(openerId ? { openerId } : {}) };
    this.targetInfos.set(tabId, targetInfo);
    const sessionId = `pw-tab-${this.nextSessionId++}`;

    this.tabs.set(tabId, {
      sessionId,
      targetId: targetInfo.targetId,
      state: "connected",
    });

    // Notify relay of new target
    this.sendMessage({
      method: "forwardCDPEvent",
      params: {
        method: "Target.attachedToTarget",
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    });

    this.logger.log("Tab attached:", tabId, "sessionId:", sessionId, "url:", targetInfo.url);
    return targetInfo;
  }

  update(tabId: number, change: { url?: string; title?: string }): void {
    const info = this.targetInfos.get(tabId);
    if (!info || (!change.url && change.title === undefined)) return;
    const targetInfo = { ...info, ...(change.url ? { url: change.url } : {}), ...(change.title !== undefined ? { title: change.title } : {}) };
    this.targetInfos.set(tabId, targetInfo);
    this.sendMessage({ method: "forwardCDPEvent", params: { method: "Target.targetInfoChanged", params: { targetInfo } } });
  }

  /**
   * Detach a tab and clean up.
   */
  detach(tabId: number, shouldDetachDebugger: boolean): void {
    this.attaching.delete(tabId);
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    this.logger.debug("Detaching tab:", tabId);

    this.sendMessage({
      method: "forwardCDPEvent",
      params: {
        method: "Target.detachedFromTarget",
        params: { sessionId: tab.sessionId, targetId: tab.targetId },
      },
    });

    this.tabs.delete(tabId);
    this.targetInfos.delete(tabId);

    // Clean up child sessions
    for (const [childSessionId, parentTabId] of this.childSessions) {
      if (parentTabId === tabId) {
        this.childSessions.delete(childSessionId);
      }
    }

    if (shouldDetachDebugger) {
      chrome.debugger.detach({ tabId }).catch((err) => {
        this.logger.debug("Error detaching debugger:", err);
      });
    }
  }

  /**
   * Handle debugger detach event from Chrome.
   */
  handleDebuggerDetach(tabId: number): void {
    this.attaching.delete(tabId);
    if (!this.tabs.has(tabId)) return;

    const tab = this.tabs.get(tabId);
    if (tab) {
      this.sendMessage({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: tab.sessionId, targetId: tab.targetId },
        },
      });
    }

    // Clean up child sessions
    for (const [childSessionId, parentTabId] of this.childSessions) {
      if (parentTabId === tabId) {
        this.childSessions.delete(childSessionId);
      }
    }

    this.tabs.delete(tabId);
    this.targetInfos.delete(tabId);
  }

  /**
   * Clear all tabs and child sessions.
   */
  clear(): void {
    this.epoch++;
    this.attaching.clear();
    this.tabs.clear();
    this.targetInfos.clear();
    this.childSessions.clear();
  }

  /**
   * Detach all tabs (used on disconnect).
   */
  detachAll(): void {
    for (const tabId of this.tabs.keys()) {
      chrome.debugger.detach({ tabId }).catch(() => {});
    }
    this.clear();
  }

  /**
   * Get all tab IDs.
   */
  getAllTabIds(): number[] {
    return Array.from(this.tabs.keys());
  }
}
