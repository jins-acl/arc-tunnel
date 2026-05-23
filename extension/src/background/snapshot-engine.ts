// extension/src/background/snapshot-engine.ts
// Page snapshot using CDP Accessibility domain + backendNodeId targeting

import { DebuggerController } from './debugger-controller';

export interface ElementRef {
  ref: string;
  role: string;
  name: string;
  backendNodeId: number;
  states?: string[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  tree: string;
  refs: Record<string, ElementRef>;
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio',
  'combobox', 'menuitem', 'tab', 'switch', 'slider',
  'searchbox', 'spinbutton', 'option', 'menuitemcheckbox'
]);

export class SnapshotEngine {
  private debuggerController: DebuggerController;
  private cache: Map<number, { snapshot: PageSnapshot; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 5000;

  constructor(debuggerController: DebuggerController) {
    this.debuggerController = debuggerController;
  }

  async getSnapshot(tabId: number, useCache = true): Promise<PageSnapshot> {
    if (useCache) {
      const cached = this.cache.get(tabId);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        return cached.snapshot;
      }
    }

    const snapshot = await this._generateSnapshot(tabId);
    this.cache.set(tabId, { snapshot, timestamp: Date.now() });
    return snapshot;
  }

  invalidateCache(tabId?: number): void {
    if (tabId !== undefined) {
      this.cache.delete(tabId);
    } else {
      this.cache.clear();
    }
  }

  resolveRef(snapshot: PageSnapshot, ref: string): ElementRef | null {
    return snapshot.refs[ref] || null;
  }

  private async _generateSnapshot(tabId: number): Promise<PageSnapshot> {
    // Enable Accessibility and DOM domains
    await this.debuggerController.sendCommand(tabId, 'Accessibility.enable');
    await this.debuggerController.sendCommand(tabId, 'DOM.enable');

    // Get full accessibility tree (automatically穿透 iframe + shadow DOM)
    const { nodes } = await this.debuggerController.sendCommand(
      tabId, 'Accessibility.getFullAXTree'
    ) as { nodes: any[] };

    const tab = await chrome.tabs.get(tabId);

    let counter = 0;
    const refs: Record<string, ElementRef> = {};
    const lines: string[] = [];

    for (const node of nodes) {
      if (node.ignored) continue;

      const role = node.role?.value;
      if (!role || !INTERACTIVE_ROLES.has(role)) continue;

      const backendNodeId = node.backendDOMNodeId;
      if (!backendNodeId) continue; // Skip nodes without a DOM backing

      counter++;
      const ref = `e${counter}`;
      const name = node.name?.value || '';
      const states = this._extractStates(node);

      refs[ref] = { ref, role, name, backendNodeId, states };

      const stateStr = states.length ? ` [${states.join(',')}]` : '';
      lines.push(`- [${ref}] ${role}: "${name}"${stateStr}`);
    }

    return {
      url: tab.url || '',
      title: tab.title || '',
      tree: lines.join('\n'),
      refs
    };
  }

  private _extractStates(node: any): string[] {
    const states: string[] = [];
    for (const prop of node.properties || []) {
      if (prop.name === 'checked' && prop.value?.value) {
        states.push('checked');
      }
      if (prop.name === 'disabled' && prop.value?.value) {
        states.push('disabled');
      }
      if (prop.name === 'expanded' && prop.value?.value !== undefined) {
        states.push(prop.value.value ? 'expanded' : 'collapsed');
      }
      if (prop.name === 'selected' && prop.value?.value) {
        states.push('selected');
      }
    }
    return states;
  }
}
