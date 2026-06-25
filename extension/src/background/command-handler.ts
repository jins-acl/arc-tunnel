// extension/src/background/command-handler.ts
import { CommandMessage, ResponseMessage } from '../types';
import { TabManager } from './tab-manager';
import { DebuggerController } from './debugger-controller';
import { RecordingEngine } from './recording-engine';
import { PlaybackEngine } from './playback-engine';
import { SessionManager } from './session-manager';
import { SnapshotEngine } from './snapshot-engine';
import { InputSimulator } from './input-simulator';
import { ActionabilityChecker } from './actionability-checker';
import { ConsoleCapture } from './console-capture';
import { StorageManager } from './storage-manager';
import { LightweightController } from './lightweight-controller';

export class CommandHandler {
  private snapshotEngine: SnapshotEngine;
  private inputSimulator: InputSimulator;
  private actionabilityChecker: ActionabilityChecker;
  private recordingDebuggerTabId: number | null = null;

  constructor(
    private tabManager: TabManager,
    private debuggerController: DebuggerController,
    private recordingEngine: RecordingEngine,
    private playbackEngine: PlaybackEngine,
    private sessionManager: SessionManager,
    private consoleCapture: ConsoleCapture,
    private storageManager: StorageManager,
    private lightweightController: LightweightController
  ) {
    this.snapshotEngine = new SnapshotEngine(debuggerController);
    this.inputSimulator = new InputSimulator(debuggerController);
    this.actionabilityChecker = new ActionabilityChecker(debuggerController);
  }

  async handleCommand(command: CommandMessage): Promise<ResponseMessage> {
    try {
      const result = await this.executeCommand(command);
      return {
        id: command.id,
        type: 'response',
        success: true,
        result
      };
    } catch (error: any) {
      return {
        id: command.id,
        type: 'response',
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: error.message || 'Unknown error'
        }
      };
    }
  }

  private async executeCommand(command: CommandMessage): Promise<any> {
    const { command: cmd, params } = command;

    switch (cmd) {
      // ─── Core tools (Playwright-inspired) ───

      case 'snapshot': {
        const snapshot = await this.runWithDebugger(params.tabId, 'snapshot', () =>
          this.snapshotEngine.getSnapshot(params.tabId, true)
        );
        return { snapshot };
      }

      case 'interact': {
        await this.ensureDebuggerAttached(params.tabId);
        try {

        let backendNodeId: number | null = null;
        const target = params.target as string;

        // press action does not need a target element
        if (params.action !== 'press') {
          if (!target || !(target.startsWith('e') && /^e\d+$/.test(target))) {
            throw new Error(
              `Target must be a ref (e.g. "e15") from a snapshot. CSS selectors are no longer supported.`
            );
          }
          backendNodeId = await this.resolveRef(params.tabId, target);
          if (!backendNodeId) {
            throw new Error(`Ref ${target} not found in snapshot. Run snapshot first.`);
          }
          await this.actionabilityChecker.waitForActionable(
            params.tabId, backendNodeId, params.timeout
          );
        }

        switch (params.action) {
          case 'click':
            await this.inputSimulator.dispatchClick(params.tabId, backendNodeId!);
            break;
          case 'double_click':
            await this.inputSimulator.dispatchDoubleClick(params.tabId, backendNodeId!);
            break;
          case 'hover':
            await this.inputSimulator.dispatchHover(params.tabId, backendNodeId!);
            break;
          case 'type':
            if (!params.text) throw new Error('text is required for type action');
            await this.inputSimulator.dispatchType(params.tabId, backendNodeId!, params.text);
            break;
          case 'press':
            if (!params.key) throw new Error('key is required for press action');
            await this.inputSimulator.dispatchPress(params.tabId, params.key);
            break;
          case 'check':
            await this.inputSimulator.dispatchCheck(params.tabId, backendNodeId!, true);
            break;
          case 'uncheck':
            await this.inputSimulator.dispatchCheck(params.tabId, backendNodeId!, false);
            break;
          default:
            throw new Error(`Unknown interact action: ${params.action}`);
        }

        // Hover does not mutate the DOM — skip cache invalidation for efficiency
        if (params.action !== 'hover') {
          this.snapshotEngine.invalidateCache(params.tabId);
        }
        const pageSnapshot = await this.snapshotEngine.getSnapshot(params.tabId, params.action === 'hover');
        return { status: params.action, target, pageSnapshot };
        } finally {
          this.tabManager.scheduleDebuggerDetach(params.tabId, 'interact');
        }
      }

      case 'navigate': {
        return await this.runWithDebugger(params.tabId, 'navigate', async () => {
          switch (params.action) {
            case 'goto':
              if (!params.url) throw new Error('url is required for goto action');
              await this.debuggerController.navigate(params.tabId, params.url);
              this.snapshotEngine.invalidateCache(params.tabId);
              return { status: 'navigated', url: params.url };
            case 'go_back': {
              const history = await this.debuggerController.sendCommand(
                params.tabId, 'Page.getNavigationHistory'
              );
              if (history.currentIndex > 0) {
                const entry = history.entries[history.currentIndex - 1];
                await this.debuggerController.sendCommand(
                  params.tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id }
                );
                this.snapshotEngine.invalidateCache(params.tabId);
                return { status: 'went_back', url: entry.url };
              }
              return { status: 'went_back', url: null };
            }
            case 'go_forward': {
              const history = await this.debuggerController.sendCommand(
                params.tabId, 'Page.getNavigationHistory'
              );
              if (history.currentIndex < history.entries.length - 1) {
                const entry = history.entries[history.currentIndex + 1];
                await this.debuggerController.sendCommand(
                  params.tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id }
                );
                this.snapshotEngine.invalidateCache(params.tabId);
                return { status: 'went_forward', url: entry.url };
              }
              return { status: 'went_forward', url: null };
            }
            case 'reload':
              await this.debuggerController.sendCommand(params.tabId, 'Page.reload');
              this.snapshotEngine.invalidateCache(params.tabId);
              return { status: 'reloaded' };
            default:
              throw new Error(`Unknown navigate action: ${params.action}`);
          }
        });
      }

      case 'get_console_logs': {
        const logs = await this.runWithDebugger(params.tabId, 'get_console_logs', async () => {
          await this.consoleCapture.enableForTab(params.tabId, this.debuggerController);
          return this.consoleCapture.getLogs(params.tabId, params.minLevel);
        });
        return { logs };
      }

      case 'manage_storage': {
        const { type, action: storageAction } = params;
        switch (type) {
          case 'cookie': {
            switch (storageAction) {
              case 'list':
                return { cookies: await this.storageManager.listCookies(params.tabId, params.filterDomain) };
              case 'get':
                return { cookie: await this.storageManager.getCookie(params.tabId, params.key) };
              case 'set':
                await this.storageManager.setCookie(params.tabId, params.key, params.value, params.options);
                return { status: 'cookie_set' };
              case 'delete':
                await this.storageManager.deleteCookie(params.tabId, params.key);
                return { status: 'cookie_deleted' };
              case 'clear':
                await this.storageManager.clearCookies(params.tabId);
                return { status: 'cookies_cleared' };
              default:
                throw new Error(`Unknown cookie action: ${storageAction}`);
            }
          }
          case 'local_storage': {
            switch (storageAction) {
              case 'list':
                return { entries: await this.storageManager.listStorage(params.tabId, 'local') };
              case 'get':
                return { value: await this.storageManager.getStorageItem(params.tabId, 'local', params.key) };
              case 'set':
                await this.storageManager.setStorageItem(params.tabId, 'local', params.key, params.value);
                return { status: 'local_storage_set' };
              case 'delete':
                await this.storageManager.deleteStorageItem(params.tabId, 'local', params.key);
                return { status: 'local_storage_deleted' };
              case 'clear':
                await this.storageManager.clearStorage(params.tabId, 'local');
                return { status: 'local_storage_cleared' };
              default:
                throw new Error(`Unknown local_storage action: ${storageAction}`);
            }
          }
          case 'session_storage': {
            switch (storageAction) {
              case 'list':
                return { entries: await this.storageManager.listStorage(params.tabId, 'session') };
              case 'get':
                return { value: await this.storageManager.getStorageItem(params.tabId, 'session', params.key) };
              case 'set':
                await this.storageManager.setStorageItem(params.tabId, 'session', params.key, params.value);
                return { status: 'session_storage_set' };
              case 'delete':
                await this.storageManager.deleteStorageItem(params.tabId, 'session', params.key);
                return { status: 'session_storage_deleted' };
              case 'clear':
                await this.storageManager.clearStorage(params.tabId, 'session');
                return { status: 'session_storage_cleared' };
              default:
                throw new Error(`Unknown session_storage action: ${storageAction}`);
            }
          }
          default:
            throw new Error(`Unknown storage type: ${type}`);
        }
      }

      // ─── Utility & legacy tools ───

      case 'screenshot': {
        if (params.fullPage) {
          const screenshot = await this.runWithDebugger(params.tabId, 'screenshot.fullPage', () =>
            this.debuggerController.screenshot(params.tabId, params.fullPage)
          );
          return { screenshot };
        }

        let screenshot: string;
        try {
          screenshot = await this.debuggerController.screenshot(params.tabId, params.fullPage);
        } catch (error) {
          if (params.fullPage) {
            throw error;
          }
          screenshot = await this.runWithDebugger(params.tabId, 'screenshot.fallback', () =>
            this.debuggerController.screenshot(params.tabId, params.fullPage)
          );
        }
        return { screenshot };
      }

      case 'execute_script': {
        const scriptResult = await this.runLightweightFirst(
          params.tabId,
          'execute_script',
          () => this.lightweightController.executeScript(params.tabId, params.script),
          () => this.debuggerController.executeScript(params.tabId, params.script)
        );
        return { result: scriptResult };
      }

      case 'get_content': {
        const content = await this.runLightweightFirst(
          params.tabId,
          'get_content',
          () => this.lightweightController.getContent(params.tabId, params.mode || 'text'),
          () => this.debuggerController.getContent(params.tabId, params.mode || 'text')
        );
        return { content };
      }

      case 'wait_for_element': {
        const found = await this.runLightweightFirst(
          params.tabId,
          'wait_for_element',
          () => this.lightweightController.waitForElement(params.tabId, params.selector, params.timeout),
          () => this.debuggerController.waitForElement(params.tabId, params.selector, params.timeout)
        );
        return { found };
      }

      // Tab management
      case 'create_tab': {
        const tabId = await this.tabManager.createTab(params.url);
        return { tabId };
      }

      case 'close_tab': {
        await this.tabManager.closeTab(params.tabId);
        return { status: 'closed' };
      }

      case 'list_tabs': {
        const allTabs = await chrome.tabs.query({});
        return {
          tabs: allTabs.map(t => ({
            tabId: t.id,
            url: t.url || '',
            title: t.title || '',
            active: t.active
          }))
        };
      }

      // Recording
      case 'start_recording': {
        const tabs = await chrome.tabs.query({});
        if (!tabs.some(t => t.id === params.tabId)) {
          throw new Error(`Tab ${params.tabId} not found`);
        }
        this.tabManager.holdDebuggerAttached(params.tabId, 'recording');
        try {
          await this.ensureDebuggerAttached(params.tabId);
          const recordingId = await this.recordingEngine.startRecording(params.tabId);
          await this.recordingEngine.injectListeners(params.tabId);
          this.recordingDebuggerTabId = params.tabId;
          return { recordingId };
        } catch (error) {
          this.tabManager.releaseDebuggerAttached(params.tabId, 'recording-start-failed');
          throw error;
        }
      }

      case 'stop_recording': {
        const recordingTabId = this.recordingDebuggerTabId;
        try {
          await this.recordingEngine.removeListeners();
          const recording = await this.recordingEngine.stopRecording();
          return { recording };
        } finally {
          if (recordingTabId != null) {
            this.recordingDebuggerTabId = null;
            this.tabManager.releaseDebuggerAttached(recordingTabId, 'recording-stopped');
          }
        }
      }

      case 'replay_recording': {
        let replayTabId = params.tabId;
        if (replayTabId == null) {
          const allTabs = await chrome.tabs.query({});
          if (allTabs.length > 0) {
            replayTabId = allTabs[0].id;
          } else {
            replayTabId = await this.tabManager.createTab();
          }
        }
        if (replayTabId == null) {
          throw new Error('No tab available for replay');
        }
        await this.runWithDebugger(replayTabId, 'replay_recording', () =>
          this.playbackEngine.replay(params.recordingId, replayTabId)
        );
        return { status: 'replayed', tabId: replayTabId };
      }

      // Session
      case 'save_session': {
        const sessionId = await this.sessionManager.saveSession(params.name);
        return { sessionId };
      }

      case 'restore_session': {
        await this.sessionManager.restoreSession(params.sessionId);
        return { status: 'restored' };
      }

      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  }

  private async ensureDebuggerAttached(tabId: number): Promise<void> {
    await this.tabManager.ensureDebuggerAttached(tabId);
  }

  private async runWithDebugger<T>(
    tabId: number,
    commandName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    await this.ensureDebuggerAttached(tabId);
    try {
      return await operation();
    } finally {
      this.tabManager.scheduleDebuggerDetach(tabId, commandName);
    }
  }

  private async runLightweightFirst<T>(
    tabId: number,
    commandName: string,
    lightweightOperation: () => Promise<T>,
    debuggerOperation: () => Promise<T>
  ): Promise<T> {
    try {
      return await lightweightOperation();
    } catch (error: any) {
      console.warn(
        `[ARC-TUNNEL-DIAG] ${commandName} lightweight path failed, falling back to debugger:`,
        error?.message || error
      );
      return await this.runWithDebugger(tabId, `${commandName}.fallback`, debuggerOperation);
    }
  }

  private async resolveRef(tabId: number, ref: string): Promise<number | null> {
    try {
      const snapshot = await this.snapshotEngine.getSnapshot(tabId, true);
      return snapshot.refs[ref]?.backendNodeId || null;
    } catch {
      return null;
    }
  }
}
