// extension/src/background/service-worker.ts
import { WebSocketClient } from './websocket-client';
import { TabManager } from './tab-manager';
import { DebuggerController } from './debugger-controller';
import { RecordingEngine } from './recording-engine';
import { PlaybackEngine } from './playback-engine';
import { SessionManager } from './session-manager';
import { CommandHandler } from './command-handler';
import { CommandMessage } from '../types';

// Initialize components
const wsClient = new WebSocketClient('ws://localhost:8765');
const tabManager = new TabManager();
const debuggerController = new DebuggerController();
const recordingEngine = new RecordingEngine();
const playbackEngine = new PlaybackEngine(debuggerController);
const sessionManager = new SessionManager();
const commandHandler = new CommandHandler(
  tabManager,
  debuggerController,
  recordingEngine,
  playbackEngine,
  sessionManager
);

// Connect to MCP server
async function initialize() {
  try {
    await wsClient.connect();
    console.log('Web Bridge extension initialized');
  } catch (error) {
    console.error('Failed to connect to MCP server:', error);
    // Reconnection is handled by WebSocketClient exponential backoff
  }
}

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

// Keep service worker alive
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    console.log('Service worker keepalive');
  }
});

// Initialize on startup
initialize();

console.log('Web Bridge service worker loaded');
