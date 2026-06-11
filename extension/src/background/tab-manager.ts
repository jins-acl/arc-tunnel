// extension/src/background/tab-manager.ts
import { TabInfo } from '../types';

export class TabManager {
  private tabs: Map<number, TabInfo> = new Map();
  private listenersSetup = false;
  private attachLocks: Map<number, Promise<void>> = new Map();

  async syncExistingTabs(): Promise<void> {
    const existingTabs = await chrome.tabs.query({});
    for (const tab of existingTabs) {
      if (tab.id && !this.tabs.has(tab.id)) {
        this.tabs.set(tab.id, {
          id: tab.id,
          url: tab.url || '',
          title: tab.title || '',
          debuggerAttached: false
        });
      }
    }
    console.log(`Synced ${existingTabs.length} existing tabs`);

    // Setup lifecycle listeners once
    if (!this.listenersSetup) {
      chrome.tabs.onCreated.addListener((tab) => {
        if (tab.id) {
          this.tabs.set(tab.id, {
            id: tab.id,
            url: tab.url || '',
            title: tab.title || '',
            debuggerAttached: false
          });
        }
      });
      chrome.tabs.onRemoved.addListener((tabId) => {
        this.tabs.delete(tabId);
        this.attachLocks.delete(tabId);
      });
      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        const existing = this.tabs.get(tabId);
        if (existing) {
          if (changeInfo.url) existing.url = changeInfo.url;
          if (changeInfo.title) existing.title = changeInfo.title;
        }
      });
      // Keep state in sync when debugger is detached externally
      // (e.g. user clicks "Cancel" on the debugging banner)
      chrome.debugger.onDetach.addListener((source) => {
        const tabInfo = this.tabs.get(source.tabId);
        if (tabInfo) {
          tabInfo.debuggerAttached = false;
        }
        this.attachLocks.delete(source.tabId);
        console.log(`Debugger detached externally from tab ${source.tabId}`);
      });
      this.listenersSetup = true;
    }
  }

  /**
   * Ensure debugger is attached to the tab.
   * Uses a per-tab lock to prevent concurrent attach attempts.
   */
  async ensureDebuggerAttached(tabId: number): Promise<void> {
    if (this.tabs.get(tabId)?.debuggerAttached) {
      return;
    }

    const existingLock = this.attachLocks.get(tabId);
    if (existingLock) {
      return existingLock;
    }

    const lock = this._doAttachDebugger(tabId);
    this.attachLocks.set(tabId, lock);

    try {
      await lock;
    } finally {
      this.attachLocks.delete(tabId);
    }
  }

  private async _doAttachDebugger(tabId: number): Promise<void> {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      const tab = await chrome.tabs.get(tabId);
      this.tabs.set(tabId, {
        id: tabId,
        url: tab.url || '',
        title: tab.title || '',
        debuggerAttached: true
      });
      console.log(`Debugger attached to tab ${tabId}`);
    } catch (error: any) {
      // If debugger is already attached (e.g. after service worker restart),
      // update internal state map instead of erroring
      if (error?.message?.includes('already attached')) {
        try {
          const tab = await chrome.tabs.get(tabId);
          this.tabs.set(tabId, {
            id: tabId,
            url: tab.url || '',
            title: tab.title || '',
            debuggerAttached: true
          });
          console.log(`Debugger already attached to tab ${tabId}, state restored`);
          return;
        } catch (tabError) {
          console.error(`Failed to get tab info for tab ${tabId}:`, tabError);
          throw tabError;
        }
      }
      console.error(`Failed to attach debugger to tab ${tabId}:`, error);
      throw error;
    }
  }

  /** @deprecated Use ensureDebuggerAttached instead */
  async attachDebugger(tabId: number): Promise<void> {
    return this.ensureDebuggerAttached(tabId);
  }

  async detachDebugger(tabId: number): Promise<void> {
    try {
      await chrome.debugger.detach({ tabId });
      const tabInfo = this.tabs.get(tabId);
      if (tabInfo) {
        tabInfo.debuggerAttached = false;
      }
      console.log(`Debugger detached from tab ${tabId}`);
    } catch (error) {
      console.error(`Failed to detach debugger from tab ${tabId}:`, error);
    }
  }

  async createTab(url?: string): Promise<number> {
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id) {
      this.tabs.set(tab.id, {
        id: tab.id,
        url: tab.url || '',
        title: tab.title || '',
        debuggerAttached: false
      });
      return tab.id;
    }
    throw new Error('Failed to create tab');
  }

  async closeTab(tabId: number): Promise<void> {
    await chrome.tabs.remove(tabId);
    this.tabs.delete(tabId);
  }

  listTabs(): TabInfo[] {
    return Array.from(this.tabs.values());
  }

  getTab(tabId: number): TabInfo | undefined {
    return this.tabs.get(tabId);
  }

  isDebuggerAttached(tabId: number): boolean {
    return this.tabs.get(tabId)?.debuggerAttached || false;
  }
}
