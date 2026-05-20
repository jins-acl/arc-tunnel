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
      constructor(url = "ws://localhost:8765") {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1e3;
        this.maxReconnectDelay = 3e4;
        this.messageHandlers = /* @__PURE__ */ new Map();
        this.intentionalClose = false;
        this.url = url;
      }
      async connect() {
        return new Promise((resolve, reject) => {
          this.ws = new WebSocket(this.url);
          this.ws.onopen = () => {
            console.log("Connected to MCP server");
            this.reconnectAttempts = 0;
            resolve();
          };
          this.ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            reject(error);
          };
          this.ws.onclose = () => {
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
        const delay = Math.min(
          this.reconnectDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1e3,
          this.maxReconnectDelay
        );
        this.reconnectAttempts++;
        console.log(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(async () => {
          try {
            await this.connect();
          } catch (error) {
            console.error("Reconnect failed:", error);
          }
        }, delay);
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
          });
          chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            const existing = this.tabs.get(tabId);
            if (existing) {
              if (changeInfo.url) existing.url = changeInfo.url;
              if (changeInfo.title) existing.title = changeInfo.title;
            }
          });
          this.listenersSetup = true;
        }
      }
      async attachDebugger(tabId) {
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
      async switchTab(tabId) {
        await chrome.tabs.update(tabId, { active: true });
        this.activeTabId = tabId;
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
        await this.sendCommand(tabId, "Page.navigate", { url });
        await this.sendCommand(tabId, "Page.enable");
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
          throw new Error(result.exceptionDetails.text || "Script execution error");
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
            text: document.body ? document.body.innerText.substring(0, 2000) : '',
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
    };
  }
});

// src/background/recording-engine.ts
var RecordingEngine;
var init_recording_engine = __esm({
  "src/background/recording-engine.ts"() {
    "use strict";
    RecordingEngine = class {
      constructor() {
        this.isRecording = false;
        this.currentRecording = null;
        this.startTime = 0;
      }
      async startRecording(tabId) {
        const recordingId = crypto.randomUUID();
        this.startTime = Date.now();
        this.currentRecording = {
          id: recordingId,
          name: `Recording ${(/* @__PURE__ */ new Date()).toISOString()}`,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          actions: [],
          metadata: {
            startUrl: "",
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
        await chrome.storage.local.set({
          [`recording_${recording.id}`]: recording
        });
        console.log(`Stopped recording: ${recording.id}`);
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

// src/background/command-handler.ts
var CommandHandler;
var init_command_handler = __esm({
  "src/background/command-handler.ts"() {
    "use strict";
    CommandHandler = class {
      constructor(tabManager, debuggerController, recordingEngine, playbackEngine, sessionManager) {
        this.tabManager = tabManager;
        this.debuggerController = debuggerController;
        this.recordingEngine = recordingEngine;
        this.playbackEngine = playbackEngine;
        this.sessionManager = sessionManager;
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
          // Navigation and interaction
          case "navigate":
            await this.ensureDebuggerAttached(params.tabId);
            await this.debuggerController.navigate(params.tabId, params.url);
            return { status: "navigated", url: params.url };
          case "click":
            await this.ensureDebuggerAttached(params.tabId);
            await this.debuggerController.click(params.tabId, params.selector);
            return { status: "clicked", selector: params.selector };
          case "type":
            await this.ensureDebuggerAttached(params.tabId);
            await this.debuggerController.type(params.tabId, params.selector, params.text);
            return { status: "typed", selector: params.selector };
          case "screenshot":
            await this.ensureDebuggerAttached(params.tabId);
            const screenshot = await this.debuggerController.screenshot(params.tabId, params.fullPage);
            return { screenshot };
          case "get_content":
            await this.ensureDebuggerAttached(params.tabId);
            const content = await this.debuggerController.getContent(params.tabId, params.mode);
            return { content };
          case "execute_script":
            await this.ensureDebuggerAttached(params.tabId);
            const scriptResult = await this.debuggerController.executeScript(params.tabId, params.script);
            return { result: scriptResult };
          case "wait_for_element":
            await this.ensureDebuggerAttached(params.tabId);
            const found = await this.debuggerController.waitForElement(
              params.tabId,
              params.selector,
              params.timeout || 1e4
            );
            return { found, selector: params.selector };
          // Tab management
          case "create_tab":
            const tabId = await this.tabManager.createTab(params.url);
            return { tabId };
          case "close_tab":
            await this.tabManager.closeTab(params.tabId);
            return { status: "closed" };
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
          case "start_recording":
            const recordingId = await this.recordingEngine.startRecording(params.tabId);
            return { recordingId };
          case "stop_recording":
            const recording = await this.recordingEngine.stopRecording();
            return { recording };
          case "replay_recording":
            let replayTabId = params.tabId;
            if (replayTabId == null) {
              const tabs = this.tabManager.listTabs();
              if (tabs.length > 0) {
                replayTabId = tabs[0].id;
              } else {
                replayTabId = await this.tabManager.createTab();
              }
            }
            await this.playbackEngine.replay(params.recordingId, replayTabId);
            return { status: "replayed", tabId: replayTabId };
          // Session
          case "save_session":
            const sessionId = await this.sessionManager.saveSession(params.name);
            return { sessionId };
          case "restore_session":
            await this.sessionManager.restoreSession(params.sessionId);
            return { status: "restored" };
          default:
            throw new Error(`Unknown command: ${cmd}`);
        }
      }
      async ensureDebuggerAttached(tabId) {
        if (!this.tabManager.isDebuggerAttached(tabId)) {
          await this.tabManager.attachDebugger(tabId);
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
    init_command_handler();
    var wsClient = new WebSocketClient("ws://localhost:8765");
    var tabManager = new TabManager();
    var debuggerController = new DebuggerController();
    var recordingEngine = new RecordingEngine();
    var playbackEngine = new PlaybackEngine(debuggerController);
    var sessionManager = new SessionManager();
    var commandHandler = new CommandHandler(
      tabManager,
      debuggerController,
      recordingEngine,
      playbackEngine,
      sessionManager
    );
    async function initialize() {
      try {
        await wsClient.connect();
        await tabManager.syncExistingTabs();
        console.log("Web Bridge extension initialized");
      } catch (error) {
        console.error("Failed to connect to MCP server:", error);
      }
    }
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
      }
    });
    chrome.runtime.onSuspend.addListener(() => {
      console.log("Service worker suspending");
      wsClient.disconnect();
    });
    initialize();
    console.log("Web Bridge service worker loaded");
  }
});
export default require_service_worker();
