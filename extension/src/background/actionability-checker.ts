// extension/src/background/actionability-checker.ts
// Wait for element to be actionable (attached, visible, stable, enabled)

import { DebuggerController } from './debugger-controller';

export class ActionabilityChecker {
  private debuggerController: DebuggerController;

  constructor(debuggerController: DebuggerController) {
    this.debuggerController = debuggerController;
  }

  async waitForActionable(tabId: number, selector: string, timeout = 5000): Promise<void> {
    const safeSelector = JSON.stringify(selector);
    const script = `
      (function() {
        const el = document.querySelector(${safeSelector});
        if (!el) return { state: 'not_found' };

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        // Check visibility
        if (style.display === 'none') return { state: 'hidden', reason: 'display:none' };
        if (style.visibility === 'hidden') return { state: 'hidden', reason: 'visibility:hidden' };
        if (rect.width === 0 || rect.height === 0) return { state: 'hidden', reason: 'zero size' };

        // Check enabled
        if ('disabled' in el && (el as HTMLInputElement).disabled) {
          return { state: 'disabled' };
        }

        return { state: 'ready' };
      })()
    `;

    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const result = await this.debuggerController.executeScript(tabId, script);
      if (result && result.state === 'ready') {
        return;
      }
      if (result && result.state === 'disabled') {
        throw new Error(`Element ${selector} is disabled`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Element ${selector} did not become actionable within ${timeout}ms`);
  }
}
