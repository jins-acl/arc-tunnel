// extension/src/background/console-capture.ts
// Capture browser console logs via CDP Runtime.consoleAPICalled

export interface ConsoleLogEntry {
  level: string;
  text: string;
  source: string;
  line?: number;
  column?: number;
  timestamp: number;
}

export class ConsoleCapture {
  private logs: Map<number, ConsoleLogEntry[]> = new Map();
  private listeners: Map<number, (source: any, method: string, params: any) => void> = new Map();

  async enableForTab(tabId: number, debuggerController?: any): Promise<void> {
    // Runtime.consoleAPICalled requires explicit Runtime.enable
    if (debuggerController) {
      try {
        await debuggerController.sendCommand(tabId, 'Runtime.enable');
      } catch {
        // Runtime may already be enabled — ignore
      }
    }

    if (this.listeners.has(tabId)) return;

    const handler = (source: any, method: string, params: any) => {
      if (method === 'Runtime.consoleAPICalled') {
        const entry: ConsoleLogEntry = {
          level: params.type || 'log',
          text: params.args?.map((a: any) => a.value || a.description || '').join(' ') || '',
          source: params.stackTrace?.callFrames?.[0]?.url || '',
          line: params.stackTrace?.callFrames?.[0]?.lineNumber,
          column: params.stackTrace?.callFrames?.[0]?.columnNumber,
          timestamp: Date.now()
        };

        if (!this.logs.has(tabId)) {
          this.logs.set(tabId, []);
        }
        this.logs.get(tabId)!.push(entry);

        // Keep only last 500 entries per tab
        const tabLogs = this.logs.get(tabId)!;
        if (tabLogs.length > 500) {
          tabLogs.splice(0, tabLogs.length - 500);
        }
      }
    };

    chrome.debugger.onEvent.addListener(handler);
    this.listeners.set(tabId, handler);
  }

  disableForTab(tabId: number): void {
    const handler = this.listeners.get(tabId);
    if (handler) {
      chrome.debugger.onEvent.removeListener(handler);
      this.listeners.delete(tabId);
    }
    this.logs.delete(tabId);
  }

  getLogs(tabId: number, minLevel?: string): ConsoleLogEntry[] {
    const tabLogs = this.logs.get(tabId) || [];
    if (!minLevel) return [...tabLogs];

    const levels = ['debug', 'info', 'warning', 'error'];
    const minIdx = levels.indexOf(minLevel);
    if (minIdx === -1) return [...tabLogs];

    return tabLogs.filter(log => levels.indexOf(log.level) >= minIdx);
  }

  clearLogs(tabId: number): void {
    this.logs.set(tabId, []);
  }
}
