// extension/src/background/recording-engine.ts
import { Recording, Action } from '../types';
import { DebuggerController } from './debugger-controller';

// Injected into every page load via Page.addScriptToEvaluateOnNewDocument
const LISTENER_SCRIPT = `
(function() {
  function buildSelector(el) {
    if (el.id && !/^\\d/.test(el.id) && el.id.length < 36) return '#' + CSS.escape(el.id);
    var path = [];
    while (el && el.nodeType === 1 && path.length < 5) {
      var tag = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        var classes = el.className.trim().split(/\\s+/).slice(0, 3);
        if (classes.length) tag += '.' + classes.map(function(c) { return CSS.escape(c); }).join('.');
      }
      path.unshift(tag);
      el = el.parentElement;
    }
    return path.join(' > ');
  }

  // Click capture
  document.addEventListener('click', function(e) {
    var el = e.target;
    window.__web_bridge_record(JSON.stringify({
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
      window.__web_bridge_record(JSON.stringify({
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

    // Step 1: Add binding — page calls window.__web_bridge_record(data) →
    //         CDP emits Runtime.bindingCalled → chrome.debugger.onEvent
    await this.debuggerController.addBinding(tabId, '__web_bridge_record');

    // Step 2: Inject listener script for future page loads
    await this.debuggerController.addScriptOnNewDocument(tabId, LISTENER_SCRIPT);

    // Step 2b: Also run on the already-loaded page (addScriptOnNewDocument
    // only affects subsequent loads, not the current document)
    await this.debuggerController.executeScript(tabId, LISTENER_SCRIPT);

    // Step 3: Enable Page domain for frame navigated events
    await this.debuggerController.sendCommand(tabId, 'Page.enable');

    // Step 4: Single CDP event handler for both binding callbacks AND navigations
    this.cdpEventHandler = (source: any, method: string, params: any) => {
      // Runtime.bindingCalled → user clicked/typed on the page
      if (method === 'Runtime.bindingCalled' && params?.name === '__web_bridge_record') {
        try {
          const action = JSON.parse(params.payload) as Action;
          this.bindingCallback(action);
        } catch { /* malformed data from page — ignore */ }
        return;
      }
      // Page.frameNavigated → user navigated (link click, form submit, redirect)
      if (method === 'Page.frameNavigated' && params?.frame?.url) {
        const url = params.frame.url;
        if (!params.frame.parentId) {
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
        await this.debuggerController.removeBinding(this.recordingTabId, '__web_bridge_record');
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
