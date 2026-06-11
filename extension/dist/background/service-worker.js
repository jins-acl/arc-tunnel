var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/background/websocket-client.ts
var WebSocketClient;
var init_websocket_client = __esm({
  "src/background/websocket-client.ts"() {
    "use strict";
    WebSocketClient = class {
      constructor(url) {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1e3;
        this.maxReconnectDelay = 3e4;
        this.messageHandlers = /* @__PURE__ */ new Map();
        this.intentionalClose = false;
        this.connecting = false;
        this.url = url || "ws://localhost:8765";
      }
      setUrl(url) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.disconnect();
        }
        this.url = url;
      }
      async connect() {
        if (this.isConnected() || this.connecting) {
          return;
        }
        this.connecting = true;
        this.intentionalClose = false;
        return new Promise((resolve, reject) => {
          this.ws = new WebSocket(this.url);
          this.ws.onopen = () => {
            console.log("Connected to MCP server");
            this.reconnectAttempts = 0;
            this.connecting = false;
            chrome.alarms.clear("ws-reconnect");
            resolve();
          };
          this.ws.onerror = (error) => {
            console.error("WebSocket error:", error);
          };
          this.ws.onclose = () => {
            this.connecting = false;
            console.log("Disconnected from MCP server");
            this.handleReconnect();
          };
          this.ws.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data);
              this.handleMessage(message);
            } catch (error) {
              console.error("Failed to parse message:", error);
            }
          };
          setTimeout(() => {
            if (this.connecting) {
              this.connecting = false;
              reject(new Error("WebSocket connection timeout"));
            }
          }, 1e4);
        });
      }
      disconnect() {
        this.intentionalClose = true;
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
      }
      isConnected() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
      }
      sendResponse(response) {
        if (this.isConnected()) {
          this.ws.send(JSON.stringify(response));
        }
      }
      sendEvent(event) {
        if (this.isConnected()) {
          this.ws.send(JSON.stringify(event));
        }
      }
      onCommand(handler) {
        this.messageHandlers.set("command", handler);
      }
      handleMessage(message) {
        const handler = this.messageHandlers.get("command");
        if (handler) {
          handler(message);
        }
      }
      async handleReconnect() {
        if (this.intentionalClose) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error(`Reconnect failed after ${this.maxReconnectAttempts} attempts \u2014 giving up. Reload the extension to retry.`);
          return;
        }
        const delay = Math.min(
          this.reconnectDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1e3,
          this.maxReconnectDelay
        );
        this.reconnectAttempts++;
        console.log(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        setTimeout(async () => {
          if (this.intentionalClose) return;
          try {
            await this.connect();
          } catch (error) {
            console.error("Reconnect failed:", error);
          }
        }, delay);
        chrome.alarms.create("ws-reconnect", { delayInMinutes: Math.ceil(delay / 6e4) || 1 });
      }
    };
  }
});

// src/background/tab-manager.ts
var TabManager;
var init_tab_manager = __esm({
  "src/background/tab-manager.ts"() {
    "use strict";
    TabManager = class {
      constructor() {
        this.tabs = /* @__PURE__ */ new Map();
        this.listenersSetup = false;
        this.attachLocks = /* @__PURE__ */ new Map();
      }
      async syncExistingTabs() {
        const existingTabs = await chrome.tabs.query({});
        for (const tab of existingTabs) {
          if (tab.id && !this.tabs.has(tab.id)) {
            this.tabs.set(tab.id, {
              id: tab.id,
              url: tab.url || "",
              title: tab.title || "",
              debuggerAttached: false
            });
          }
        }
        console.log(`Synced ${existingTabs.length} existing tabs`);
        if (!this.listenersSetup) {
          chrome.tabs.onCreated.addListener((tab) => {
            if (tab.id) {
              this.tabs.set(tab.id, {
                id: tab.id,
                url: tab.url || "",
                title: tab.title || "",
                debuggerAttached: false
              });
            }
          });
          chrome.tabs.onRemoved.addListener((tabId) => {
            this.tabs.delete(tabId);
            this.attachLocks.delete(tabId);
          });
          chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            const existing = this.tabs.get(tabId);
            if (existing) {
              if (changeInfo.url) existing.url = changeInfo.url;
              if (changeInfo.title) existing.title = changeInfo.title;
            }
          });
          chrome.debugger.onDetach.addListener((source) => {
            const tabInfo = this.tabs.get(source.tabId);
            if (tabInfo) {
              tabInfo.debuggerAttached = false;
            }
            this.attachLocks.delete(source.tabId);
            console.log(`Debugger detached externally from tab ${source.tabId}`);
          });
          this.listenersSetup = true;
        }
      }
      /**
       * Ensure debugger is attached to the tab.
       * Uses a per-tab lock to prevent concurrent attach attempts.
       */
      async ensureDebuggerAttached(tabId) {
        if (this.tabs.get(tabId)?.debuggerAttached) {
          return;
        }
        const existingLock = this.attachLocks.get(tabId);
        if (existingLock) {
          return existingLock;
        }
        const lock = this._doAttachDebugger(tabId);
        this.attachLocks.set(tabId, lock);
        try {
          await lock;
        } finally {
          this.attachLocks.delete(tabId);
        }
      }
      async _doAttachDebugger(tabId) {
        try {
          await chrome.debugger.attach({ tabId }, "1.3");
          const tab = await chrome.tabs.get(tabId);
          this.tabs.set(tabId, {
            id: tabId,
            url: tab.url || "",
            title: tab.title || "",
            debuggerAttached: true
          });
          console.log(`Debugger attached to tab ${tabId}`);
        } catch (error) {
          if (error?.message?.includes("already attached")) {
            try {
              const tab = await chrome.tabs.get(tabId);
              this.tabs.set(tabId, {
                id: tabId,
                url: tab.url || "",
                title: tab.title || "",
                debuggerAttached: true
              });
              console.log(`Debugger already attached to tab ${tabId}, state restored`);
              return;
            } catch (tabError) {
              console.error(`Failed to get tab info for tab ${tabId}:`, tabError);
              throw tabError;
            }
          }
          console.error(`Failed to attach debugger to tab ${tabId}:`, error);
          throw error;
        }
      }
      /** @deprecated Use ensureDebuggerAttached instead */
      async attachDebugger(tabId) {
        return this.ensureDebuggerAttached(tabId);
      }
      async detachDebugger(tabId) {
        try {
          await chrome.debugger.detach({ tabId });
          const tabInfo = this.tabs.get(tabId);
          if (tabInfo) {
            tabInfo.debuggerAttached = false;
          }
          console.log(`Debugger detached from tab ${tabId}`);
        } catch (error) {
          console.error(`Failed to detach debugger from tab ${tabId}:`, error);
        }
      }
      async createTab(url) {
        const tab = await chrome.tabs.create({ url, active: true });
        if (tab.id) {
          this.tabs.set(tab.id, {
            id: tab.id,
            url: tab.url || "",
            title: tab.title || "",
            debuggerAttached: false
          });
          return tab.id;
        }
        throw new Error("Failed to create tab");
      }
      async closeTab(tabId) {
        await chrome.tabs.remove(tabId);
        this.tabs.delete(tabId);
      }
      listTabs() {
        return Array.from(this.tabs.values());
      }
      getTab(tabId) {
        return this.tabs.get(tabId);
      }
      isDebuggerAttached(tabId) {
        return this.tabs.get(tabId)?.debuggerAttached || false;
      }
    };
  }
});

// src/background/debugger-controller.ts
function mapError(err) {
  const msg = err.message || "";
  if (msg.includes("No tab with id") || msg.includes("No target with given id")) {
    err.code = "TAB_NOT_FOUND";
  } else if (msg.includes("Another debugger is already attached")) {
    err.code = "DEBUGGER_ATTACH_FAILED";
  } else if (msg.includes("Element not found")) {
    err.code = "ELEMENT_NOT_FOUND";
  } else if (msg.includes("Cannot find context with specified id")) {
    err.code = "TAB_CLOSED";
  } else if (msg.includes("timeout")) {
    err.code = "TIMEOUT";
  }
  return err;
}
var DebuggerController;
var init_debugger_controller = __esm({
  "src/background/debugger-controller.ts"() {
    "use strict";
    DebuggerController = class {
      constructor() {
        this.pageEnabledTabs = /* @__PURE__ */ new Set();
      }
      async sendCommand(tabId, method, params) {
        return new Promise((resolve, reject) => {
          chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
            if (chrome.runtime.lastError) {
              reject(mapError(new Error(chrome.runtime.lastError.message)));
            } else {
              resolve(result);
            }
          });
        });
      }
      async navigate(tabId, url) {
        if (!this.pageEnabledTabs.has(tabId)) {
          await this.sendCommand(tabId, "Page.enable");
          this.pageEnabledTabs.add(tabId);
        }
        await this.sendCommand(tabId, "Page.navigate", { url });
      }
      async click(tabId, selector) {
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
      async type(tabId, selector, text) {
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
      async screenshot(tabId, fullPage = false) {
        const result = await this.sendCommand(tabId, "Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: fullPage
        });
        return result.data;
      }
      async executeScript(tabId, script) {
        const result = await this.sendCommand(tabId, "Runtime.evaluate", {
          expression: script,
          returnByValue: true
        });
        if (result.exceptionDetails) {
          throw mapError(new Error(result.exceptionDetails.text || "Script execution error"));
        }
        return result.result?.value;
      }
      async getContent(tabId, mode) {
        switch (mode) {
          case "html":
            return await this.executeScript(tabId, "document.documentElement.outerHTML");
          case "text":
            return await this.executeScript(tabId, "document.body.innerText");
          case "structured":
            return await this.getStructuredContent(tabId);
          case "markdown":
            return await this.getMarkdownContent(tabId);
          default:
            throw new Error(`Unknown mode: ${mode}`);
        }
      }
      async getStructuredContent(tabId) {
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
        if (typeof result === "string") {
          try {
            return JSON.parse(result);
          } catch {
            return { raw: result };
          }
        }
        return result;
      }
      async getMarkdownContent(tabId) {
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
      async waitForElement(tabId, selector, timeout = 1e4) {
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
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return false;
      }
      async addBinding(tabId, name) {
        await this.sendCommand(tabId, "Runtime.addBinding", { name });
      }
      async removeBinding(tabId, name) {
        try {
          await this.sendCommand(tabId, "Runtime.removeBinding", { name });
        } catch {
        }
      }
      async addScriptOnNewDocument(tabId, script) {
        await this.sendCommand(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: script });
      }
    };
  }
});

// src/shared/selector-builder.ts
var BUILD_SELECTOR_SCRIPT;
var init_selector_builder = __esm({
  "src/shared/selector-builder.ts"() {
    "use strict";
    BUILD_SELECTOR_SCRIPT = `
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
`;
  }
});

// src/background/recording-engine.ts
var LISTENER_SCRIPT, RecordingEngine;
var init_recording_engine = __esm({
  "src/background/recording-engine.ts"() {
    "use strict";
    init_selector_builder();
    LISTENER_SCRIPT = `
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
    RecordingEngine = class {
      constructor(debuggerController) {
        this.isRecording = false;
        this.currentRecording = null;
        this.startTime = 0;
        this.recordingTabId = null;
        this.cdpEventHandler = null;
        // Called via Runtime.addBinding from injected page scripts
        this.bindingCallback = (action) => {
          if (!this.isRecording || !this.currentRecording) return;
          if (!action.type) return;
          if (this.recordingTabId != null) action.tabId = this.recordingTabId;
          if (!action.pageUrl && this.currentRecording.metadata.startUrl) {
            action.pageUrl = this.currentRecording.metadata.startUrl;
          }
          this.recordAction(action);
        };
        this.debuggerController = debuggerController;
      }
      async injectListeners(tabId) {
        this.recordingTabId = tabId;
        await this.debuggerController.addBinding(tabId, "__arc_tunnel_record");
        await this.debuggerController.executeScript(tabId, LISTENER_SCRIPT);
        await this.debuggerController.sendCommand(tabId, "Page.enable");
        this.cdpEventHandler = (source, method, params) => {
          if (method === "Runtime.bindingCalled" && params?.name === "__arc_tunnel_record") {
            try {
              const action = JSON.parse(params.payload);
              this.bindingCallback(action);
            } catch {
            }
            return;
          }
          if (method === "Page.frameNavigated" && params?.frame?.url) {
            const url = params.frame.url;
            if (!params.frame.parentId) {
              this.debuggerController.executeScript(tabId, LISTENER_SCRIPT).catch(() => {
              });
              this.recordAction({
                type: "navigate",
                timestamp: Date.now(),
                tabId: this.recordingTabId,
                pageUrl: url,
                url
              });
            }
          }
        };
        chrome.debugger.onEvent.addListener(this.cdpEventHandler);
        console.log(`Recording listeners injected into tab ${tabId}`);
      }
      async removeListeners() {
        if (this.recordingTabId != null) {
          try {
            await this.debuggerController.removeBinding(this.recordingTabId, "__arc_tunnel_record");
          } catch {
          }
        }
        if (this.cdpEventHandler) {
          chrome.debugger.onEvent.removeListener(this.cdpEventHandler);
          this.cdpEventHandler = null;
        }
        this.recordingTabId = null;
        console.log("Recording listeners removed");
      }
      async startRecording(tabId) {
        const recordingId = crypto.randomUUID();
        this.startTime = Date.now();
        let startUrl = "";
        try {
          const tab = await chrome.tabs.get(tabId);
          startUrl = tab.url || "";
        } catch {
        }
        this.currentRecording = {
          id: recordingId,
          name: `Recording ${(/* @__PURE__ */ new Date()).toISOString()}`,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
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
      async stopRecording() {
        if (!this.currentRecording) {
          throw new Error("No active recording");
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
          console.warn("Failed to save recording to storage:", error);
        }
        console.log(`Stopped recording: ${recording.id} (${recording.metadata.actionCount} actions)`);
        return recording;
      }
      recordAction(action) {
        if (this.isRecording && this.currentRecording) {
          action.timestamp = Date.now() - this.startTime;
          this.currentRecording.actions.push(action);
        }
      }
      isCurrentlyRecording() {
        return this.isRecording;
      }
    };
  }
});

// src/background/playback-engine.ts
var PlaybackEngine;
var init_playback_engine = __esm({
  "src/background/playback-engine.ts"() {
    "use strict";
    PlaybackEngine = class {
      constructor(debuggerController) {
        this.debuggerController = debuggerController;
      }
      async replay(recordingId, tabId) {
        const result = await chrome.storage.local.get(`recording_${recordingId}`);
        const recording = result[`recording_${recordingId}`];
        if (!recording) {
          throw new Error("Recording not found");
        }
        console.log(`Replaying recording: ${recordingId} (${recording.actions.length} actions)`);
        for (let i = 0; i < recording.actions.length; i++) {
          const action = recording.actions[i];
          console.log(`Action ${i + 1}/${recording.actions.length}: ${action.type}`);
          await this.executeAction(action, tabId);
          await this.sleep(200);
        }
        console.log("Playback complete");
      }
      async executeAction(action, tabId) {
        switch (action.type) {
          case "navigate":
            if (action.url) {
              await this.debuggerController.navigate(tabId, action.url);
              await this.sleep(2e3);
            }
            break;
          case "click":
            if (action.target) {
              await this.debuggerController.click(tabId, action.target.primary);
            }
            break;
          case "type":
            if (action.target && action.text) {
              await this.debuggerController.type(tabId, action.target.primary, action.text);
            }
            break;
          case "wait":
            await this.sleep(1e3);
            break;
        }
      }
      sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }
    };
  }
});

// src/background/session-manager.ts
var SessionManager;
var init_session_manager = __esm({
  "src/background/session-manager.ts"() {
    "use strict";
    SessionManager = class {
      async saveSession(name) {
        const sessionId = crypto.randomUUID();
        const tabs = await chrome.tabs.query({});
        const tabStates = [];
        for (const tab of tabs) {
          if (tab.id && tab.url) {
            let cookies = [];
            try {
              cookies = await chrome.cookies.getAll({ url: tab.url });
            } catch (error) {
              console.warn(`Failed to get cookies for ${tab.url}:`, error);
            }
            tabStates.push({
              url: tab.url,
              cookies,
              localStorage: {},
              sessionStorage: {}
            });
          }
        }
        const session = {
          id: sessionId,
          name,
          tabs: tabStates,
          savedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        await chrome.storage.local.set({
          [`session_${sessionId}`]: session
        });
        console.log(`Session saved: ${sessionId} (${tabStates.length} tabs)`);
        return sessionId;
      }
      async restoreSession(sessionId) {
        const result = await chrome.storage.local.get(`session_${sessionId}`);
        const session = result[`session_${sessionId}`];
        if (!session) {
          throw new Error("Session not found");
        }
        console.log(`Restoring session: ${sessionId} (${session.tabs.length} tabs)`);
        for (const tabState of session.tabs) {
          try {
            const tab = await chrome.tabs.create({ url: tabState.url });
            if (tab.id) {
              for (const cookie of tabState.cookies) {
                try {
                  await chrome.cookies.set({
                    url: tabState.url,
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path || "/",
                    secure: cookie.secure,
                    httpOnly: cookie.httpOnly
                  });
                } catch (cookieError) {
                  console.warn(`Failed to restore cookie ${cookie.name}:`, cookieError);
                }
              }
            }
          } catch (error) {
            console.warn(`Failed to restore tab ${tabState.url}:`, error);
          }
        }
        console.log("Session restored");
      }
      async listSessions() {
        const allData = await chrome.storage.local.get(null);
        const sessions = [];
        for (const key of Object.keys(allData)) {
          if (key.startsWith("session_")) {
            sessions.push(allData[key]);
          }
        }
        return sessions;
      }
      async deleteSession(sessionId) {
        await chrome.storage.local.remove(`session_${sessionId}`);
        console.log(`Session deleted: ${sessionId}`);
      }
    };
  }
});

// src/background/console-capture.ts
var ConsoleCapture;
var init_console_capture = __esm({
  "src/background/console-capture.ts"() {
    "use strict";
    ConsoleCapture = class {
      constructor() {
        this.logs = /* @__PURE__ */ new Map();
        this.listeners = /* @__PURE__ */ new Map();
      }
      async enableForTab(tabId, debuggerController) {
        if (this.listeners.has(tabId)) return;
        if (debuggerController) {
          try {
            await debuggerController.sendCommand(tabId, "Runtime.enable");
          } catch {
          }
        }
        const handler = (source, method, params) => {
          if (method === "Runtime.consoleAPICalled") {
            const entry = {
              level: params.type || "log",
              text: params.args?.map((a) => a.value || a.description || "").join(" ") || "",
              source: params.stackTrace?.callFrames?.[0]?.url || "",
              line: params.stackTrace?.callFrames?.[0]?.lineNumber,
              column: params.stackTrace?.callFrames?.[0]?.columnNumber,
              timestamp: Date.now()
            };
            if (!this.logs.has(tabId)) {
              this.logs.set(tabId, []);
            }
            this.logs.get(tabId).push(entry);
            const tabLogs = this.logs.get(tabId);
            if (tabLogs.length > 500) {
              tabLogs.splice(0, tabLogs.length - 500);
            }
          }
        };
        chrome.debugger.onEvent.addListener(handler);
        this.listeners.set(tabId, handler);
      }
      disableForTab(tabId) {
        const handler = this.listeners.get(tabId);
        if (handler) {
          chrome.debugger.onEvent.removeListener(handler);
          this.listeners.delete(tabId);
        }
        this.logs.delete(tabId);
      }
      getLogs(tabId, minLevel) {
        const tabLogs = this.logs.get(tabId) || [];
        if (!minLevel) return [...tabLogs];
        const levels = ["debug", "info", "warning", "error"];
        const minIdx = levels.indexOf(minLevel);
        if (minIdx === -1) return [...tabLogs];
        return tabLogs.filter((log) => levels.indexOf(log.level) >= minIdx);
      }
      clearLogs(tabId) {
        this.logs.set(tabId, []);
      }
    };
  }
});

// src/background/storage-manager.ts
var StorageManager;
var init_storage_manager = __esm({
  "src/background/storage-manager.ts"() {
    "use strict";
    StorageManager = class {
      // ─── Cookies ───
      async listCookies(tabId, domain) {
        const url = await this.getTabUrl(tabId);
        const cookies = await chrome.cookies.getAll({ url, domain });
        return cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite
        }));
      }
      async getCookie(tabId, name) {
        const url = await this.getTabUrl(tabId);
        const cookies = await chrome.cookies.getAll({ url, name });
        if (cookies.length === 0) return null;
        const c = cookies[0];
        return {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite
        };
      }
      async setCookie(tabId, name, value, options) {
        const url = await this.getTabUrl(tabId);
        const urlObj = new URL(url);
        await chrome.cookies.set({
          url,
          name,
          value,
          domain: options?.domain || urlObj.hostname,
          path: options?.path || "/",
          secure: options?.secure ?? false,
          httpOnly: options?.httpOnly ?? false
        });
      }
      async deleteCookie(tabId, name) {
        const url = await this.getTabUrl(tabId);
        await chrome.cookies.remove({ url, name });
      }
      async clearCookies(tabId) {
        const url = await this.getTabUrl(tabId);
        const cookies = await chrome.cookies.getAll({ url });
        for (const c of cookies) {
          await chrome.cookies.remove({ url, name: c.name });
        }
      }
      // ─── localStorage / sessionStorage ───
      async listStorage(tabId, type) {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (storeType) => {
            const store = storeType === "localStorage" ? localStorage : sessionStorage;
            const result = {};
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i);
              if (key) result[key] = store.getItem(key) || "";
            }
            return result;
          },
          args: [type === "local" ? "localStorage" : "sessionStorage"]
        });
        return results[0]?.result || {};
      }
      async getStorageItem(tabId, type, key) {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (storeType, key2) => {
            const store = storeType === "localStorage" ? localStorage : sessionStorage;
            return store.getItem(key2);
          },
          args: [type === "local" ? "localStorage" : "sessionStorage", key]
        });
        return results[0]?.result ?? null;
      }
      async setStorageItem(tabId, type, key, value) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (storeType, key2, value2) => {
            const store = storeType === "localStorage" ? localStorage : sessionStorage;
            store.setItem(key2, value2);
          },
          args: [type === "local" ? "localStorage" : "sessionStorage", key, value]
        });
      }
      async deleteStorageItem(tabId, type, key) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (storeType, key2) => {
            const store = storeType === "localStorage" ? localStorage : sessionStorage;
            store.removeItem(key2);
          },
          args: [type === "local" ? "localStorage" : "sessionStorage", key]
        });
      }
      async clearStorage(tabId, type) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (storeType) => {
            const store = storeType === "localStorage" ? localStorage : sessionStorage;
            store.clear();
          },
          args: [type === "local" ? "localStorage" : "sessionStorage"]
        });
      }
      async getTabUrl(tabId) {
        const tab = await chrome.tabs.get(tabId);
        return tab.url || "";
      }
    };
  }
});

// src/background/snapshot-engine.ts
var INTERACTIVE_ROLES, MAX_REFS, SnapshotEngine;
var init_snapshot_engine = __esm({
  "src/background/snapshot-engine.ts"() {
    "use strict";
    INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "menuitem",
      "tab",
      "switch",
      "slider",
      "searchbox",
      "spinbutton",
      "option",
      "menuitemcheckbox"
    ]);
    MAX_REFS = 200;
    SnapshotEngine = class {
      constructor(debuggerController) {
        this.cache = /* @__PURE__ */ new Map();
        this.CACHE_TTL_MS = 5e3;
        this.debuggerController = debuggerController;
      }
      async getSnapshot(tabId, useCache = true) {
        if (useCache) {
          const cached = this.cache.get(tabId);
          if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
            return cached.snapshot;
          }
        }
        const snapshot = await this._generateSnapshot(tabId);
        this.cache.set(tabId, { snapshot, timestamp: Date.now() });
        return snapshot;
      }
      invalidateCache(tabId) {
        if (tabId !== void 0) {
          this.cache.delete(tabId);
        } else {
          this.cache.clear();
        }
      }
      resolveRef(snapshot, ref) {
        return snapshot.refs[ref] || null;
      }
      async _generateSnapshot(tabId) {
        await this.debuggerController.sendCommand(tabId, "Accessibility.enable");
        await this.debuggerController.sendCommand(tabId, "DOM.enable");
        const { nodes } = await this.debuggerController.sendCommand(
          tabId,
          "Accessibility.getFullAXTree"
        );
        const tab = await chrome.tabs.get(tabId);
        let counter = 0;
        const refs = {};
        const lines = [];
        for (const node of nodes) {
          if (node.ignored) continue;
          const role = node.role?.value;
          if (!role || !INTERACTIVE_ROLES.has(role)) continue;
          const backendNodeId = node.backendDOMNodeId;
          if (!backendNodeId) continue;
          counter++;
          if (counter > MAX_REFS) break;
          const ref = `e${counter}`;
          const name = node.name?.value || "";
          const states = this._extractStates(node);
          refs[ref] = { ref, role, name, backendNodeId, states };
          const stateStr = states.length ? ` [${states.join(",")}]` : "";
          lines.push(`- [${ref}] ${role}: "${name}"${stateStr}`);
        }
        return {
          url: tab.url || "",
          title: tab.title || "",
          tree: lines.join("\n"),
          refs
        };
      }
      _extractStates(node) {
        const states = [];
        for (const prop of node.properties || []) {
          if (prop.name === "checked" && prop.value?.value) {
            states.push("checked");
          }
          if (prop.name === "disabled" && prop.value?.value) {
            states.push("disabled");
          }
          if (prop.name === "expanded" && prop.value?.value !== void 0) {
            states.push(prop.value.value ? "expanded" : "collapsed");
          }
          if (prop.name === "selected" && prop.value?.value) {
            states.push("selected");
          }
        }
        return states;
      }
    };
  }
});

// src/background/input-simulator.ts
var InputSimulator;
var init_input_simulator = __esm({
  "src/background/input-simulator.ts"() {
    "use strict";
    InputSimulator = class {
      constructor(debuggerController) {
        this.debuggerController = debuggerController;
      }
      // Get element center via DOM.getBoxModel + backendNodeId
      // Automatically穿透 iframe / Shadow DOM
      async getElementCenter(tabId, backendNodeId) {
        const { model } = await this.debuggerController.sendCommand(
          tabId,
          "DOM.getBoxModel",
          { backendNodeId }
        );
        const c = model.content;
        return {
          x: Math.round((c[0] + c[2] + c[4] + c[6]) / 4),
          y: Math.round((c[1] + c[3] + c[5] + c[7]) / 4)
        };
      }
      async dispatchClick(tabId, backendNodeId, doubleClick = false) {
        await this.debuggerController.sendCommand(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
        const { x, y } = await this.getElementCenter(tabId, backendNodeId);
        const clickCount = doubleClick ? 2 : 1;
        await this.debuggerController.sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y
        });
        await this.debuggerController.sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount
        });
        await this.debuggerController.sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount
        });
      }
      async dispatchDoubleClick(tabId, backendNodeId) {
        await this.dispatchClick(tabId, backendNodeId, true);
      }
      async dispatchHover(tabId, backendNodeId) {
        await this.debuggerController.sendCommand(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
        const { x, y } = await this.getElementCenter(tabId, backendNodeId);
        await this.debuggerController.sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y
        });
      }
      async dispatchType(tabId, backendNodeId, text) {
        await this.debuggerController.sendCommand(tabId, "DOM.focus", { backendNodeId });
        await this.debuggerController.sendCommand(tabId, "Input.insertText", { text });
      }
      async dispatchPress(tabId, key) {
        await this.debuggerController.sendCommand(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key
        });
        await this.debuggerController.sendCommand(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key
        });
      }
      async dispatchCheck(tabId, backendNodeId, checked) {
        const { nodeId } = await this.debuggerController.sendCommand(
          tabId,
          "DOM.requestNode",
          { backendNodeId }
        );
        const { object } = await this.debuggerController.sendCommand(
          tabId,
          "DOM.resolveNode",
          { nodeId }
        );
        const result = await this.debuggerController.sendCommand(tabId, "Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function(checked) {
        const el = this;
        if (el.type !== 'checkbox' && el.type !== 'radio') {
          throw new Error('Element is not a checkbox or radio');
        }
        if (el.checked !== checked) {
          el.click();
        }
        return { checked: el.checked };
      }`,
          arguments: [{ value: checked }],
          returnByValue: true
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.text || "Check operation failed");
        }
      }
    };
  }
});

// src/background/actionability-checker.ts
var ActionabilityChecker;
var init_actionability_checker = __esm({
  "src/background/actionability-checker.ts"() {
    "use strict";
    ActionabilityChecker = class {
      constructor(debuggerController) {
        this.debuggerController = debuggerController;
      }
      async waitForActionable(tabId, backendNodeId, timeout = 5e3) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
          try {
            const { model } = await this.debuggerController.sendCommand(
              tabId,
              "DOM.getBoxModel",
              { backendNodeId }
            );
            const c = model.content;
            const width = Math.abs(c[2] - c[0]);
            const height = Math.abs(c[5] - c[1]);
            if (width > 0 && height > 0) {
              return;
            }
          } catch (err) {
            if (err.message?.includes("Could not find node")) {
            } else {
              throw err;
            }
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`Element did not become actionable within ${timeout}ms`);
      }
    };
  }
});

// src/background/command-handler.ts
var CommandHandler;
var init_command_handler = __esm({
  "src/background/command-handler.ts"() {
    "use strict";
    init_snapshot_engine();
    init_input_simulator();
    init_actionability_checker();
    CommandHandler = class {
      constructor(tabManager, debuggerController, recordingEngine, playbackEngine, sessionManager, consoleCapture, storageManager) {
        this.tabManager = tabManager;
        this.debuggerController = debuggerController;
        this.recordingEngine = recordingEngine;
        this.playbackEngine = playbackEngine;
        this.sessionManager = sessionManager;
        this.consoleCapture = consoleCapture;
        this.storageManager = storageManager;
        this.snapshotEngine = new SnapshotEngine(debuggerController);
        this.inputSimulator = new InputSimulator(debuggerController);
        this.actionabilityChecker = new ActionabilityChecker(debuggerController);
      }
      async handleCommand(command) {
        try {
          const result = await this.executeCommand(command);
          return {
            id: command.id,
            type: "response",
            success: true,
            result
          };
        } catch (error) {
          return {
            id: command.id,
            type: "response",
            success: false,
            error: {
              code: "EXECUTION_ERROR",
              message: error.message || "Unknown error"
            }
          };
        }
      }
      async executeCommand(command) {
        const { command: cmd, params } = command;
        switch (cmd) {
          // ─── Core tools (Playwright-inspired) ───
          case "snapshot": {
            await this.ensureDebuggerAttached(params.tabId);
            const snapshot = await this.snapshotEngine.getSnapshot(params.tabId, true);
            return { snapshot };
          }
          case "interact": {
            await this.ensureDebuggerAttached(params.tabId);
            let backendNodeId = null;
            const target = params.target;
            if (params.action !== "press") {
              if (!target || !(target.startsWith("e") && /^e\d+$/.test(target))) {
                throw new Error(
                  `Target must be a ref (e.g. "e15") from a snapshot. CSS selectors are no longer supported.`
                );
              }
              backendNodeId = await this.resolveRef(params.tabId, target);
              if (!backendNodeId) {
                throw new Error(`Ref ${target} not found in snapshot. Run snapshot first.`);
              }
              await this.actionabilityChecker.waitForActionable(
                params.tabId,
                backendNodeId,
                params.timeout
              );
            }
            switch (params.action) {
              case "click":
                await this.inputSimulator.dispatchClick(params.tabId, backendNodeId);
                break;
              case "double_click":
                await this.inputSimulator.dispatchDoubleClick(params.tabId, backendNodeId);
                break;
              case "hover":
                await this.inputSimulator.dispatchHover(params.tabId, backendNodeId);
                break;
              case "type":
                if (!params.text) throw new Error("text is required for type action");
                await this.inputSimulator.dispatchType(params.tabId, backendNodeId, params.text);
                break;
              case "press":
                if (!params.key) throw new Error("key is required for press action");
                await this.inputSimulator.dispatchPress(params.tabId, params.key);
                break;
              case "check":
                await this.inputSimulator.dispatchCheck(params.tabId, backendNodeId, true);
                break;
              case "uncheck":
                await this.inputSimulator.dispatchCheck(params.tabId, backendNodeId, false);
                break;
              default:
                throw new Error(`Unknown interact action: ${params.action}`);
            }
            if (params.action !== "hover") {
              this.snapshotEngine.invalidateCache(params.tabId);
            }
            const pageSnapshot = await this.snapshotEngine.getSnapshot(params.tabId, params.action === "hover");
            return { status: params.action, target, pageSnapshot };
          }
          case "navigate": {
            await this.ensureDebuggerAttached(params.tabId);
            switch (params.action) {
              case "goto":
                if (!params.url) throw new Error("url is required for goto action");
                await this.debuggerController.navigate(params.tabId, params.url);
                this.snapshotEngine.invalidateCache(params.tabId);
                return { status: "navigated", url: params.url };
              case "go_back": {
                const history = await this.debuggerController.sendCommand(
                  params.tabId,
                  "Page.getNavigationHistory"
                );
                if (history.currentIndex > 0) {
                  const entry = history.entries[history.currentIndex - 1];
                  await this.debuggerController.sendCommand(
                    params.tabId,
                    "Page.navigateToHistoryEntry",
                    { entryId: entry.id }
                  );
                  this.snapshotEngine.invalidateCache(params.tabId);
                  return { status: "went_back", url: entry.url };
                }
                return { status: "went_back", url: null };
              }
              case "go_forward": {
                const history = await this.debuggerController.sendCommand(
                  params.tabId,
                  "Page.getNavigationHistory"
                );
                if (history.currentIndex < history.entries.length - 1) {
                  const entry = history.entries[history.currentIndex + 1];
                  await this.debuggerController.sendCommand(
                    params.tabId,
                    "Page.navigateToHistoryEntry",
                    { entryId: entry.id }
                  );
                  this.snapshotEngine.invalidateCache(params.tabId);
                  return { status: "went_forward", url: entry.url };
                }
                return { status: "went_forward", url: null };
              }
              case "reload":
                await this.debuggerController.sendCommand(params.tabId, "Page.reload");
                this.snapshotEngine.invalidateCache(params.tabId);
                return { status: "reloaded" };
              default:
                throw new Error(`Unknown navigate action: ${params.action}`);
            }
          }
          case "get_console_logs": {
            await this.consoleCapture.enableForTab(params.tabId, this.debuggerController);
            const logs = this.consoleCapture.getLogs(params.tabId, params.minLevel);
            return { logs };
          }
          case "manage_storage": {
            const { type, action: storageAction } = params;
            switch (type) {
              case "cookie": {
                switch (storageAction) {
                  case "list":
                    return { cookies: await this.storageManager.listCookies(params.tabId, params.filterDomain) };
                  case "get":
                    return { cookie: await this.storageManager.getCookie(params.tabId, params.key) };
                  case "set":
                    await this.storageManager.setCookie(params.tabId, params.key, params.value, params.options);
                    return { status: "cookie_set" };
                  case "delete":
                    await this.storageManager.deleteCookie(params.tabId, params.key);
                    return { status: "cookie_deleted" };
                  case "clear":
                    await this.storageManager.clearCookies(params.tabId);
                    return { status: "cookies_cleared" };
                  default:
                    throw new Error(`Unknown cookie action: ${storageAction}`);
                }
              }
              case "local_storage": {
                switch (storageAction) {
                  case "list":
                    return { entries: await this.storageManager.listStorage(params.tabId, "local") };
                  case "get":
                    return { value: await this.storageManager.getStorageItem(params.tabId, "local", params.key) };
                  case "set":
                    await this.storageManager.setStorageItem(params.tabId, "local", params.key, params.value);
                    return { status: "local_storage_set" };
                  case "delete":
                    await this.storageManager.deleteStorageItem(params.tabId, "local", params.key);
                    return { status: "local_storage_deleted" };
                  case "clear":
                    await this.storageManager.clearStorage(params.tabId, "local");
                    return { status: "local_storage_cleared" };
                  default:
                    throw new Error(`Unknown local_storage action: ${storageAction}`);
                }
              }
              case "session_storage": {
                switch (storageAction) {
                  case "list":
                    return { entries: await this.storageManager.listStorage(params.tabId, "session") };
                  case "get":
                    return { value: await this.storageManager.getStorageItem(params.tabId, "session", params.key) };
                  case "set":
                    await this.storageManager.setStorageItem(params.tabId, "session", params.key, params.value);
                    return { status: "session_storage_set" };
                  case "delete":
                    await this.storageManager.deleteStorageItem(params.tabId, "session", params.key);
                    return { status: "session_storage_deleted" };
                  case "clear":
                    await this.storageManager.clearStorage(params.tabId, "session");
                    return { status: "session_storage_cleared" };
                  default:
                    throw new Error(`Unknown session_storage action: ${storageAction}`);
                }
              }
              default:
                throw new Error(`Unknown storage type: ${type}`);
            }
          }
          // ─── Utility & legacy tools ───
          case "screenshot": {
            await this.ensureDebuggerAttached(params.tabId);
            const screenshot = await this.debuggerController.screenshot(params.tabId, params.fullPage);
            return { screenshot };
          }
          case "execute_script": {
            await this.ensureDebuggerAttached(params.tabId);
            const scriptResult = await this.debuggerController.executeScript(params.tabId, params.script);
            return { result: scriptResult };
          }
          // Tab management
          case "create_tab": {
            const tabId = await this.tabManager.createTab(params.url);
            return { tabId };
          }
          case "close_tab": {
            await this.tabManager.closeTab(params.tabId);
            return { status: "closed" };
          }
          case "list_tabs": {
            const allTabs = await chrome.tabs.query({});
            return {
              tabs: allTabs.map((t) => ({
                tabId: t.id,
                url: t.url || "",
                title: t.title || "",
                active: t.active
              }))
            };
          }
          // Recording
          case "start_recording": {
            const tabs = await chrome.tabs.query({});
            if (!tabs.some((t) => t.id === params.tabId)) {
              throw new Error(`Tab ${params.tabId} not found`);
            }
            await this.ensureDebuggerAttached(params.tabId);
            const recordingId = await this.recordingEngine.startRecording(params.tabId);
            await this.recordingEngine.injectListeners(params.tabId);
            return { recordingId };
          }
          case "stop_recording": {
            await this.recordingEngine.removeListeners();
            const recording = await this.recordingEngine.stopRecording();
            return { recording };
          }
          case "replay_recording": {
            let replayTabId = params.tabId;
            if (replayTabId == null) {
              const allTabs = await chrome.tabs.query({});
              if (allTabs.length > 0) {
                replayTabId = allTabs[0].id;
              } else {
                replayTabId = await this.tabManager.createTab();
              }
            }
            await this.ensureDebuggerAttached(replayTabId);
            await this.playbackEngine.replay(params.recordingId, replayTabId);
            return { status: "replayed", tabId: replayTabId };
          }
          // Session
          case "save_session": {
            const sessionId = await this.sessionManager.saveSession(params.name);
            return { sessionId };
          }
          case "restore_session": {
            await this.sessionManager.restoreSession(params.sessionId);
            return { status: "restored" };
          }
          default:
            throw new Error(`Unknown command: ${cmd}`);
        }
      }
      async ensureDebuggerAttached(tabId) {
        await this.tabManager.ensureDebuggerAttached(tabId);
      }
      async resolveRef(tabId, ref) {
        try {
          const snapshot = await this.snapshotEngine.getSnapshot(tabId, true);
          return snapshot.refs[ref]?.backendNodeId || null;
        } catch {
          return null;
        }
      }
    };
  }
});

// src/background/service-worker.ts
var require_service_worker = __commonJS({
  "src/background/service-worker.ts"() {
    init_websocket_client();
    init_tab_manager();
    init_debugger_controller();
    init_recording_engine();
    init_playback_engine();
    init_session_manager();
    init_console_capture();
    init_storage_manager();
    init_command_handler();
    var DEFAULT_WS_URL = "ws://localhost:8765";
    var wsClient = new WebSocketClient();
    var tabManager = new TabManager();
    var debuggerController = new DebuggerController();
    var recordingEngine = new RecordingEngine(debuggerController);
    var playbackEngine = new PlaybackEngine(debuggerController);
    var sessionManager = new SessionManager();
    var consoleCapture = new ConsoleCapture();
    var storageManager = new StorageManager();
    var commandHandler = new CommandHandler(
      tabManager,
      debuggerController,
      recordingEngine,
      playbackEngine,
      sessionManager,
      consoleCapture,
      storageManager
    );
    async function loadConfig() {
      try {
        const result = await chrome.storage.local.get(["arc_tunnel_ws_url"]);
        return result.arc_tunnel_ws_url || DEFAULT_WS_URL;
      } catch {
        return DEFAULT_WS_URL;
      }
    }
    async function initialize() {
      if (wsClient.isConnected()) {
        return;
      }
      const wsUrl = await loadConfig();
      wsClient.setUrl(wsUrl);
      try {
        await wsClient.connect();
        await tabManager.syncExistingTabs();
        console.log("Arc Tunnel extension initialized");
      } catch (error) {
        console.error("Failed to connect to MCP server:", error);
      }
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.arc_tunnel_ws_url) {
        const newUrl = changes.arc_tunnel_ws_url.newValue || DEFAULT_WS_URL;
        console.log(`WebSocket URL changed to: ${newUrl}`);
        wsClient.setUrl(newUrl);
        if (!wsClient.isConnected()) {
          initialize();
        }
      }
    });
    wsClient.onCommand(async (command) => {
      console.log("Received command:", command.command);
      const response = await commandHandler.handleCommand(command);
      wsClient.sendResponse(response);
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "get_status") {
        sendResponse({ connected: wsClient.isConnected() });
        return true;
      }
    });
    chrome.alarms.create("keepAlive", { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "keepAlive") {
        if (wsClient.isConnected()) {
          wsClient.sendEvent({ type: "event", event: "heartbeat", data: {}, timestamp: Date.now() });
        }
      } else if (alarm.name === "ws-reconnect") {
        if (!wsClient.isConnected()) {
          console.log("[alarm] SW wakeup \u2014 attempting reconnect");
          initialize();
        }
      }
    });
    chrome.runtime.onSuspend.addListener(() => {
      console.log("Service worker suspending");
      wsClient.disconnect();
    });
    initialize();
    console.log("Arc Tunnel service worker loaded");
  }
});
export default require_service_worker();
