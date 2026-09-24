/**
 * CDPRouter - Routes CDP commands to the correct tab.
 */

import type { Logger } from "../utils/logger";
import type { TabManager } from "./TabManager";
import type { ExtensionCommandMessage, TabInfo } from "../utils/types";

export interface CDPRouterDeps {
  logger: Logger;
  tabManager: TabManager;
}

export class CDPRouter {
  private logger: Logger;
  private tabManager: TabManager;
  private jevBrowserUseGroupId: number | null = null;

  constructor(deps: CDPRouterDeps) {
    this.logger = deps.logger;
    this.tabManager = deps.tabManager;
  }

  /** Adopt only children of a currently managed tab. Unrelated user tabs stay private. */
  async adoptPopup(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.id === undefined || tab.openerTabId === undefined) return;
    const parent = this.tabManager.get(tab.openerTabId);
    if (parent?.state !== "connected") return;
    const allowed = () => this.tabManager.get(tab.openerTabId!) === parent;
    await this.tabManager.attach(tab.id, allowed, parent.targetId);
    if (!allowed()) { this.tabManager.detach(tab.id, true); return; }
    // Popups in separate windows cannot always join the existing tab group.
    try { await this.getOrCreateJevBrowserUseGroup(tab.id); }
    catch (error) { this.logger.debug("Popup attached without grouping:", error); }
  }

  /**
   * Gets or creates the "jev-browser-use" tab group, returning its ID.
   */
  private async getOrCreateJevBrowserUseGroup(tabId: number): Promise<number> {
    // If we have a cached group ID, verify it still exists
    if (this.jevBrowserUseGroupId !== null) {
      try {
        await chrome.tabGroups.get(this.jevBrowserUseGroupId);
        // Group exists, add tab to it
        await chrome.tabs.group({ tabIds: [tabId], groupId: this.jevBrowserUseGroupId });
        return this.jevBrowserUseGroupId;
      } catch {
        // Group no longer exists, reset cache
        this.jevBrowserUseGroupId = null;
      }
    }

    // Create a new group with this tab
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, {
      title: "jev-browser-use",
      color: "blue",
    });
    this.jevBrowserUseGroupId = groupId;
    return groupId;
  }

  /**
   * Handle an incoming CDP command from the relay.
   */
  async handleCommand(msg: ExtensionCommandMessage): Promise<unknown> {
    if (msg.method !== "forwardCDPCommand") return;

    let targetTabId: number | undefined;
    let targetTab: TabInfo | undefined;

    // Find target tab by sessionId
    if (msg.params.sessionId) {
      const found = this.tabManager.getBySessionId(msg.params.sessionId);
      if (found) {
        targetTabId = found.tabId;
        targetTab = found.tab;
      }
    }

    // Check child sessions (iframes, workers)
    if (!targetTab && msg.params.sessionId) {
      const parentTabId = this.tabManager.getParentTabId(msg.params.sessionId);
      if (parentTabId) {
        targetTabId = parentTabId;
        targetTab = this.tabManager.get(parentTabId);
        this.logger.debug(
          "Found parent tab for child session:",
          msg.params.sessionId,
          "tabId:",
          parentTabId
        );
      }
    }

    // Find by targetId in params
    if (
      !targetTab &&
      msg.params.params &&
      typeof msg.params.params === "object" &&
      "targetId" in msg.params.params
    ) {
      const found = this.tabManager.getByTargetId(msg.params.params.targetId as string);
      if (found) {
        targetTabId = found.tabId;
        targetTab = found.tab;
      }
    }

    const debuggee = targetTabId ? { tabId: targetTabId } : undefined;

    // Handle special commands
    switch (msg.params.method) {
      case "Runtime.enable": {
        if (!debuggee) {
          throw new Error(
            `No debuggee found for Runtime.enable (sessionId: ${msg.params.sessionId})`
          );
        }
        if (msg.params.sessionId && msg.params.sessionId !== targetTab?.sessionId) {
          return await chrome.debugger.sendCommand({ ...debuggee, sessionId: msg.params.sessionId }, "Runtime.enable", msg.params.params);
        }
        // Disable and re-enable to reset state
        try {
          await chrome.debugger.sendCommand(debuggee, "Runtime.disable");
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch {
          // Ignore errors
        }
        return await chrome.debugger.sendCommand(debuggee, "Runtime.enable", msg.params.params);
      }

      case "Target.createTarget": {
        const url = (msg.params.params?.url as string) || "about:blank";
        this.logger.debug("Creating new tab with URL:", url);
        const tab = await chrome.tabs.create({ url, active: false });
        if (!tab.id) throw new Error("Failed to create tab");

        // Add tab to "jev-browser-use" group
        await this.getOrCreateJevBrowserUseGroup(tab.id);

        await new Promise((resolve) => setTimeout(resolve, 100));
        const targetInfo = await this.tabManager.attach(tab.id);
        return { targetId: targetInfo.targetId };
      }

      case "Target.closeTarget": {
        if (!targetTabId) {
          this.logger.log(`Target not found: ${msg.params.params?.targetId}`);
          return { success: false };
        }
        await chrome.tabs.remove(targetTabId);
        return { success: true };
      }

      case "Target.activateTarget": {
        if (!targetTabId) {
          this.logger.log(`Target not found for activation: ${msg.params.params?.targetId}`);
          return {};
        }
        await chrome.tabs.update(targetTabId, { active: true });
        return {};
      }
    }

    if (!debuggee || !targetTab) {
      throw new Error(
        `No tab found for method ${msg.params.method} sessionId: ${msg.params.sessionId}`
      );
    }

    this.logger.debug("CDP command:", msg.params.method, "for tab:", targetTabId);

    const debuggerSession: chrome.debugger.DebuggerSession = {
      ...debuggee,
      sessionId: msg.params.sessionId !== targetTab.sessionId ? msg.params.sessionId : undefined,
    };

    return await chrome.debugger.sendCommand(debuggerSession, msg.params.method, msg.params.params);
  }

  /**
   * Handle debugger events from Chrome.
   */
  handleDebuggerEvent(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params: unknown,
    sendMessage: (msg: unknown) => void
  ): void {
    const tab = source.tabId ? this.tabManager.get(source.tabId) : undefined;
    if (!tab) return;

    this.logger.debug("Forwarding CDP event:", method, "from tab:", source.tabId);

    // Track child sessions
    if (
      method === "Target.attachedToTarget" &&
      params &&
      typeof params === "object" &&
      "sessionId" in params
    ) {
      const sessionId = (params as { sessionId: string }).sessionId;
      this.tabManager.trackChildSession(sessionId, source.tabId!);
    }

    if (
      method === "Target.detachedFromTarget" &&
      params &&
      typeof params === "object" &&
      "sessionId" in params
    ) {
      const sessionId = (params as { sessionId: string }).sessionId;
      this.tabManager.untrackChildSession(sessionId);
    }

    sendMessage({
      method: "forwardCDPEvent",
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    });
  }
}
