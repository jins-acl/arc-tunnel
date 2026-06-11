// extension/src/background/service-worker.ts
import { WebSocketClient } from './websocket-client';
import { TabManager } from './tab-manager';
import { DebuggerController } from './debugger-controller';
import { RecordingEngine } from './recording-engine';
import { PlaybackEngine } from './playback-engine';
import { SessionManager } from './session-manager';
import { ConsoleCapture } from './console-capture';
import { StorageManager } from './storage-manager';
import { CommandHandler } from './command-handler';
import { CommandMessage } from '../types';

// Default configuration
const DEFAULT_WS_URL = 'ws://localhost:8765';

// Initialize components
const wsClient = new WebSocketClient();
const tabManager = new TabManager();
const debuggerController = new DebuggerController();
const recordingEngine = new RecordingEngine(debuggerController);
const playbackEngine = new PlaybackEngine(debuggerController);
const sessionManager = new SessionManager();
const consoleCapture = new ConsoleCapture();
const storageManager = new StorageManager();
const commandHandler = new CommandHandler(
  tabManager,
  debuggerController,
  recordingEngine,
  playbackEngine,
  sessionManager,
  consoleCapture,
  storageManager
);

// Load configuration from storage
async function loadConfig(): Promise<string> {
  try {
    const result = await chrome.storage.local.get(['arc_tunnel_ws_url']);
    return result.arc_tunnel_ws_url || DEFAULT_WS_URL;
  } catch {
    return DEFAULT_WS_URL;
  }
}

// Connect to MCP server
async function initialize() {
  if (wsClient.isConnected()) {
    return;
  }

  const wsUrl = await loadConfig();
  wsClient.setUrl(wsUrl);

  try {
    await wsClient.connect();
    // Auto-discover existing tabs
    await tabManager.syncExistingTabs();
    console.log('Arc Tunnel extension initialized');
  } catch (error) {
    console.error('Failed to connect to MCP server:', error);
    // Reconnection is handled by WebSocketClient exponential backoff
  }
}

// Listen for configuration changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.arc_tunnel_ws_url) {
    const newUrl = changes.arc_tunnel_ws_url.newValue || DEFAULT_WS_URL;
    console.log(`WebSocket URL changed to: ${newUrl}`);
    wsClient.setUrl(newUrl);
    // Trigger reconnect
    if (!wsClient.isConnected()) {
      initialize();
    }
  }
});

// Handle commands from MCP server
wsClient.onCommand(async (command: CommandMessage) => {
  console.log('Received command:', command.command);
  const response = await commandHandler.handleCommand(command);
  wsClient.sendResponse(response);
});

// Respond to popup status queries
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'get_status') {
    sendResponse({ connected: wsClient.isConnected() });
    return true; // Keep channel open for async response
  }
});

// Keep service worker alive via alarm (Chrome clamps to >=1 minute)
// The WebSocket connection itself keeps the SW alive while connected;
// this alarm catches the gap when WebSocket drops and SW would die
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    if (wsClient.isConnected()) {
      wsClient.sendEvent({ type: 'event', event: 'heartbeat', data: {}, timestamp: Date.now() });
    }
  } else if (alarm.name === 'ws-reconnect') {
    // SW was terminated during a reconnect delay — retry now
    if (!wsClient.isConnected()) {
      console.log('[alarm] SW wakeup — attempting reconnect');
      // Direct connection attempt (WebSocketClient.handleReconnect will be
      // called via onclose; this is just for the case where SW died mid-delay)
      initialize();
    }
  }
});

// Handle SW suspension — clean up before being killed
chrome.runtime.onSuspend.addListener(() => {
  console.log('Service worker suspending');
  wsClient.disconnect();
});

// Initialize on startup
initialize();

console.log('Arc Tunnel service worker loaded');
