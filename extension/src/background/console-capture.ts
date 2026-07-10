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

const CONSOLE_TEXT_LIMIT = 16_384;
// CDP source URLs are diagnostic context only; keep them well below entry text size.
const CONSOLE_SOURCE_LIMIT = 4_096;

function normalizeLevel(level: unknown): string {
  if (level === 'log') return 'info';
  if (level === 'warn') return 'warning';
  return typeof level === 'string' ? level : 'info';
}

function bound(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

export class ConsoleCapture {
  private logs: Map<number, ConsoleLogEntry[]> = new Map();
  private listeners: Map<number, (source: any, method: string, params: any) => void> = new Map();

  async enableForTab(tabId: number, debuggerController?: any): Promise<void> {
    if (!this.listeners.has(tabId)) {
      const handler = (source: any, method: string, params: any) => {
        if (source.tabId === tabId && method === 'Runtime.consoleAPICalled') {
          const text = params.args
            ?.map((argument: any) => argument.value ?? argument.description ?? '')
            .join(' ') || '';
          const sourceUrl = params.stackTrace?.callFrames?.[0]?.url || '';
          const entry: ConsoleLogEntry = {
            level: normalizeLevel(params.type),
            text: bound(String(text), CONSOLE_TEXT_LIMIT),
            source: bound(String(sourceUrl), CONSOLE_SOURCE_LIMIT),
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

    // Runtime.consoleAPICalled requires explicit Runtime.enable.
    if (debuggerController) {
      await debuggerController.sendCommand(tabId, 'Runtime.enable');
    }
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
