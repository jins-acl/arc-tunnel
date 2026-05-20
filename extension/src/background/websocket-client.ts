// extension/src/background/websocket-client.ts
import { CommandMessage, ResponseMessage, EventMessage } from '../types';

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private messageHandlers: Map<string, (message: any) => void> = new Map();
  private intentionalClose = false;

  constructor(url: string = 'ws://localhost:8765') {
    this.url = url;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('Connected to MCP server');
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('Disconnected from MCP server');
        this.handleReconnect();
      };

      this.ws.onmessage = (event) => {
        try {
          const message: CommandMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      };
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  sendResponse(response: ResponseMessage): void {
    if (this.isConnected()) {
      this.ws!.send(JSON.stringify(response));
    }
  }

  sendEvent(event: EventMessage): void {
    if (this.isConnected()) {
      this.ws!.send(JSON.stringify(event));
    }
  }

  onCommand(handler: (message: CommandMessage) => void): void {
    this.messageHandlers.set('command', handler);
  }

  private handleMessage(message: CommandMessage): void {
    const handler = this.messageHandlers.get('command');
    if (handler) {
      handler(message);
    }
  }

  private async handleReconnect(): Promise<void> {
    if (this.intentionalClose) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`Reconnect failed after ${this.maxReconnectAttempts} attempts — giving up. Reload the extension to retry.`);
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(async () => {
      // Re-check flag — disconnect() may have been called during the delay
      if (this.intentionalClose) return;
      try {
        await this.connect();
      } catch (error) {
        console.error('Reconnect failed:', error);
      }
    }, delay);

    // Fallback: schedule chrome.alarms in case SW is terminated during setTimeout
    chrome.alarms.create('ws-reconnect', { delayInMinutes: Math.ceil(delay / 60000) || 1 });
  }
}
