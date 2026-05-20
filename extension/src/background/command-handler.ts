// extension/src/background/command-handler.ts
import { CommandMessage, ResponseMessage } from '../types';
import { TabManager } from './tab-manager';
import { DebuggerController } from './debugger-controller';
import { RecordingEngine } from './recording-engine';
import { PlaybackEngine } from './playback-engine';
import { SessionManager } from './session-manager';

export class CommandHandler {
  constructor(
    private tabManager: TabManager,
    private debuggerController: DebuggerController,
    private recordingEngine: RecordingEngine,
    private playbackEngine: PlaybackEngine,
    private sessionManager: SessionManager
  ) {}

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
      // Navigation and interaction
      case 'navigate':
        await this.ensureDebuggerAttached(params.tabId);
        await this.debuggerController.navigate(params.tabId, params.url);
        return { status: 'navigated', url: params.url };

      case 'click':
        await this.ensureDebuggerAttached(params.tabId);
        await this.debuggerController.click(params.tabId, params.selector);
        return { status: 'clicked', selector: params.selector };

      case 'type':
        await this.ensureDebuggerAttached(params.tabId);
        await this.debuggerController.type(params.tabId, params.selector, params.text);
        return { status: 'typed', selector: params.selector };

      case 'screenshot':
        await this.ensureDebuggerAttached(params.tabId);
        const screenshot = await this.debuggerController.screenshot(params.tabId, params.fullPage);
        return { screenshot };

      case 'get_content':
        await this.ensureDebuggerAttached(params.tabId);
        const content = await this.debuggerController.getContent(params.tabId, params.mode);
        return { content };

      case 'execute_script':
        await this.ensureDebuggerAttached(params.tabId);
        const scriptResult = await this.debuggerController.executeScript(params.tabId, params.script);
        return { result: scriptResult };

      case 'wait_for_element':
        await this.ensureDebuggerAttached(params.tabId);
        const found = await this.debuggerController.waitForElement(
          params.tabId,
          params.selector,
          params.timeout || 10000
        );
        return { found, selector: params.selector };

      // Tab management
      case 'create_tab':
        const tabId = await this.tabManager.createTab(params.url);
        return { tabId };

      case 'close_tab':
        await this.tabManager.closeTab(params.tabId);
        return { status: 'closed' };

      case 'list_tabs':
        const tabs = this.tabManager.listTabs();
        return { tabs };

      // Recording
      case 'start_recording':
        const recordingId = await this.recordingEngine.startRecording(params.tabId);
        return { recordingId };

      case 'stop_recording':
        const recording = await this.recordingEngine.stopRecording();
        return { recording };

      case 'replay_recording':
        await this.playbackEngine.replay(params.recordingId, params.tabId);
        return { status: 'replayed' };

      // Session
      case 'save_session':
        const sessionId = await this.sessionManager.saveSession(params.name);
        return { sessionId };

      case 'restore_session':
        await this.sessionManager.restoreSession(params.sessionId);
        return { status: 'restored' };

      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  }

  private async ensureDebuggerAttached(tabId: number): Promise<void> {
    if (!this.tabManager.isDebuggerAttached(tabId)) {
      await this.tabManager.attachDebugger(tabId);
    }
  }
}
