// extension/src/background/input-simulator.ts
// Real physical input simulation via CDP Input domain + backendNodeId positioning

import { DebuggerController } from './debugger-controller';

export class InputSimulator {
  private debuggerController: DebuggerController;

  constructor(debuggerController: DebuggerController) {
    this.debuggerController = debuggerController;
  }

  // Get element center via DOM.getBoxModel + backendNodeId
  // Automatically穿透 iframe / Shadow DOM
  private async getElementCenter(tabId: number, backendNodeId: number): Promise<{ x: number; y: number }> {
    const { model } = await this.debuggerController.sendCommand(
      tabId, 'DOM.getBoxModel', { backendNodeId }
    ) as { model: { content: number[] } };

    const c = model.content;
    // content: [x1,y1, x2,y2, x3,y3, x4,y4]
    return {
      x: Math.round((c[0] + c[2] + c[4] + c[6]) / 4),
      y: Math.round((c[1] + c[3] + c[5] + c[7]) / 4)
    };
  }

  async dispatchClick(tabId: number, backendNodeId: number, doubleClick = false): Promise<void> {
    // 1. Scroll element into view
    await this.debuggerController.sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });

    // 2. Get coordinate
    const { x, y } = await this.getElementCenter(tabId, backendNodeId);
    const clickCount = doubleClick ? 2 : 1;

    // 3. CDP physical click (in render layer, automatically穿透 iframe)
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y
    });
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount
    });
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount
    });
  }

  async dispatchDoubleClick(tabId: number, backendNodeId: number): Promise<void> {
    await this.dispatchClick(tabId, backendNodeId, true);
  }

  async dispatchHover(tabId: number, backendNodeId: number): Promise<void> {
    await this.debuggerController.sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const { x, y } = await this.getElementCenter(tabId, backendNodeId);
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y
    });
  }

  async dispatchType(tabId: number, backendNodeId: number, text: string): Promise<void> {
    // 1. Focus element via DOM.focus (works with backendNodeId)
    await this.debuggerController.sendCommand(tabId, 'DOM.focus', { backendNodeId });

    // 2. Use Input.insertText — more reliable than per-character keyDown/keyUp
    // for plain text, and correctly triggers React/Vue controlled components
    await this.debuggerController.sendCommand(tabId, 'Input.insertText', { text });
  }

  async dispatchPress(tabId: number, key: string): Promise<void> {
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key
    });
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key
    });
  }

  async dispatchCheck(tabId: number, backendNodeId: number, checked: boolean): Promise<void> {
    // Get nodeId from backendNodeId first
    const { nodeId } = await this.debuggerController.sendCommand(
      tabId, 'DOM.requestNode', { backendNodeId }
    ) as { nodeId: number };

    // Resolve to runtime object
    const { object } = await this.debuggerController.sendCommand(
      tabId, 'DOM.resolveNode', { nodeId }
    ) as { object: { objectId: string } };

    // Call function on the element to check/uncheck
    const result = await this.debuggerController.sendCommand(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(checked) {
        const el = this;
        if (el.type !== 'checkbox' && el.type !== 'radio') {
          throw new Error('Element is not a checkbox or radio');
        }
        if (el.checked !== checked) {
          el.click();
        }
        return { checked: el.checked };
      }`,
      arguments: [{ value: checked }],
      returnByValue: true
    }) as any;

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Check operation failed');
    }
  }
}
