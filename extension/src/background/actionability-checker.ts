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
        // Check existence and size via DOM.getBoxModel.
        // If the element is display:none, getBoxModel fails with "Could not find node".
        // If visibility:hidden, getBoxModel succeeds but the element is still in layout.
        const { model } = await this.debuggerController.sendCommand(
          tabId, 'DOM.getBoxModel', { backendNodeId }
        ) as { model: { content: number[] } };

        const c = model.content;
        const width = Math.abs(c[2] - c[0]);
        const height = Math.abs(c[5] - c[1]);
        if (width > 0 && height > 0) {
          return;
        }
      } catch (err: any) {
        if (err.message?.includes('Could not find node')) {
          // Element doesn't exist yet — keep waiting
        } else {
          throw err;
        }
      }

      await new Promise(r => setTimeout(r, 100));
    }

    throw new Error(`Element did not become actionable within ${timeout}ms`);
  }
}
