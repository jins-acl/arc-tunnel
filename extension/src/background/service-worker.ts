// extension/src/background/service-worker.ts
import { WebSocketClient } from './websocket-client';
import { isValidAuthToken } from '../auth-token';
import {
  normalizeWebSocketUrl,
  resolveConfiguredWebSocketUrl
} from '../websocket-url';
import { TabManager } from './tab-manager';
import { DebuggerController } from './debugger-controller';
import { RecordingEngine } from './recording-engine';
import { PlaybackEngine } from './playback-engine';
import { SessionManager } from './session-manager';
import { ConsoleCapture } from './console-capture';
import { StorageManager } from './storage-manager';
import { CommandHandler } from './command-handler';
import { LightweightController } from './lightweight-controller';
import { bindConsoleCaptureCleanup } from './lifecycle-cleanup';
import { CommandMessage } from '../types';

const STORAGE_KEYS = ['arc_tunnel_ws_url', 'authToken'] as const;
const REJECTED_AUTH_TOKEN_KEY = 'arc_tunnel_rejected_auth_token';

interface StoredConnectionConfig {
  wsUrl: string;
  authToken: string;
}

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
bindConsoleCaptureCleanup(tabManager, consoleCapture);
let initializationComplete = false;
let pendingConfig: StoredConnectionConfig | null = null;
let initializationPatch: Partial<StoredConnectionConfig> = {};
let activeConfigValid = false;
let configApplicationGeneration = 0;
let persistedRejectedToken: string | null = null;
let rejectionMarkerUpdate: Promise<void> = Promise.resolve();
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

function queueRejectedTokenWrite(token: string): void {
  persistedRejectedToken = token;
  rejectionMarkerUpdate = rejectionMarkerUpdate
    .catch(() => undefined)
    .then(() => chrome.storage.session.set({
      [REJECTED_AUTH_TOKEN_KEY]: token
    }))
    .catch(() => {
      console.error('Failed to persist Arc Tunnel authentication failure state');
    });
}

async function clearRejectedTokenMarker(): Promise<void> {
  persistedRejectedToken = null;
  rejectionMarkerUpdate = rejectionMarkerUpdate
    .catch(() => undefined)
    .then(() => chrome.storage.session.remove([REJECTED_AUTH_TOKEN_KEY]))
    .catch(() => {
      console.error('Failed to clear Arc Tunnel authentication failure state');
    });
  await rejectionMarkerUpdate;
}

async function loadRejectedTokenMarker(): Promise<string | null> {
  try {
    const result = await chrome.storage.session.get([REJECTED_AUTH_TOKEN_KEY]);
    const token = result[REJECTED_AUTH_TOKEN_KEY];
    return isValidAuthToken(token) ? token : null;
  } catch {
    return null;
  }
}

wsClient.setAuthFailureHandler(queueRejectedTokenWrite);

// Load configuration from storage
async function loadConfig(): Promise<StoredConnectionConfig> {
  try {
    const result = await chrome.storage.local.get([...STORAGE_KEYS]);
    const savedUrl = result.arc_tunnel_ws_url;
    const resolvedUrl = resolveConfiguredWebSocketUrl(savedUrl);
    const normalizedUrl = normalizeWebSocketUrl(resolvedUrl);
    const config = {
      wsUrl: normalizedUrl ?? resolvedUrl,
      authToken: typeof result.authToken === 'string' ? result.authToken : ''
    };
    if (
      typeof savedUrl === 'string' &&
      savedUrl !== resolvedUrl &&
      normalizedUrl !== null &&
      savedUrl !== normalizedUrl
    ) {
      await chrome.storage.local.set({
        arc_tunnel_ws_url: normalizedUrl,
        authToken: config.authToken
      });
    }
    return config;
  } catch {
    return {
      wsUrl: resolveConfiguredWebSocketUrl(undefined),
      authToken: ''
    };
  }
}

async function applyConnectionConfig(config: StoredConnectionConfig): Promise<void> {
  const applicationGeneration = ++configApplicationGeneration;
  const normalizedUrl = normalizeWebSocketUrl(config.wsUrl);
  const tokenIsValid = isValidAuthToken(config.authToken);
  activeConfigValid = normalizedUrl !== null && tokenIsValid;

  if (
    tokenIsValid &&
    persistedRejectedToken !== null &&
    persistedRejectedToken !== config.authToken
  ) {
    await clearRejectedTokenMarker();
    if (applicationGeneration !== configApplicationGeneration) return;
  }

  wsClient.setConfig(config.wsUrl, config.authToken);
  if (!activeConfigValid) return;

  if (
    persistedRejectedToken === config.authToken ||
    !wsClient.canReconnect()
  ) {
    if (persistedRejectedToken !== config.authToken) {
      queueRejectedTokenWrite(config.authToken);
    }
    wsClient.restoreRejectedToken(config.authToken);
    return;
  }

  await connectClient();
}

// Connect to MCP server
async function initialize() {
  const [loadedConfig, rejectedToken] = await Promise.all([
    loadConfig(),
    loadRejectedTokenMarker()
  ]);
  persistedRejectedToken = rejectedToken;
  pendingConfig = { ...loadedConfig, ...initializationPatch };
  await tabManager.syncExistingTabs();

  initializationComplete = true;
  const config = pendingConfig;
  await applyConnectionConfig(config);
}

async function connectClient(): Promise<void> {
  if (!initializationComplete || !activeConfigValid) return;
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
  if (
    area !== 'local' ||
    (!changes.arc_tunnel_ws_url && !changes.authToken)
  ) return;

  const patch: Partial<StoredConnectionConfig> = {};
  if (changes.arc_tunnel_ws_url) {
    patch.wsUrl = resolveConfiguredWebSocketUrl(changes.arc_tunnel_ws_url.newValue);
  }
  if (changes.authToken) {
    patch.authToken = typeof changes.authToken.newValue === 'string'
      ? changes.authToken.newValue
      : '';
  }

  if (!initializationComplete) {
    initializationPatch = { ...initializationPatch, ...patch };
    if (pendingConfig !== null) {
      pendingConfig = { ...pendingConfig, ...patch };
    }
    return;
  }

  if (pendingConfig === null) return;
  const nextConfig = { ...pendingConfig, ...patch };
  pendingConfig = nextConfig;

  void applyConnectionConfig(nextConfig);
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
    sendResponse({
      connected: wsClient.isConnected(),
      state: wsClient.getConnectionState()
    });
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
    // The service worker may have terminated during a reconnect delay.
    if (
      initializationComplete &&
      activeConfigValid &&
      !wsClient.isConnected() &&
      wsClient.canReconnect()
    ) {
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
