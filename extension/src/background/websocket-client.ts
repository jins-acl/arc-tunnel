import { CommandMessage, ResponseMessage, EventMessage, HelloMessage } from '../types';

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
  private messageHandlers: Map<string, (message: any) => void> = new Map();
  private intentionalClose = false;
  private connectionGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private handshakeComplete = false;

  constructor(url?: string) {
    this.url = normalizeWebSocketUrl(url || 'ws://localhost:8765');
  }

  setUrl(url: string): void {
    ++this.connectionGeneration;
    this.clearReconnectTimer();
    chrome.alarms.clear('ws-reconnect');
    this.intentionalClose = true;
    const oldSocket = this.ws;
    this.ws = null;
    this.handshakeComplete = false;
    this.rejectPendingConnect(new Error('Connection superseded by URL change'));
    oldSocket?.close();
    this.url = normalizeWebSocketUrl(url);
    this.intentionalClose = false;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;

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
            if (message.type === 'welcome' && message.protocolVersion === 2) {
              this.handshakeComplete = true;
              this.reconnectAttempts = 0;
              this.clearReconnectTimer();
              chrome.alarms.clear('ws-reconnect');
              resolveConnect();
            }
            return;
          }
          this.handleMessage(message as CommandMessage);
        } catch (error) {
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
    chrome.alarms.clear('ws-reconnect');
    const socket = this.ws;
    this.ws = null;
    this.handshakeComplete = false;
    this.rejectPendingConnect(new Error('Connection closed intentionally'));
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

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`Reconnect failed after ${this.maxReconnectAttempts} attempts - giving up. Reload the extension to retry.`);
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
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

  private rejectPendingConnect(error: Error): void {
    const reject = this.rejectConnect;
    this.rejectConnect = null;
    this.connectPromise = null;
    reject?.(error);
  }
}
