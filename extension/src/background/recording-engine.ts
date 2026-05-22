// extension/src/background/recording-engine.ts
import { Recording, Action } from '../types';
import { DebuggerController } from './debugger-controller';
import { BUILD_SELECTOR_SCRIPT } from '../shared/selector-builder';

// Injected into every page load via executeScript
const LISTENER_SCRIPT = `
(function() {
  if (window.__arc_tunnel_listeners_installed) return;
  window.__arc_tunnel_listeners_installed = true;

  ${BUILD_SELECTOR_SCRIPT}

  // Click capture
  document.addEventListener('click', function(e) {
    var el = e.target;
    window.__arc_tunnel_record(JSON.stringify({
      type: 'click',
      timestamp: Date.now(),
      tabId: 0,
      pageUrl: location.href,
      target: { primary: buildSelector(el) },
      context: {
        selector: buildSelector(el),
        tag: el.tagName ? el.tagName.toLowerCase() : '',
        text: (el.textContent || '').trim().substring(0, 100),
        x: e.clientX,
        y: e.clientY
      }
    }));
  }, true);

  // Input debounced capture (trailing-edge, 500ms)
  var inputTimers = new WeakMap();
  document.addEventListener('input', function(e) {
    var el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return;
    if (inputTimers.has(el)) clearTimeout(inputTimers.get(el));
    inputTimers.set(el, setTimeout(function() {
      inputTimers.delete(el);
      window.__arc_tunnel_record(JSON.stringify({
        type: 'type',
        timestamp: Date.now(),
        tabId: 0,
        pageUrl: location.href,
        target: { primary: buildSelector(el) },
        text: el.value || el.textContent || ''
      }));
    }, 500));
  }, true);
})();
`;

export class RecordingEngine {
  private isRecording = false;
  private currentRecording: Recording | null = null;
  private startTime = 0;
  private debuggerController: DebuggerController;
  private recordingTabId: number | null = null;
  private cdpEventHandler: ((source: any, method: string, params: any) => void) | null = null;

  // Called via Runtime.addBinding from injected page scripts
  private bindingCallback = (action: Action) => {
    if (!this.isRecording || !this.currentRecording) return;
    if (!action.type) return;
    if (this.recordingTabId != null) action.tabId = this.recordingTabId;
    if (!action.pageUrl && this.currentRecording.metadata.startUrl) {
      action.pageUrl = this.currentRecording.metadata.startUrl;
    }
    this.recordAction(action);
  };

  constructor(debuggerController: DebuggerController) {
    this.debuggerController = debuggerController;
  }

  async injectListeners(tabId: number): Promise<void> {
    this.recordingTabId = tabId;

    // Step 1: Add binding — page calls window.__arc_tunnel_record(data) →
    //         CDP emits Runtime.bindingCalled → chrome.debugger.onEvent
    await this.debuggerController.addBinding(tabId, '__arc_tunnel_record');

    // Step 2: Inject listener script on the already-loaded page
    //         (avoid addScriptOnNewDocument — it accumulates across
    //         recordings and causes duplicate actions; we re-inject
    //         on every frame navigation instead)
    await this.debuggerController.executeScript(tabId, LISTENER_SCRIPT);

    // Step 3: Enable Page domain for frame navigated events
    await this.debuggerController.sendCommand(tabId, 'Page.enable');

    // Step 4: Single CDP event handler for binding callbacks AND navigations
    this.cdpEventHandler = (source: any, method: string, params: any) => {
      // Runtime.bindingCalled → user clicked/typed on the page
      if (method === 'Runtime.bindingCalled' && params?.name === '__arc_tunnel_record') {
        try {
          const action = JSON.parse(params.payload) as Action;
          this.bindingCallback(action);
        } catch { /* malformed data from page — ignore */ }
        return;
      }
      // Page.frameNavigated → user navigated → re-inject listeners on new page
      if (method === 'Page.frameNavigated' && params?.frame?.url) {
        const url = params.frame.url;
        if (!params.frame.parentId) {
          // Re-inject listeners into the new page
          this.debuggerController.executeScript(tabId, LISTENER_SCRIPT).catch(() => {});
          this.recordAction({
            type: 'navigate',
            timestamp: Date.now(),
            tabId: this.recordingTabId!,
            pageUrl: url,
            url
          });
        }
      }
    };

    chrome.debugger.onEvent.addListener(this.cdpEventHandler);
    console.log(`Recording listeners injected into tab ${tabId}`);
  }

  async removeListeners(): Promise<void> {
    if (this.recordingTabId != null) {
      try {
        await this.debuggerController.removeBinding(this.recordingTabId, '__arc_tunnel_record');
      } catch { /* ignore */ }
    }
    if (this.cdpEventHandler) {
      chrome.debugger.onEvent.removeListener(this.cdpEventHandler);
      this.cdpEventHandler = null;
    }
    this.recordingTabId = null;
    console.log('Recording listeners removed');
  }

  async startRecording(tabId: number): Promise<string> {
    const recordingId = crypto.randomUUID();
    this.startTime = Date.now();

    let startUrl = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      startUrl = tab.url || '';
    } catch {}

    this.currentRecording = {
      id: recordingId,
      name: `Recording ${new Date().toISOString()}`,
      createdAt: new Date().toISOString(),
      actions: [],
      metadata: {
        startUrl,
        duration: 0,
        actionCount: 0
      }
    };

    this.isRecording = true;
    console.log(`Started recording: ${recordingId}`);
    return recordingId;
  }

  async stopRecording(): Promise<Recording> {
    if (!this.currentRecording) {
      throw new Error('No active recording');
    }

    this.isRecording = false;
    const duration = Date.now() - this.startTime;

    this.currentRecording.metadata.duration = duration;
    this.currentRecording.metadata.actionCount = this.currentRecording.actions.length;

    const recording = this.currentRecording;
    this.currentRecording = null;

    try {
      await chrome.storage.local.set({
        [`recording_${recording.id}`]: recording
      });
    } catch (error) {
      console.warn('Failed to save recording to storage:', error);
    }

    console.log(`Stopped recording: ${recording.id} (${recording.metadata.actionCount} actions)`);
    return recording;
  }

  recordAction(action: Action): void {
    if (this.isRecording && this.currentRecording) {
      action.timestamp = Date.now() - this.startTime;
      this.currentRecording.actions.push(action);
    }
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording;
  }
}
