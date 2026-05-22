// extension/src/background/snapshot-engine.ts
// Page snapshot with Ref-based element targeting

import { DebuggerController } from './debugger-controller';

export interface ElementRef {
  ref: string;
  role: string;
  name: string;
  selector: string;
  box?: { x: number; y: number; width: number; height: number };
}

export interface PageSnapshot {
  url: string;
  title: string;
  tree: string;
  refs: Record<string, ElementRef>;
}

export class SnapshotEngine {
  private debuggerController: DebuggerController;
  private cache: Map<number, { snapshot: PageSnapshot; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 5000;

  constructor(debuggerController: DebuggerController) {
    this.debuggerController = debuggerController;
  }

  async getSnapshot(tabId: number, depth = 10, includeBoxes = false, useCache = true): Promise<PageSnapshot> {
    if (useCache) {
      const cached = this.cache.get(tabId);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        return cached.snapshot;
      }
    }

    const snapshot = await this._generateSnapshot(tabId, depth, includeBoxes);
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

  private async _generateSnapshot(tabId: number, depth = 10, includeBoxes = false): Promise<PageSnapshot> {
    const script = `
      (function() {
        const MAX_DEPTH = ${depth};
        const MAX_ELEMENTS = 100;
        const refs = {};
        let counter = 0;

        function isInteractive(el) {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' || tag === 'select') return true;
          if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio' || role === 'textbox' || role === 'combobox') return true;
          if (el.onclick || el.getAttribute('onclick')) return true;
          return false;
        }

        function getName(el) {
          return (el.getAttribute('aria-label') ||
                  el.getAttribute('title') ||
                  el.getAttribute('placeholder') ||
                  (el.textContent || '').trim()).substring(0, 100);
        }

        function getRole(el) {
          return el.getAttribute('role') || el.tagName.toLowerCase();
        }

        function buildSelector(el) {
          if (el.id && !/^\\d/.test(el.id) && el.id.length < 36) return '#' + CSS.escape(el.id);
          const testId = el.getAttribute('data-testid');
          if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
          const path = [];
          let curr = el;
          while (curr && curr.nodeType === 1 && path.length < 5) {
            let tag = curr.tagName.toLowerCase();
            if (curr.className && typeof curr.className === 'string') {
              const classes = curr.className.trim().split(/\\s+/).slice(0, 3);
              if (classes.length) tag += '.' + classes.map(c => CSS.escape(c)).join('.');
            }
            path.unshift(tag);
            curr = curr.parentElement;
          }
          return path.join(' > ');
        }

        function walk(el, depth) {
          if (depth > MAX_DEPTH || counter >= MAX_ELEMENTS) return '';
          const interactive = isInteractive(el);
          let result = '';

          if (interactive) {
            counter++;
            const ref = 'e' + counter;
            const role = getRole(el);
            const name = getName(el);
            const selector = buildSelector(el);
            const box = el.getBoundingClientRect();
            refs[ref] = {
              ref, role, name, selector,
              box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
            };
            result += '- [' + ref + '] ' + role + ': "' + name + '"\\n';
          }

          for (let child of el.children) {
            const childResult = walk(child, depth + 1);
            if (childResult) {
              result += childResult;
            }
          }
          return result;
        }

        const tree = walk(document.body, 0);
        return {
          url: window.location.href,
          title: document.title,
          tree,
          refs
        };
      })()
    `;

    const result = await this.debuggerController.executeScript(tabId, script);
    if (!result || typeof result !== 'object') {
      throw new Error('Failed to generate snapshot');
    }

    const snapshot: PageSnapshot = {
      url: result.url || '',
      title: result.title || '',
      tree: result.tree || '',
      refs: result.refs || {}
    };

    if (!includeBoxes) {
      // Strip box data to reduce payload
      for (const key of Object.keys(snapshot.refs)) {
        delete (snapshot.refs[key] as any).box;
      }
    }

    return snapshot;
  }

  resolveRef(snapshot: PageSnapshot, ref: string): string | null {
    return snapshot.refs[ref]?.selector || null;
  }
}
