// extension/src/background/debugger-controller.ts
export class DebuggerController {
  async sendCommand(tabId: number, method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  }

  async navigate(tabId: number, url: string): Promise<void> {
    await this.sendCommand(tabId, 'Page.navigate', { url });
    await this.sendCommand(tabId, 'Page.enable');
  }

  async click(tabId: number, selector: string): Promise<void> {
    const safeSelector = JSON.stringify(selector);
    const script = `
      (function() {
        const element = document.querySelector(${safeSelector});
        if (!element) throw new Error('Element not found: ' + ${safeSelector});
        element.scrollIntoView({ behavior: 'instant', block: 'center' });
        element.click();
        return true;
      })()
    `;
    await this.executeScript(tabId, script);
  }

  async type(tabId: number, selector: string, text: string): Promise<void> {
    const safeSelector = JSON.stringify(selector);
    const safeText = JSON.stringify(text);
    const script = `
      (function() {
        const element = document.querySelector(${safeSelector});
        if (!element) throw new Error('Element not found: ' + ${safeSelector});
        element.focus();
        element.value = ${safeText};
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `;
    await this.executeScript(tabId, script);
  }

  async screenshot(tabId: number, fullPage: boolean = false): Promise<string> {
    const result = await this.sendCommand(tabId, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage
    });
    return result.data;
  }

  async executeScript(tabId: number, script: string): Promise<any> {
    const result = await this.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Script execution error');
    }
    return result.result?.value;
  }

  async getContent(tabId: number, mode: string): Promise<any> {
    switch (mode) {
      case 'html':
        return await this.executeScript(tabId, 'document.documentElement.outerHTML');
      case 'text':
        return await this.executeScript(tabId, 'document.body.innerText');
      case 'structured':
        return await this.getStructuredContent(tabId);
      case 'markdown':
        return await this.getMarkdownContent(tabId);
      default:
        throw new Error(`Unknown mode: ${mode}`);
    }
  }

  private async getStructuredContent(tabId: number): Promise<any> {
    const script = `
      (function() {
        return {
          title: document.title,
          url: window.location.href,
          text: document.body ? document.body.innerText.substring(0, 100000) : '',
          links: Array.from(document.querySelectorAll('a')).slice(0, 500).map(a => ({
            text: (a.textContent || '').trim().substring(0, 200),
            href: a.href || ''
          })),
          forms: Array.from(document.querySelectorAll('form')).slice(0, 50).map(f => ({
            id: f.id || '',
            action: f.action || '',
            method: f.method || '',
            fields: Array.from(f.elements).slice(0, 100).map(e => ({
              name: (e as any).name || '',
              type: (e as any).type || ''
            }))
          })),
          images: Array.from(document.querySelectorAll('img')).slice(0, 200).map(img => ({
            src: img.src || '',
            alt: img.alt || ''
          })),
          headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 200).map(h => ({
            tag: h.tagName.toLowerCase(),
            text: (h.textContent || '').trim().substring(0, 500)
          }))
        };
      })()
    `;
    return await this.executeScript(tabId, script);
  }

  private async getMarkdownContent(tabId: number): Promise<string> {
    const script = `
      (function() {
        var md = '# ' + document.title + '\\n\\n';
        var bodyText = document.body ? document.body.innerText : '';
        md += bodyText.substring(0, 500000);
        return md;
      })()
    `;
    return await this.executeScript(tabId, script);
  }

  async waitForElement(tabId: number, selector: string, timeout: number = 10000): Promise<boolean> {
    const safeSelector = JSON.stringify(selector);
    const script = `
      (function() {
        var el = document.querySelector(${safeSelector});
        return el !== null;
      })()
    `;
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const exists = await this.executeScript(tabId, script);
      if (exists) return true;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
  }
}
