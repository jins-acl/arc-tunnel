# Recording Engine v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable real DOM event capture (click, type, navigate) during recording via CDP `Runtime.addBinding` + `Page.addScriptToEvaluateOnNewDocument`, replacing the empty skeleton.

**Architecture:** Injected DOM listeners capture clicks and inputs, calling `window.__web_bridge_record(action)` which is bound back to the background via CDP `Runtime.addBinding`. Navigation is detected via CDP `Page.frameNavigated` events. All actions flow into `RecordingEngine.recordAction()`.

**Tech Stack:** TypeScript, Chrome Extension MV3, CDP (Chrome DevTools Protocol)

---

### Task 1: Update Action types

**Files:**
- Modify: `extension/src/types/index.ts:50-86`

- [ ] **Step 1: Add `tabId`, `pageUrl`, and `context` to Action, expand type union**

```typescript
// extension/src/types/index.ts — replace the Action interface (lines 50-57)

export interface Action {
  type: 'navigate' | 'click' | 'type' | 'wait' | 'scroll' | 'keydown' | 'submit' | 'select' | 'drag';
  timestamp: number;
  tabId?: number;
  pageUrl?: string;
  target?: ElementTarget;
  url?: string;
  text?: string;
  waitConditions?: WaitConditions;
  context?: {
    selector: string;
    tag: string;
    text: string;
    x: number;
    y: number;
  };
}
```

- [ ] **Step 2: Verify no TypeScript errors in existing code**

```bash
cd /c/Users/15391/extension && npx tsc --noEmit 2>&1
```

Expected: errors only from unrelated files (tests, etc.), not from types/index.ts

- [ ] **Step 3: Commit**

```bash
git -C /c/Users/15391 add extension/src/types/index.ts
git -C /c/Users/15391 commit -m "feat(recording): expand Action types with tabId, pageUrl, context"
```

---

### Task 2: Add CDP helper methods to DebuggerController

**Files:**
- Modify: `extension/src/background/debugger-controller.ts:23-30`

- [ ] **Step 1: Add `addBinding`, `removeBinding`, `addScriptOnNewDocument` methods**

Insert after the `mapError` function (before `export class DebuggerController`):

```typescript
// extension/src/background/debugger-controller.ts — add inside DebuggerController class

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
```

- [ ] **Step 2: Commit**

```bash
git -C /c/Users/15391 add extension/src/background/debugger-controller.ts
git -C /c/Users/15391 commit -m "feat(recording): add CDP binding and script-injection helpers"
```

---

### Task 3: Rewrite RecordingEngine with listener injection and CDP navigate detection

**Files:**
- Rewrite: `extension/src/background/recording-engine.ts`

- [ ] **Step 1: Write the complete new RecordingEngine**

```typescript
// extension/src/background/recording-engine.ts
import { Recording, Action, ElementTarget } from '../types';
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
    window.__web_bridge_record({
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
    });
  }, true);

  // Input debounced capture (trailing-edge, 500ms)
  var inputTimers = new WeakMap();
  document.addEventListener('input', function(e) {
    var el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return;
    if (inputTimers.has(el)) clearTimeout(inputTimers.get(el));
    inputTimers.set(el, setTimeout(function() {
      inputTimers.delete(el);
      window.__web_bridge_record({
        type: 'type',
        timestamp: Date.now(),
        tabId: 0,
        pageUrl: location.href,
        target: { primary: buildSelector(el) },
        text: el.value || el.textContent || ''
      });
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
  private navigateHandler: ((source: any, method: string, params: any) => void) | null = null;

  // Called by Runtime.addBinding from injected page scripts
  private bindingCallback = (action: Action) => {
    if (!this.isRecording || !this.currentRecording) return;
    // Validate required fields
    if (!action.type) return;
    // Fill tabId from the recording context (page doesn't know its own tabId)
    if (this.recordingTabId != null) action.tabId = this.recordingTabId;
    // Fill pageUrl if not set
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

    // Step 2: Inject listener script that persists across page loads
    await this.debuggerController.addScriptOnNewDocument(tabId, LISTENER_SCRIPT);

    // Step 3: Enable Page domain for frame navigated events
    await this.debuggerController.sendCommand(tabId, 'Page.enable');

    // Step 4: Single CDP event handler for both binding callbacks AND navigations
    this.navigateHandler = (source: any, method: string, params: any) => {
      // Runtime.bindingCalled → user clicked/typed on the page
      if (method === 'Runtime.bindingCalled' && params?.name === '__web_bridge_record') {
        const action = JSON.parse(params.payload) as Action;
        this.bindingCallback(action);
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

    chrome.debugger.onEvent.addListener(this.navigateHandler);
    console.log(`Recording listeners injected into tab ${tabId}`);
  }

  async removeListeners(): Promise<void> {
    if (this.recordingTabId != null) {
      try {
        await this.debuggerController.removeBinding(this.recordingTabId, '__web_bridge_record');
      } catch { /* ignore */ }
    }
    if (this.navigateHandler) {
      chrome.debugger.onEvent.removeListener(this.navigateHandler);
      this.navigateHandler = null;
    }
    this.recordingTabId = null;
    console.log('Recording listeners removed');
  }

  async startRecording(tabId: number): Promise<string> {
    const recordingId = crypto.randomUUID();
    this.startTime = Date.now();

    // Get current tab URL for metadata
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

    // Save to storage
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
```

- [ ] **Step 2: Commit**

```bash
git -C /c/Users/15391 add extension/src/background/recording-engine.ts
git -C /c/Users/15391 commit -m "feat(recording): implement DOM listener injection and CDP navigate detection"
```

---

### Task 4: Wire inject/remove into CommandHandler start/stop

**Files:**
- Modify: `extension/src/background/command-handler.ts:105-113`

- [ ] **Step 1: Update start_recording and stop_recording handlers**

Replace lines 105-113 in command-handler.ts:

```typescript
      case 'start_recording':
        await this.ensureDebuggerAttached(params.tabId);
        const recordingId = await this.recordingEngine.startRecording(params.tabId);
        await this.recordingEngine.injectListeners(params.tabId);
        return { recordingId };

      case 'stop_recording':
        await this.recordingEngine.removeListeners();
        const recording = await this.recordingEngine.stopRecording();
        return { recording };
```

- [ ] **Step 2: Commit**

```bash
git -C /c/Users/15391 add extension/src/background/command-handler.ts
git -C /c/Users/15391 commit -m "feat(recording): wire listener injection into start/stop commands"
```

---

### Task 5: Update Service Worker instantiation

**Files:**
- Modify: `extension/src/background/service-worker.ts:15`

- [ ] **Step 1: Pass debuggerController to RecordingEngine constructor**

```typescript
// extension/src/background/service-worker.ts — line 15, change from:
const recordingEngine = new RecordingEngine();
// to:
const recordingEngine = new RecordingEngine(debuggerController);
```

- [ ] **Step 2: Commit**

```bash
git -C /c/Users/15391 add extension/src/background/service-worker.ts
git -C /c/Users/15391 commit -m "feat(recording): pass debuggerController to RecordingEngine"
```

---

### Task 6: Remove [EXPERIMENTAL] from MCP tool descriptions

**Files:**
- Modify: `mcp-server/src/tools/index.ts:139-166`

- [ ] **Step 1: Update tool descriptions**

Replace the three recording tool descriptions:

```typescript
      name: 'start_recording',
      description: 'Start recording user actions (click, type, navigate)',
      // ... rest unchanged

      name: 'stop_recording',
      description: 'Stop recording and return the recorded actions',
      // ... rest unchanged

      name: 'replay_recording',
      description: 'Replay a recorded session',
      // ... rest unchanged
```

- [ ] **Step 2: Commit**

```bash
git -C /c/Users/15391 add mcp-server/src/tools/index.ts
git -C /c/Users/15391 commit -m "feat(recording): remove EXPERIMENTAL prefix from recording tools"
```

---

### Task 7: Build both projects and verify

**Files:**
- Rebuild: `extension/dist/`, `mcp-server/dist/`

- [ ] **Step 1: Build extension**

```bash
cd /c/Users/15391/extension && npm run build 2>&1
```
Expected: "Extension build complete" with no errors.

- [ ] **Step 2: Build MCP server**

```bash
cd /c/Users/15391/mcp-server && npm run build 2>&1
```
Expected: Build completes with no errors.

- [ ] **Step 3: Run MCP server tests**

```bash
cd /c/Users/15391/mcp-server && npm test 2>&1
```
Expected: 14 tests, 5 suites, all passing.

- [ ] **Step 4: Commit dist files**

```bash
git -C /c/Users/15391 add extension/dist/ mcp-server/dist/
git -C /c/Users/15391 commit -m "build: recording engine v1 dist artifacts"
```

---

### Task 8: Manual integration test

- [ ] **Step 1: Reload extension in browser**
  Open `edge://extensions/`, find Web Bridge, click refresh.

- [ ] **Step 2: Restart Claude Code**
  `/exit` then restart.

- [ ] **Step 3: Test workflow**
  1. Navigate to any page (e.g., `https://example.com`)
  2. `start_recording` on that tab
  3. Click a link, type in a search box
  4. `stop_recording`
  5. Verify the returned recording has `actions.length > 0`

- [ ] **Step 4: Verify action types**
  Check that recorded actions include `click`, `type`, and potentially `navigate` types.
