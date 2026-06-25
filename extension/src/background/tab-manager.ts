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
        // Only record state; never actively attach debugger during sync.
        this.tabs.set(tab.id, {
          id: tab.id,
          url: tab.url || '',
          title: tab.title || '',
          debuggerAttached: false
        });
      } else if (tab.id && this.tabs.has(tab.id)) {
        // Update existing tab metadata, preserve debuggerAttached state.
        const existing = this.tabs.get(tab.id)!;
        existing.url = tab.url || '';
        existing.title = tab.title || '';
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
      chrome.debugger.onDetach.addListener((source) => {
        const tabInfo = this.tabs.get(source.tabId);
        if (tabInfo) {
          tabInfo.debuggerAttached = false;
        }
        this.attachLocks.delete(source.tabId);
        console.log(`[ARC-TUNNEL-DIAG] ❌ Debugger DETACHED from tab ${source.tabId}, reason=${source.reason}`);
      });
      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        const existing = this.tabs.get(tabId);
        if (existing) {
          if (changeInfo.url) existing.url = changeInfo.url;
          if (changeInfo.title) existing.title = changeInfo.title;
        }
      });
      this.listenersSetup = true;
    }
  }

  /**
   * Ensure debugger is attached to the tab.
   * Uses a per-tab lock to prevent concurrent attach attempts.
   * Lock is checked BEFORE any async operation to eliminate the race window.
   */
  async ensureDebuggerAttached(tabId: number): Promise<void> {
    // 1. Fast path: check in-memory state
    if (this.tabs.get(tabId)?.debuggerAttached) {
      return;
    }

    // 2. Check and immediately SET lock — eliminates the race window
    const existingLock = this.attachLocks.get(tabId);
    if (existingLock) {
      return existingLock;
    }

    // Create deferred lock immediately so concurrent calls wait on it
    let resolveLock: () => void;
    const lockPromise = new Promise<void>(resolve => { resolveLock = resolve; });
    this.attachLocks.set(tabId, lockPromise);

    try {
      // 3. Async check: query real browser state
      const alreadyAttached = await this._isDebuggerActuallyAttached(tabId);
      if (alreadyAttached) {
        const tab = await chrome.tabs.get(tabId);
        this.tabs.set(tabId, {
          id: tabId,
          url: tab.url || '',
          title: tab.title || '',
          debuggerAttached: true
        });
        console.log(`[ARC-TUNNEL-DIAG] Debugger already attached to tab ${tabId}, skipping attach`);
        return;
      }

      // 4. Proceed with attach
      console.log(`[ARC-TUNNEL-DIAG] ensureDebuggerAttached called for tab ${tabId}`);
      await this._doAttachDebugger(tabId);
    } finally {
      this.attachLocks.delete(tabId);
      resolveLock!();
    }
  }

  private async _isDebuggerActuallyAttached(tabId: number): Promise<boolean> {
    try {
      const targets = await chrome.debugger.getTargets();
      return targets.some(t => t.tabId === tabId && t.attached);
    } catch (e) {
      return false;
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
      console.log(`[ARC-TUNNEL-DIAG] ⛓️ Debugger ATTACHED to tab ${tabId} — infobar should appear now`);
    } catch (error: any) {
      if (error?.message?.includes('already attached')) {
        try {
          const tab = await chrome.tabs.get(tabId);
          this.tabs.set(tabId, {
            id: tabId,
            url: tab.url || '',
            title: tab.title || '',
            debuggerAttached: true
          });
          console.log(`[ARC-TUNNEL-DIAG] Debugger already attached to tab ${tabId}, state restored`);
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

  async detachDebugger(tabId: number): Promise<void> {
    try {
      await chrome.debugger.detach({ tabId });
      const tabInfo = this.tabs.get(tabId);
      if (tabInfo) {
        tabInfo.debuggerAttached = false;
      }
      this.attachLocks.delete(tabId);
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
