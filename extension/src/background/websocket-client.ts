import { CommandMessage, ResponseMessage, EventMessage, HelloMessage } from '../types';
import { isValidAuthToken } from '../auth-token';
import {
  DEFAULT_WS_URL,
  normalizeWebSocketUrl,
  resolveConfiguredWebSocketUrl
} from '../websocket-url';

export { isValidAuthToken } from '../auth-token';
export {
  DEFAULT_WS_URL,
  normalizeWebSocketUrl,
  resolveConfiguredWebSocketUrl
} from '../websocket-url';
const HEARTBEAT_INTERVAL_MS = 10_000;
const AUTHENTICATION_FAILED_MESSAGE = 'Broker authentication failed';
const INVALID_WEBSOCKET_URL_MESSAGE =
  'Arc Tunnel WebSocket URL must use the explicit IPv4 loopback endpoint';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'auth_failed';

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string | null;
  private token: string;
  private rejectedToken: string | null = null;
  private authFailureHandler: ((token: string) => void) | null = null;
  private connectionState: ConnectionState = 'idle';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private persistentReconnectDelay = 60000;
  private messageHandlers: Map<string, (message: any) => void> = new Map();
  private intentionalClose = false;
  private connectionGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectPromise: Promise<void> | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private handshakeComplete = false;

  constructor(url?: string, token = '') {
    this.url = normalizeWebSocketUrl(url);
    this.token = this.url === null ? '' : token;
  }

  setUrl(url: string): void {
    const normalizedUrl = normalizeWebSocketUrl(url);
    if (normalizedUrl === null) {
      this.invalidateConfig();
      return;
    }
    if (normalizedUrl === this.url) return;
    this.replaceConfig(normalizedUrl, this.token, false);
  }

  setConfig(url: string, token: string): boolean {
    const normalizedUrl = normalizeWebSocketUrl(url);
    if (normalizedUrl === null || !isValidAuthToken(token)) {
      this.invalidateConfig();
      return false;
    }
    if (normalizedUrl === this.url && token === this.token) return false;

    this.replaceConfig(normalizedUrl, token, token !== this.token);
    return true;
  }

  setAuthFailureHandler(handler: (token: string) => void): void {
    this.authFailureHandler = handler;
  }

  restoreRejectedToken(token: unknown): boolean {
    if (!isValidAuthToken(token) || token !== this.token) return false;
    this.rejectedToken = token;
    this.disconnect();
    return true;
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  canReconnect(): boolean {
    return !this.isCurrentTokenRejected();
  }

  private replaceConfig(normalizedUrl: string | null, token: string, tokenChanged: boolean): void {
    ++this.connectionGeneration;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    chrome.alarms.clear('ws-reconnect');
    this.intentionalClose = true;
    const oldSocket = this.ws;
    this.ws = null;
    this.handshakeComplete = false;
    this.rejectPendingConnect(new Error('Connection superseded by configuration change'));
    oldSocket?.close();
    this.url = normalizedUrl;
    this.token = token;
    if (tokenChanged) this.rejectedToken = null;
    this.connectionState = this.isCurrentTokenRejected() ? 'auth_failed' : 'idle';
    this.intentionalClose = false;
  }

  private invalidateConfig(): void {
    if (this.url === null && this.token === '') return;
    this.replaceConfig(null, '', true);
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;
    if (this.url === null) {
      this.connectionState = 'idle';
      throw new Error(INVALID_WEBSOCKET_URL_MESSAGE);
    }
    if (this.isCurrentTokenRejected()) {
      this.connectionState = 'auth_failed';
      throw new Error(AUTHENTICATION_FAILED_MESSAGE);
    }

    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    const generation = ++this.connectionGeneration;
    this.intentionalClose = false;
    this.handshakeComplete = false;
    this.connectionState = 'connecting';
    const connectionUrl = this.url;

    this.connectPromise = new Promise((resolve, reject) => {
      this.rejectConnect = reject;
      const socket = new WebSocket(connectionUrl);
      this.ws = socket;

      const resolveConnect = () => {
        if (generation !== this.connectionGeneration) return;
        this.connectPromise = null;
        this.rejectConnect = null;
        this.connectionState = 'connected';
        resolve();
      };

      const rejectCurrentConnect = (error: Error) => {
        if (generation !== this.connectionGeneration) return;
        this.connectPromise = null;
        this.rejectConnect = null;
        reject(error);
      };

      const failHandshake = (error: Error) => {
        if (generation !== this.connectionGeneration) return;
        rejectCurrentConnect(error);
        ++this.connectionGeneration;
        this.clearReconnectTimer();
        this.clearHeartbeatTimer();
        chrome.alarms.clear('ws-reconnect');
        if (this.ws === socket) this.ws = null;
        this.handshakeComplete = false;
        this.connectionState = 'idle';
        socket.close();
      };

      socket.onopen = () => {
        if (generation !== this.connectionGeneration) return;
        console.log('Connected to Arc Tunnel broker');
        this.intentionalClose = false;
        const hello: HelloMessage = {
          type: 'hello',
          role: 'extension',
          protocolVersion: 2,
          token: this.token
        };
        socket.send(JSON.stringify(hello));
      };

      socket.onerror = () => {
        if (generation !== this.connectionGeneration) return;
        console.error('WebSocket error');
      };

      socket.onclose = (event) => {
        if (event.code === 1008 && event.reason === 'AUTH_FAILED') {
          this.enterAuthFailed(generation, socket);
          return;
        }
        if (generation !== this.connectionGeneration || this.intentionalClose) return;
        console.log('Disconnected from Arc Tunnel broker');
        this.clearHeartbeatTimer();
        this.ws = null;
        this.handshakeComplete = false;
        this.connectionState = 'idle';
        rejectCurrentConnect(new Error('WebSocket closed before handshake completed'));
        this.handleReconnect(generation);
      };

      socket.onmessage = (event) => {
        if (generation !== this.connectionGeneration) return;
        try {
          const message = JSON.parse(event.data);
          if (!this.handshakeComplete) {
            if (message.type === 'welcome') {
              if (message.protocolVersion !== 2) {
                failHandshake(new Error('Arc Tunnel protocol mismatch: expected welcome protocolVersion 2'));
                return;
              }
              this.handshakeComplete = true;
              this.reconnectAttempts = 0;
              this.clearReconnectTimer();
              chrome.alarms.clear('ws-reconnect');
              this.startHeartbeat(generation, socket);
              resolveConnect();
            }
            return;
          }
          this.handleMessage(message as CommandMessage);
        } catch (error) {
          if (!this.handshakeComplete) {
            failHandshake(new Error('Invalid Arc Tunnel handshake message: malformed JSON'));
            return;
          }
          console.error('Failed to parse message:', error);
        }
      };
    });

    return this.connectPromise;
  }

  disconnect(): void {
    ++this.connectionGeneration;
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    chrome.alarms.clear('ws-reconnect');
    const socket = this.ws;
    this.ws = null;
    this.handshakeComplete = false;
    this.rejectPendingConnect(new Error('Connection closed intentionally'));
    this.connectionState = this.isCurrentTokenRejected() ? 'auth_failed' : 'idle';
    socket?.close();
  }

  prepareForSuspend(): void {
    if (this.isCurrentTokenRejected()) {
      this.clearReconnectTimer();
      this.clearHeartbeatTimer();
      chrome.alarms.clear('ws-reconnect');
      this.connectionState = 'auth_failed';
      return;
    }

    const generation = ++this.connectionGeneration;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    const socket = this.ws;
    this.ws = null;
    this.handshakeComplete = false;
    this.connectionState = 'idle';
    this.rejectPendingConnect(new Error('Service worker suspended'));
    this.handleReconnect(generation);
    socket?.close();
  }

  isConnected(): boolean {
    return this.handshakeComplete && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  sendResponse(response: ResponseMessage): void {
    if (this.isConnected()) this.ws!.send(JSON.stringify(response));
  }

  sendEvent(event: EventMessage): void {
    if (this.isConnected()) this.ws!.send(JSON.stringify(event));
  }

  onCommand(handler: (message: CommandMessage) => void): void {
    this.messageHandlers.set('command', handler);
  }

  private handleMessage(message: CommandMessage): void {
    if (message.type !== 'command') return;
    const handler = this.messageHandlers.get('command');
    if (handler) handler(message);
  }

  private handleReconnect(generation: number): void {
    if (
      generation !== this.connectionGeneration ||
      this.intentionalClose ||
      this.reconnectTimer ||
      this.isCurrentTokenRejected()
    ) return;

    const fastRetriesExhausted = this.reconnectAttempts >= this.maxReconnectAttempts;
    const delay = fastRetriesExhausted
      ? this.persistentReconnectDelay
      : Math.min(
        this.reconnectDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
        this.maxReconnectDelay
      );
    if (!fastRetriesExhausted) this.reconnectAttempts++;

    console.log(fastRetriesExhausted
      ? `Fast reconnect attempts exhausted; retrying in ${Math.round(delay)}ms`
      : `Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (
        generation !== this.connectionGeneration ||
        this.intentionalClose ||
        this.isCurrentTokenRejected()
      ) return;
      try {
        await this.connect();
      } catch (error) {
        console.error('Reconnect failed:', error);
      }
    }, delay);

    chrome.alarms.create('ws-reconnect', { delayInMinutes: Math.ceil(delay / 60000) || 1 });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(generation: number, socket: WebSocket): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (
        generation !== this.connectionGeneration ||
        this.ws !== socket ||
        !this.handshakeComplete ||
        socket.readyState !== WebSocket.OPEN
      ) return;

      const heartbeat: EventMessage = {
        type: 'event',
        event: 'heartbeat',
        data: {},
        timestamp: Date.now()
      };
      try {
        socket.send(JSON.stringify(heartbeat));
      } catch (error) {
        this.recoverFromHeartbeatFailure(generation, socket, error);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private recoverFromHeartbeatFailure(generation: number, socket: WebSocket, error: unknown): void {
    if (
      generation !== this.connectionGeneration ||
      this.ws !== socket ||
      !this.handshakeComplete
    ) return;

    console.error('WebSocket heartbeat send failed:', error);
    this.clearHeartbeatTimer();
    this.ws = null;
    this.handshakeComplete = false;
    this.connectionState = 'idle';
    const reconnectGeneration = ++this.connectionGeneration;
    try {
      socket.close();
    } catch (closeError) {
      console.error('Failed to close WebSocket after heartbeat failure:', closeError);
    }
    this.handleReconnect(reconnectGeneration);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private rejectPendingConnect(error: Error): void {
    const reject = this.rejectConnect;
    this.rejectConnect = null;
    this.connectPromise = null;
    reject?.(error);
  }

  private enterAuthFailed(generation: number, socket: WebSocket): void {
    if (generation !== this.connectionGeneration || this.ws !== socket) return;

    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    chrome.alarms.clear('ws-reconnect');
    this.rejectedToken = this.token;
    this.ws = null;
    this.handshakeComplete = false;
    this.connectionState = 'auth_failed';
    try {
      this.authFailureHandler?.(this.token);
    } catch {
      console.error('Failed to persist Arc Tunnel authentication failure state');
    }
    this.rejectPendingConnect(new Error(AUTHENTICATION_FAILED_MESSAGE));
  }

  private isCurrentTokenRejected(): boolean {
    return this.rejectedToken !== null && this.token === this.rejectedToken;
  }
}
