// extension/src/background/actionability-checker.ts
// Wait for element to be actionable using backendNodeId + CDP

import { DebuggerController } from './debugger-controller';

export class ActionabilityChecker {
  private debuggerController: DebuggerController;

  constructor(debuggerController: DebuggerController) {
    this.debuggerController = debuggerController;
  }

  async waitForActionable(tabId: number, backendNodeId: number, timeout = 5000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // 1. Check existence and size via DOM.getBoxModel
        const { model } = await this.debuggerController.sendCommand(
          tabId, 'DOM.getBoxModel', { backendNodeId }
        ) as { model: { content: number[] } };

        const c = model.content;
        const width = Math.abs(c[2] - c[0]);
        const height = Math.abs(c[5] - c[1]);
        if (width === 0 || height === 0) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        // 2. Check enabled/visibility state via Runtime.callFunctionOn
        const { nodeId } = await this.debuggerController.sendCommand(
          tabId, 'DOM.requestNode', { backendNodeId }
        ) as { nodeId: number };

        const { object } = await this.debuggerController.sendCommand(
          tabId, 'DOM.resolveNode', { nodeId }
        ) as { object: { objectId: string } };

        const result = await this.debuggerController.sendCommand(tabId, 'Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function() {
            const el = this;
            if (el.disabled) return { state: 'disabled' };
            const style = window.getComputedStyle(el);
            if (style.display === 'none') return { state: 'hidden', reason: 'display:none' };
            if (style.visibility === 'hidden') return { state: 'hidden', reason: 'visibility:hidden' };
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return { state: 'hidden', reason: 'zero size' };
            return { state: 'ready' };
          }`,
          returnByValue: true
        }) as any;

        const state = result.result?.value?.state;
        if (state === 'ready') {
          return;
        }
        if (state === 'disabled') {
          throw new Error(`Element is disabled`);
        }
      } catch (err: any) {
        // If DOM.getBoxModel fails, element doesn't exist yet — keep waiting
        if (err.message?.includes('Could not find node')) {
          // Continue waiting
        } else if (err.message?.includes('disabled')) {
          throw err;
        }
      }

      await new Promise(r => setTimeout(r, 100));
    }

    throw new Error(`Element did not become actionable within ${timeout}ms`);
  }
}
