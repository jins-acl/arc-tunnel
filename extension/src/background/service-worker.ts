// extension/src/background/service-worker.ts
import { resolveConfiguredWebSocketUrl, WebSocketClient } from './websocket-client';
import { TabManager } from './tab-manager';
import { DebuggerController } from './debugger-controller';
import { RecordingEngine } from './recording-engine';
import { PlaybackEngine } from './playback-engine';
import { SessionManager } from './session-manager';
import { ConsoleCapture } from './console-capture';
import { StorageManager } from './storage-manager';
import { CommandHandler } from './command-handler';
import { LightweightController } from './lightweight-controller';
import { CommandMessage } from '../types';

// Initialize components
const wsClient = new WebSocketClient();
const tabManager = new TabManager();
const debuggerController = new DebuggerController();
const recordingEngine = new RecordingEngine(debuggerController);
const playbackEngine = new PlaybackEngine(debuggerController);
const sessionManager = new SessionManager();
const consoleCapture = new ConsoleCapture();
const storageManager = new StorageManager();
const lightweightController = new LightweightController();
let initializationComplete = false;
let pendingWsUrl: string | null = null;
const commandHandler = new CommandHandler(
  tabManager,
  debuggerController,
  recordingEngine,
  playbackEngine,
  sessionManager,
  consoleCapture,
  storageManager,
  lightweightController
);

// Load configuration from storage
async function loadConfig(): Promise<string> {
  try {
    const result = await chrome.storage.local.get(['arc_tunnel_ws_url']);
    const savedUrl = result.arc_tunnel_ws_url;
    const resolvedUrl = resolveConfiguredWebSocketUrl(savedUrl);
    if (typeof savedUrl === 'string' && savedUrl !== resolvedUrl) {
      await chrome.storage.local.set({ arc_tunnel_ws_url: resolvedUrl });
    }
    return resolvedUrl;
  } catch {
    return resolveConfiguredWebSocketUrl(undefined);
  }
}

// Connect to MCP server
async function initialize() {
  const loadedWsUrl = await loadConfig();
  if (pendingWsUrl === null) pendingWsUrl = loadedWsUrl;
  await tabManager.syncExistingTabs();

  initializationComplete = true;
  wsClient.setUrl(pendingWsUrl ?? loadedWsUrl);
  await connectClient();
}

async function connectClient(): Promise<void> {
  if (!initializationComplete) return;
  try {
    await wsClient.connect();
    console.log('Arc Tunnel extension initialized');
  } catch (error) {
    console.error('Failed to connect to MCP server:', error);
    // Reconnection is handled by WebSocketClient exponential backoff
  }
}

// Listen for configuration changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.arc_tunnel_ws_url) {
    const newUrl = resolveConfiguredWebSocketUrl(changes.arc_tunnel_ws_url.newValue);
    console.log(`WebSocket URL changed to: ${newUrl}`);
    pendingWsUrl = newUrl;
    if (!initializationComplete) return;
    wsClient.setUrl(newUrl);
    void connectClient();
  }
});

// Handle commands from MCP server
wsClient.onCommand(async (command: CommandMessage) => {
  console.log('Received command:', command.command);
  const response = await commandHandler.handleCommand(command);
  wsClient.sendResponse(response);
});

tabManager.onLifecycle((event, data) => {
  wsClient.sendEvent({ type: 'event', event, data, timestamp: Date.now() });
});

// Respond to popup status queries
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'get_status') {
    sendResponse({ connected: wsClient.isConnected() });
    return true; // Keep channel open for async response
  }
});

// WebSocketClient sends a 10-second heartbeat while connected. Keep this
// one-minute alarm as the recovery wakeup after the service worker is terminated.
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    if (wsClient.isConnected()) {
      wsClient.sendEvent({ type: 'event', event: 'heartbeat', data: {}, timestamp: Date.now() });
    }
  } else if (alarm.name === 'ws-reconnect') {
    // SW was terminated during a reconnect delay — retry now
    if (initializationComplete && !wsClient.isConnected()) {
      console.log('[alarm] SW wakeup — attempting reconnect');
      void connectClient();
    }
  }
});

// Close the current socket while preserving a persistent reconnect wakeup.
chrome.runtime.onSuspend.addListener(() => {
  console.log('Service worker suspending');
  wsClient.prepareForSuspend();
});

// Initialize on startup
initialize();

console.log('Arc Tunnel service worker loaded');
