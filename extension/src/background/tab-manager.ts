// extension/src/background/tab-manager.ts
import { TabInfo } from '../types';

const SESSION_KEY = 'arc_tunnel_debugger_tabs';

export class TabManager {
  private tabs: Map<number, TabInfo> = new Map();
  private listenersSetup = false;
  private attachLocks: Map<number, Promise<void>> = new Map();

  /** Load persisted debugger-attach state from chrome.storage.session.
   *  MV3 service workers lose in-memory Maps on suspension;
   *  session storage survives SW restarts but is cleared when the browser closes. */
  private async _loadSessionState(): Promise<Set<number>> {
    try {
      const result = await chrome.storage.session.get(SESSION_KEY);
      const stored = result[SESSION_KEY];
      if (Array.isArray(stored)) {
        return new Set(stored as number[]);
      }
    } catch {
      // storage.session may be unavailable in older browsers — fall back to empty
    }
    return new Set();
  }

  private async _saveSessionState(tabId: number, attached: boolean): Promise<void> {
    try {
      const result = await chrome.storage.session.get(SESSION_KEY);
      const stored = new Set<number>(Array.isArray(result[SESSION_KEY]) ? result[SESSION_KEY] as number[] : []);
      if (attached) {
        stored.add(tabId);
      } else {
        stored.delete(tabId);
      }
      await chrome.storage.session.set({ [SESSION_KEY]: Array.from(stored) });
    } catch {
      // ignore
    }
  }

  async syncExistingTabs(): Promise<void> {
    const existingTabs = await chrome.tabs.query({});
    const sessionAttached = await this._loadSessionState();

    // Query real debugger state from the browser instead of assuming false
    let attachedTabIds: Set<number> = new Set();
    try {
      const targets = await chrome.debugger.getTargets();
      attachedTabIds = new Set(targets.filter(t => t.attached).map(t => t.tabId).filter((id): id is number => id !== undefined));
    } catch (e) {
      console.warn('Failed to get debugger targets:', e);
    }

    // Reconcile: trust getTargets() over session state, but use session state
    // as a fallback when getTargets() is temporarily empty after SW restart.
    const reconciled = new Set<number>(attachedTabIds);
    if (attachedTabIds.size === 0 && sessionAttached.size > 0) {
      // getTargets() sometimes returns stale/empty data immediately after SW wakeup.
      // Do a functional ping on each session-stored tab to verify.
      for (const tabId of sessionAttached) {
        if (await this._pingDebugger(tabId)) {
          reconciled.add(tabId);
        }
      }
    }

    for (const tab of existingTabs) {
      if (tab.id && !this.tabs.has(tab.id)) {
        const hasDebugger = reconciled.has(tab.id);
        this.tabs.set(tab.id, {
          id: tab.id,
          url: tab.url || '',
          title: tab.title || '',
          debuggerAttached: hasDebugger
        });
      }
    }
    console.log(`Synced ${existingTabs.length} existing tabs, ${reconciled.size} with debugger attached`);

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
        this._saveSessionState(tabId, false);
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
        this._saveSessionState(source.tabId, false);
        // eslint-disable-next-line no-console
        console.log(`%c[ARC-TUNNEL-DIAG] ❌ Debugger DETACHED from tab ${source.tabId}, reason=${reason}`, 'color:#e67e22;font-size:14px;font-weight:bold;');
      });
      this.listenersSetup = true;
    }
  }

  /**
   * Functional ping: send a harmless CDP command to verify the debugger
   * connection is alive. This is more robust than getTargets() after a SW restart.
   */
  private async _pingDebugger(tabId: number): Promise<boolean> {
    return new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' }, (result) => {
        if (chrome.runtime.lastError) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Check whether debugger is actually attached to the tab by asking Chrome directly.
   * Uses both getTargets() and a functional ping for maximum reliability.
   */
  private async _isDebuggerActuallyAttached(tabId: number): Promise<boolean> {
    try {
      const targets = await chrome.debugger.getTargets();
      if (targets.some(t => t.tabId === tabId && t.attached)) {
        return true;
      }
    } catch (e) {
      // Fall through to functional test
    }

    // getTargets() can return stale data immediately after SW restart.
    // A functional ping is the ground-truth check.
    return this._pingDebugger(tabId);
  }

  /**
   * Ensure debugger is attached to the tab.
   * Uses a per-tab lock to prevent concurrent attach attempts.
   */
  async ensureDebuggerAttached(tabId: number): Promise<void> {
    // Fast path 1: check in-memory state
    if (this.tabs.get(tabId)?.debuggerAttached) {
      return;
    }

    // Fast path 2: check if another call is already attaching (prevent race)
    let existingLock = this.attachLocks.get(tabId);
    if (existingLock) {
      return existingLock;
    }

    // Fast path 3: check persisted session state (survives SW restarts)
    const sessionAttached = await this._loadSessionState();
    if (sessionAttached.has(tabId)) {
      // Verify with a functional ping before trusting session state
      if (await this._pingDebugger(tabId)) {
        const tab = await chrome.tabs.get(tabId);
        this.tabs.set(tabId, {
          id: tabId,
          url: tab.url || '',
          title: tab.title || '',
          debuggerAttached: true
        });
        console.log(`[ARC-TUNNEL-DIAG] Debugger already attached to tab ${tabId} (session state + ping), skipping attach`);
        return;
      }
      // Ping failed — session state is stale, clear it
      await this._saveSessionState(tabId, false);
    }

    // Double-check lock after async operations above
    existingLock = this.attachLocks.get(tabId);
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
    // Double-check with functional ping before attempting attach.
    // This is the critical guard against ghosting: we must NEVER call
    // chrome.debugger.attach() when a debugger is already connected,
    // because Edge may redraw the infobar even if attach() throws.
    if (await this._pingDebugger(tabId)) {
      const tab = await chrome.tabs.get(tabId);
      this.tabs.set(tabId, {
        id: tabId,
        url: tab.url || '',
        title: tab.title || '',
        debuggerAttached: true
      });
      await this._saveSessionState(tabId, true);
      console.log(`[ARC-TUNNEL-DIAG] Debugger already attached to tab ${tabId} (ping), skipping attach`);
      return;
    }

    try {
      await chrome.debugger.attach({ tabId }, '1.3');

      // Wait a short beat for Chrome/Edge to finish painting the debugger infobar
      // before subsequent CDP commands trigger compositor re-rasterization.
      await new Promise(r => setTimeout(r, 300));

      const tab = await chrome.tabs.get(tabId);
      this.tabs.set(tabId, {
        id: tabId,
        url: tab.url || '',
        title: tab.title || '',
        debuggerAttached: true
      });
      await this._saveSessionState(tabId, true);
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
          await this._saveSessionState(tabId, true);
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
      await this._saveSessionState(tabId, false);
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
    await this._saveSessionState(tabId, false);
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

  /** Detach debugger from all tabs that we think are attached.
   *  Called when the WebSocket disconnects so the user doesn't see
   *  stale "being debugged" banners after the MCP server goes away. */
  async detachAllDebuggers(): Promise<void> {
    const attachedTabs = Array.from(this.tabs.entries())
      .filter(([, info]) => info.debuggerAttached)
      .map(([id]) => id);

    if (attachedTabs.length === 0) {
      // Also check session storage in case in-memory state was lost
      const sessionAttached = await this._loadSessionState();
      attachedTabs.push(...Array.from(sessionAttached));
    }

    for (const tabId of attachedTabs) {
      try {
        await chrome.debugger.detach({ tabId });
        const tabInfo = this.tabs.get(tabId);
        if (tabInfo) {
          tabInfo.debuggerAttached = false;
        }
        await this._saveSessionState(tabId, false);
        console.log(`[ARC-TUNNEL-DIAG] Auto-detached debugger from tab ${tabId} on disconnect`);
      } catch (error) {
        // Tab may already be closed or debugger already detached — ignore
      }
    }
  }
}
