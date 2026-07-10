// extension/src/background/lightweight-controller.ts

import type { ConsoleLogEntry } from './console-capture';

type StructuredContent = {
  title: string;
  url: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{
    id: string;
    action: string;
    method: string;
    fields: Array<{ name: string; type: string }>;
  }>;
  images: Array<{ src: string; alt: string }>;
  headings: Array<{ tag: string; text: string }>;
};

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
  return descriptor.value;
}

export class LightweightController {
  async getConsoleLogs(
    tabId: number
  ): Promise<{ installed: boolean; logs: ConsoleLogEntry[] }> {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const bufferDescriptor = Object.getOwnPropertyDescriptor(
          globalThis,
          Symbol.for('arc-tunnel.console-buffer.v1')
        );
        if (!bufferDescriptor || !Object.prototype.hasOwnProperty.call(bufferDescriptor, 'value')) {
          return { installed: false, logs: [] };
        }
        const state = bufferDescriptor.value;
        if (state === null || typeof state !== 'object' || Array.isArray(state)) {
          return { installed: false, logs: [] };
        }
        const logsDescriptor = Object.getOwnPropertyDescriptor(state, 'logs');
        if (!logsDescriptor || !Object.prototype.hasOwnProperty.call(logsDescriptor, 'value') ||
            !Array.isArray(logsDescriptor.value)) {
          return { installed: false, logs: [] };
        }
        return { installed: true, logs: logsDescriptor.value.slice() };
      }
    });

    const injection = results[0] as (chrome.scripting.InjectionResult & { error?: string }) | undefined;
    if (!injection) throw new Error('Console history injection returned no result entry');
    if (injection.error) throw new Error(`Console history injection failed: ${injection.error}`);

    const envelope = injection.result;
    if (!isPlainObject(envelope) || Reflect.ownKeys(envelope).length !== 2) {
      throw new Error('Console history injection returned a malformed result envelope');
    }
    const installed = ownDataValue(envelope, 'installed');
    const logs = ownDataValue(envelope, 'logs');
    if (typeof installed !== 'boolean' || !Array.isArray(logs)) {
      throw new Error('Console history injection returned a malformed result envelope');
    }

    const validatedLogs = logs.map((candidate): ConsoleLogEntry => {
      if (!isPlainObject(candidate)) {
        throw new Error('Console history injection returned a malformed log entry');
      }
      const level = ownDataValue(candidate, 'level');
      const text = ownDataValue(candidate, 'text');
      const source = ownDataValue(candidate, 'source');
      const timestamp = ownDataValue(candidate, 'timestamp');
      const line = ownDataValue(candidate, 'line');
      const column = ownDataValue(candidate, 'column');
      if (typeof level !== 'string' || typeof text !== 'string' || typeof source !== 'string' ||
          typeof timestamp !== 'number' || !Number.isFinite(timestamp) ||
          (line !== undefined && typeof line !== 'number') ||
          (column !== undefined && typeof column !== 'number')) {
        throw new Error('Console history injection returned a malformed log entry');
      }
      return {
        level,
        text,
        source,
        timestamp,
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column })
      };
    });

    return { installed, logs: validatedLogs };
  }

  async executeScript(tabId: number, script: string): Promise<any> {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (source: string) => {
        const safeString = String;
        const fallbackError = 'Script evaluation failed';
        try {
          return { ok: true, value: (0, eval)(source) };
        } catch (error) {
          let formattedError = fallbackError;
          try {
            if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
              const name = (error as { name?: unknown }).name;
              const message = (error as { message?: unknown }).message;
              if (typeof name === 'string' && typeof message === 'string') {
                formattedError = `${name}: ${message}`;
              } else {
                formattedError = safeString(error);
              }
            } else {
              formattedError = safeString(error);
            }
            if (!formattedError) formattedError = fallbackError;
          } catch {
            formattedError = fallbackError;
          }
          return { ok: false, error: formattedError };
        }
      },
      args: [script]
    });

    const injection = results[0] as (chrome.scripting.InjectionResult & { error?: string }) | undefined;
    if (!injection) throw new Error('Lightweight script injection returned no result entry');
    if (injection.error) throw new Error(`Lightweight script injection failed: ${injection.error}`);
    const envelope = injection.result;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new Error('Lightweight script injection returned a malformed result envelope');
    }
    const prototype = Object.getPrototypeOf(envelope);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Lightweight script injection returned a malformed result envelope');
    }
    const keys = Reflect.ownKeys(envelope);
    const okDescriptor = Object.getOwnPropertyDescriptor(envelope, 'ok');
    if (!okDescriptor || !Object.prototype.hasOwnProperty.call(okDescriptor, 'value') || typeof okDescriptor.value !== 'boolean') {
      throw new Error('Lightweight script injection returned a malformed result envelope');
    }
    if (okDescriptor.value) {
      if (keys.some(key => key !== 'ok' && key !== 'value') || keys.length > 2) {
        throw new Error('Lightweight script injection returned a malformed result envelope');
      }
      const valueDescriptor = Object.getOwnPropertyDescriptor(envelope, 'value');
      if (keys.includes('value') && (!valueDescriptor || !Object.prototype.hasOwnProperty.call(valueDescriptor, 'value'))) {
        throw new Error('Lightweight script injection returned a malformed result envelope');
      }
      return valueDescriptor?.value;
    }
    if (keys.length !== 2 || !keys.includes('ok') || !keys.includes('error')) {
      throw new Error('Lightweight script injection returned a malformed error envelope');
    }
    const errorDescriptor = Object.getOwnPropertyDescriptor(envelope, 'error');
    if (!errorDescriptor || !Object.prototype.hasOwnProperty.call(errorDescriptor, 'value') || typeof errorDescriptor.value !== 'string') {
      throw new Error('Lightweight script injection returned a malformed error envelope');
    }
    throw new Error(`Lightweight script evaluation failed: ${errorDescriptor.value || 'Script evaluation failed'}`);
  }

  async getContent(tabId: number, mode: string): Promise<any> {
    switch (mode) {
      case 'html':
        return await this.executeScript(tabId, 'document.documentElement.outerHTML');
      case 'text':
        return await this.executeScript(tabId, 'document.body ? document.body.innerText : ""');
      case 'structured':
        return await this.getStructuredContent(tabId);
      case 'markdown':
        return await this.getMarkdownContent(tabId);
      default:
        throw new Error(`Unknown mode: ${mode}`);
    }
  }

  async waitForElement(tabId: number, selector: string, timeout: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const exists = await this.executeScript(
        tabId,
        `document.querySelector(${JSON.stringify(selector)}) !== null`
      );
      if (exists) return true;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
  }

  private async getStructuredContent(tabId: number): Promise<StructuredContent> {
    return await this.executeScript(tabId, `
      (function() {
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
      })()
    `);
  }

  private async getMarkdownContent(tabId: number): Promise<string> {
    return await this.executeScript(tabId, `
      (function() {
        var md = '# ' + document.title + '\\n\\n';
        var bodyText = document.body ? document.body.innerText : '';
        md += bodyText.substring(0, 500000);
        return md;
      })()
    `);
  }
}
