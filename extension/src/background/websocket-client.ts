import { CommandMessage, ResponseMessage, EventMessage, HelloMessage } from '../types';

export const DEFAULT_WS_URL = 'ws://127.0.0.1:8765';
const HEARTBEAT_INTERVAL_MS = 10_000;

const LEGACY_DEFAULT_URLS = new Map([
  ['ws://localhost:8765', DEFAULT_WS_URL],
  ['ws://localhost:8765/', DEFAULT_WS_URL],
  ['ws://localhost:8765/extension', `${DEFAULT_WS_URL}/extension`]
]);

export function resolveConfiguredWebSocketUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_WS_URL;
  return LEGACY_DEFAULT_URLS.get(value) ?? value;
}

export function normalizeWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.pathname !== '/') return url;
  parsed.pathname = '/extension';
  return parsed.toString();
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
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

  constructor(url?: string) {
    this.url = normalizeWebSocketUrl(resolveConfiguredWebSocketUrl(url));
  }

  setUrl(url: string): void {
    const normalizedUrl = normalizeWebSocketUrl(resolveConfiguredWebSocketUrl(url));
    if (normalizedUrl === this.url) return;

    ++this.connectionGeneration;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    chrome.alarms.clear('ws-reconnect');
    this.intentionalClose = true;
    const oldSocket = this.ws;
    this.ws = null;
    this.handshakeComplete = false;
    this.rejectPendingConnect(new Error('Connection superseded by URL change'));
    oldSocket?.close();
    this.url = normalizedUrl;
    this.intentionalClose = false;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;

    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    const generation = ++this.connectionGeneration;
    this.intentionalClose = false;
    this.handshakeComplete = false;

    this.connectPromise = new Promise((resolve, reject) => {
      this.rejectConnect = reject;
      const socket = new WebSocket(this.url);
      this.ws = socket;

      const resolveConnect = () => {
        if (generation !== this.connectionGeneration) return;
        this.connectPromise = null;
        this.rejectConnect = null;
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
        socket.close();
      };

      socket.onopen = () => {
        if (generation !== this.connectionGeneration) return;
        console.log('Connected to Arc Tunnel broker');
        this.intentionalClose = false;
        const hello: HelloMessage = { type: 'hello', role: 'extension', protocolVersion: 2 };
        socket.send(JSON.stringify(hello));
      };

      socket.onerror = () => {
        if (generation !== this.connectionGeneration) return;
        console.error('WebSocket error');
      };

      socket.onclose = () => {
        if (generation !== this.connectionGeneration || this.intentionalClose) return;
        console.log('Disconnected from Arc Tunnel broker');
        this.clearHeartbeatTimer();
        this.ws = null;
        this.handshakeComplete = false;
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
    socket?.close();
  }

  prepareForSuspend(): void {
    const generation = ++this.connectionGeneration;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    const socket = this.ws;
    this.ws = null;
    this.handshakeComplete = false;
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
    if (generation !== this.connectionGeneration || this.intentionalClose || this.reconnectTimer) return;

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
      if (generation !== this.connectionGeneration || this.intentionalClose) return;
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
      socket.send(JSON.stringify(heartbeat));
    }, HEARTBEAT_INTERVAL_MS);
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
}
