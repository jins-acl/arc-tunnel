// extension/src/background/tab-manager.ts
import { TabInfo } from '../types';

export class TabManager {
  private tabs: Map<number, TabInfo> = new Map();
  private listenersSetup = false;
  private attachLocks: Map<number, Promise<void>> = new Map();

  async syncExistingTabs(): Promise<void> {
    const existingTabs = await chrome.tabs.query({});
    // Query real debugger state from the browser instead of assuming false
    let attachedTabIds: Set<number> = new Set();
    try {
      const targets = await chrome.debugger.getTargets();
      attachedTabIds = new Set(targets.filter(t => t.attached).map(t => t.tabId));
    } catch (e) {
      console.warn('Failed to get debugger targets:', e);
    }

    for (const tab of existingTabs) {
      if (tab.id && !this.tabs.has(tab.id)) {
        const hasDebugger = attachedTabIds.has(tab.id);
        this.tabs.set(tab.id, {
          id: tab.id,
          url: tab.url || '',
          title: tab.title || '',
          debuggerAttached: hasDebugger
        });
      }
    }
    console.log(`Synced ${existingTabs.length} existing tabs, ${attachedTabIds.size} with debugger attached`);

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
      chrome.debugger.onDetach.addListener((source, reason) => {
        const tabInfo = this.tabs.get(source.tabId);
        if (tabInfo) {
          tabInfo.debuggerAttached = false;
        }
        this.attachLocks.delete(source.tabId);
        // eslint-disable-next-line no-console
        console.log(`%c[ARC-TUNNEL-DIAG] ❌ Debugger DETACHED from tab ${source.tabId}, reason=${reason}`, 'color:#e67e22;font-size:14px;font-weight:bold;');
      });
      this.listenersSetup = true;
    }
  }

  /**
   * Check whether debugger is actually attached to the tab by asking Chrome directly.
   * This is more reliable than our internal Map after a service worker restart.
   */
  private async _isDebuggerActuallyAttached(tabId: number): Promise<boolean> {
    try {
      const targets = await chrome.debugger.getTargets();
      return targets.some(t => t.tabId === tabId && t.attached);
    } catch (e) {
      return false;
    }
  }

  /**
   * Ensure debugger is attached to the tab.
   * Uses a per-tab lock to prevent concurrent attach attempts.
   */
  async ensureDebuggerAttached(tabId: number): Promise<void> {
    // Fast path: check internal state first
    if (this.tabs.get(tabId)?.debuggerAttached) {
      return;
    }

    const existingLock = this.attachLocks.get(tabId);
    if (existingLock) {
      return existingLock;
    }

    console.log(`[ARC-TUNNEL-DIAG] ensureDebuggerAttached called for tab ${tabId}`);
    const lock = this._doAttachDebugger(tabId);
    this.attachLocks.set(tabId, lock);

    try {
      await lock;
    } finally {
      this.attachLocks.delete(tabId);
    }
  }

  private async _doAttachDebugger(tabId: number): Promise<void> {
    // Before trying to attach, ask Chrome directly if debugger is already there.
    // This avoids the "already attached" error path entirely, which may trigger
    // Chrome/Edge to redraw the infobar and cause ghosting.
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

    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      const tab = await chrome.tabs.get(tabId);
      this.tabs.set(tabId, {
        id: tabId,
        url: tab.url || '',
        title: tab.title || '',
        debuggerAttached: true
      });
      // eslint-disable-next-line no-console
      console.log(`%c[ARC-TUNNEL-DIAG] ⛓️ Debugger ATTACHED to tab ${tabId} — infobar should appear now`, 'color:#e74c3c;font-size:14px;font-weight:bold;');
    } catch (error: any) {
      // Defensive fallback: if attach fails with "already attached",
      // sync state and return without throwing.
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
