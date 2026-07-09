// extension/src/background/debugger-controller.ts

interface CodedError extends Error {
  code?: string;
}

interface DebuggerControllerOptions {
  navigationTimeoutMs?: number;
  activationTimeoutMs?: number;
  commandTimeoutMs?: number;
}

function mapError(err: Error): CodedError {
  const msg = err.message || '';
  if (msg.includes('No tab with id') || msg.includes('No target with given id')) {
    (err as CodedError).code = 'TAB_NOT_FOUND';
  } else if (msg.includes('Another debugger is already attached')) {
    (err as CodedError).code = 'DEBUGGER_ATTACH_FAILED';
  } else if (msg.includes('Element not found')) {
    (err as CodedError).code = 'ELEMENT_NOT_FOUND';
  } else if (msg.includes('Cannot find context with specified id')) {
    (err as CodedError).code = 'TAB_CLOSED';
  } else if (msg.includes('timeout') || msg.includes('timed out')) {
    (err as CodedError).code = 'TIMEOUT';
  }
  return err as CodedError;
}

export class DebuggerController {
  private navigationTimeoutMs: number;
  private activationTimeoutMs: number;
  private commandTimeoutMs: number;

  constructor(options: DebuggerControllerOptions = {}) {
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 1500;
    this.activationTimeoutMs = options.activationTimeoutMs ?? 5000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
  }

  async sendCommand(tabId: number, method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(mapError(new Error(`${method} timed out after ${this.commandTimeoutMs}ms`)));
      }, this.commandTimeoutMs);
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(mapError(new Error(chrome.runtime.lastError.message)));
        } else {
          resolve(result);
        }
      });
    });
  }

  private pageEnabledTabs = new Set<number>();

  async navigate(tabId: number, url: string): Promise<void> {
    if (!this.pageEnabledTabs.has(tabId)) {
      await this.sendCommand(tabId, 'Page.enable');
      this.pageEnabledTabs.add(tabId);
    }
    const navigation = this.waitForNavigationEvent(tabId, this.navigationTimeoutMs);
    const result = await this.sendCommand(tabId, 'Page.navigate', { url });
    await navigation(result?.frameId);
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
    if (!fullPage) {
      // Prefer chrome.tabs.captureVisibleTab to avoid Edge debugger infobar
      // redraw issues triggered by Page.captureScreenshot. Wrap in a timeout
      // so slow/stuck captures fall back to CDP instead of hanging forever.
      try {
        await this.withTimeout(
          chrome.tabs.update(tabId, { active: true }),
          this.activationTimeoutMs,
          'activate tab timeout'
        );
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('captureVisibleTab timeout')), 5000);
          chrome.tabs.captureVisibleTab({ format: 'png' })
            .then((url) => { clearTimeout(timer); resolve(url); })
            .catch((err) => { clearTimeout(timer); reject(err); });
        });
        return dataUrl.replace(/^data:image\/png;base64,/, '');
      } catch (e: any) {
        console.warn('[ARC-TUNNEL-DIAG] captureVisibleTab failed/timed out, falling back to CDP:', e.message);
      }
    }

    const result = await this.sendCommand(tabId, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage
    });
    return result.data;
  }

  private waitForNavigationEvent(tabId: number, timeoutMs: number): (frameId?: string) => Promise<void> {
    let expectedFrameId: string | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveNavigation: () => void = () => {};
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
    };
    const complete = () => {
      cleanup();
      resolveNavigation();
    };
    const listener = (
      source: chrome.debugger.Debuggee,
      method: string,
      params?: Record<string, any>
    ) => {
      if (source.tabId !== tabId) return;
      if (method === 'Page.frameNavigated') {
        const frameId = params?.frame?.id;
        if (!expectedFrameId || frameId === expectedFrameId) complete();
      }
      if (method === 'Page.loadEventFired' || method === 'Page.domContentEventFired') complete();
    };
    chrome.debugger.onEvent.addListener(listener);
    const navigation = new Promise<void>((resolve) => {
      resolveNavigation = resolve;
      timer = setTimeout(complete, timeoutMs);
    });
    return async (frameId?: string) => {
      expectedFrameId = frameId;
      await navigation;
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async executeScript(tabId: number, script: string): Promise<any> {
    const result = await this.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw mapError(new Error(result.exceptionDetails.text || 'Script execution error'));
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
    // Conservative limits to stay within CDP returnByValue payload limits
    const script = `
      JSON.stringify((function() {
        try {
          return {
            title: document.title,
            url: window.location.href,
            text: document.body ? document.body.innerText.substring(0, 50000) : '',
            links: Array.from(document.querySelectorAll('a')).slice(0, 50).map(function(a) {
              return { text: (a.textContent || '').trim().substring(0, 100), href: a.href || '' };
            }),
            forms: Array.from(document.querySelectorAll('form')).slice(0, 10).map(function(f) {
              return {
                id: f.id || '',
                action: f.action || '',
                method: f.method || '',
                fields: Array.from(f.elements).slice(0, 10).map(function(e) {
                  return { name: e.name || '', type: e.type || '' };
                })
              };
            }),
            images: Array.from(document.querySelectorAll('img')).slice(0, 20).map(function(img) {
              return { src: img.src || '', alt: img.alt || '' };
            }),
            headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 30).map(function(h) {
              return { tag: h.tagName.toLowerCase(), text: (h.textContent || '').trim().substring(0, 200) };
            })
          };
        } catch (e) {
          return { error: 'Structured extraction failed: ' + e.message, stack: e.stack || '' };
        }
      })())
    `;
    const result = await this.executeScript(tabId, script);
    if (typeof result === 'string') {
      try {
        return JSON.parse(result);
      } catch {
        return { raw: result };
      }
    }
    return result;
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

  async addBinding(tabId: number, name: string): Promise<void> {
    await this.sendCommand(tabId, 'Runtime.addBinding', { name });
  }

  async removeBinding(tabId: number, name: string): Promise<void> {
    try {
      await this.sendCommand(tabId, 'Runtime.removeBinding', { name });
    } catch {
      // Binding may already be removed — ignore
    }
  }

  async addScriptOnNewDocument(tabId: number, script: string): Promise<void> {
    await this.sendCommand(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source: script });
  }
}
