// extension/src/background/input-simulator.ts
// Real physical input simulation via CDP Input domain

import { DebuggerController } from './debugger-controller';

export class InputSimulator {
  private debuggerController: DebuggerController;

  constructor(debuggerController: DebuggerController) {
    this.debuggerController = debuggerController;
  }

  private async getElementCenter(tabId: number, selector: string): Promise<{ x: number; y: number }> {
    const safeSelector = JSON.stringify(selector);
    const script = `
      (function() {
        const el = document.querySelector(${safeSelector});
        if (!el) throw new Error('Element not found: ' + ${safeSelector});
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2 + window.scrollX,
          y: rect.top + rect.height / 2 + window.scrollY
        };
      })()
    `;
    const result = await this.debuggerController.executeScript(tabId, script);
    return { x: Math.round(result.x), y: Math.round(result.y) };
  }

  async dispatchClick(tabId: number, selector: string, doubleClick = false): Promise<void> {
    const { x, y } = await this.getElementCenter(tabId, selector);
    const clickCount = doubleClick ? 2 : 1;

    await this.debuggerController.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x, y
    });
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x, y,
      button: 'left',
      clickCount
    });
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x, y,
      button: 'left',
      clickCount
    });
  }

  async dispatchDoubleClick(tabId: number, selector: string): Promise<void> {
    await this.dispatchClick(tabId, selector, true);
  }

  async dispatchHover(tabId: number, selector: string): Promise<void> {
    const { x, y } = await this.getElementCenter(tabId, selector);
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x, y
    });
  }

  async dispatchType(tabId: number, selector: string, text: string): Promise<void> {
    // Focus element first
    const safeSelector = JSON.stringify(selector);
    const focusScript = `
      (function() {
        const el = document.querySelector(${safeSelector});
        if (!el) throw new Error('Element not found: ' + ${safeSelector});
        el.focus();
        return true;
      })()
    `;
    await this.debuggerController.executeScript(tabId, focusScript);

    // Type each character via CDP Input domain
    for (const char of text) {
      await this.debuggerController.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char
      });
      await this.debuggerController.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char
      });
    }
  }

  async dispatchPress(tabId: number, key: string): Promise<void> {
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key
    });
    await this.debuggerController.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key
    });
  }

  async dispatchCheck(tabId: number, selector: string, checked: boolean): Promise<void> {
    const safeSelector = JSON.stringify(selector);
    const script = `
      (function() {
        const el = document.querySelector(${safeSelector});
        if (!el) throw new Error('Element not found: ' + ${safeSelector});
        if (el.type !== 'checkbox' && el.type !== 'radio') {
          throw new Error('Element is not a checkbox or radio: ' + ${safeSelector});
        }
        if (el.checked !== ${checked}) {
          el.click();
        }
        return { checked: el.checked };
      })()
    `;
    await this.debuggerController.executeScript(tabId, script);
  }
}
