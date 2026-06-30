import { randomUUID } from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket, { RawData, WebSocketServer } from 'ws';
import { BrokerConfig } from '../config';
import {
  AgentRequest,
  AgentResponse,
  ErrorCode,
  HelloMessage,
  PROTOCOL_VERSION,
  WelcomeMessage,
  isAgentRequest
} from '../protocol';
import { ResponseMessage } from '../types';
import { SessionRegistry } from './session-registry';

interface PendingRoute {
  sessionId: string;
  agentRequestId: string;
  params: Record<string, unknown>;
  timer: NodeJS.Timeout;
}

interface BrokerDependencies {
  registry?: SessionRegistry;
}

export interface BrokerAddress {
  host: '127.0.0.1';
  port: number;
}

export class BrokerServer {
  private readonly agentWss = new WebSocketServer({ noServer: true });
  private readonly extensionWss = new WebSocketServer({ noServer: true });
  private readonly registry: SessionRegistry;
  private readonly agents = new Map<string, WebSocket>();
  private readonly routes = new Map<string, PendingRoute>();
  private readonly ownershipTimers = new Map<string, NodeJS.Timeout>();
  private httpServer: http.Server | null = null;
  private extension: WebSocket | null = null;
  private listeningPort: number | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly config: BrokerConfig, dependencies: BrokerDependencies = {}) {
    this.registry = dependencies.registry ?? new SessionRegistry();
  }

  async start(): Promise<void> {
    if (this.httpServer) return;

    this.httpServer = http.createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          name: 'arc-tunnel',
          protocolVersion: PROTOCOL_VERSION,
          pid: process.pid,
          port: this.address().port
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    this.httpServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      const origin = request.headers.origin;
      if (origin?.startsWith('http://') || origin?.startsWith('https://')) {
        this.rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      if (pathname === '/' && !origin?.startsWith('chrome-extension://')) {
        this.rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      const target = pathname === '/agent'
        ? this.agentWss
        : pathname === '/extension' || pathname === '/' ? this.extensionWss : null;
      if (!target) {
        this.rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      target.handleUpgrade(request, socket, head, (ws) => {
        target.emit('connection', ws, request, { legacy: pathname === '/' });
      });
    });

    this.agentWss.on('connection', this.handleAgentConnection);
    this.extensionWss.on('connection', this.handleExtensionConnection);

    await new Promise<void>((resolve, reject) => {
      const server = this.httpServer!;
      const onError = (error: Error) => {
        server.off('listening', onListening);
        this.httpServer = null;
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address() as AddressInfo;
        this.listeningPort = address.port;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.config.port, '127.0.0.1');
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.httpServer) return;
    this.stopPromise = this.performStop();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async performStop(): Promise<void> {
    const server = this.httpServer!;
    this.stopping = true;

    this.rejectAllRoutes(ErrorCode.EXTENSION_DISCONNECTED);
    for (const timer of this.ownershipTimers.values()) clearTimeout(timer);
    this.ownershipTimers.clear();

    for (const ws of this.agents.values()) ws.close();
    this.agents.clear();
    this.extension?.close();
    this.extension = null;

    await Promise.all([this.closeWebSocketServer(this.agentWss), this.closeWebSocketServer(this.extensionWss)]);
    this.httpServer = null;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    this.listeningPort = null;
  }

  address(): BrokerAddress {
    if (this.listeningPort == null) throw new Error('Broker is not listening');
    return { host: '127.0.0.1', port: this.listeningPort };
  }

  isExtensionConnected(): boolean {
    return this.extension?.readyState === WebSocket.OPEN;
  }

  private readonly handleAgentConnection = (ws: WebSocket): void => {
    this.awaitHello(ws, 'agent', (hello) => {
      if (hello.role !== 'agent') return false;
      const sessionId = randomUUID();
      this.registry.createSession(sessionId);
      this.agents.set(sessionId, ws);
      this.send(ws, { type: 'welcome', protocolVersion: PROTOCOL_VERSION, sessionId } satisfies WelcomeMessage);

      ws.on('message', (data) => this.handleAgentMessage(sessionId, data));
      ws.once('close', () => this.handleAgentDisconnect(sessionId));
      return true;
    });
  };

  private readonly handleExtensionConnection = (ws: WebSocket, _request: http.IncomingMessage, context?: { legacy?: boolean }): void => {
    if (context?.legacy) {
      this.activateExtension(ws, false);
      return;
    }
    this.awaitHello(ws, 'extension', (hello) => {
      if (hello.role !== 'extension') return false;
      this.activateExtension(ws, true);
      return true;
    });
  };

  private awaitHello(
    ws: WebSocket,
    expectedRole: 'agent' | 'extension',
    accept: (hello: HelloMessage) => boolean
  ): void {
    const timer = setTimeout(() => ws.close(1008, 'hello required'), 5_000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        ws.close(1008, 'invalid hello');
        return;
      }
      const hello = value as Partial<HelloMessage>;
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        this.sendProtocolError(ws, ErrorCode.PROTOCOL_MISMATCH);
        ws.close(1002, ErrorCode.PROTOCOL_MISMATCH);
        return;
      }
      if (hello.type !== 'hello' || hello.role !== expectedRole || !accept(hello as HelloMessage)) {
        ws.close(1008, 'invalid hello');
      }
    });
    ws.once('close', () => clearTimeout(timer));
  }

  private activateExtension(ws: WebSocket, sendWelcome: boolean): void {
    if (this.extension && this.extension !== ws) {
      this.rejectAllRoutes(ErrorCode.EXTENSION_DISCONNECTED);
      this.extension.close(1012, 'replaced');
    }
    this.extension = ws;
    if (sendWelcome) this.send(ws, { type: 'welcome', protocolVersion: PROTOCOL_VERSION } satisfies WelcomeMessage);
    ws.on('message', (data) => this.handleExtensionMessage(data));
    ws.once('close', () => {
      if (this.extension !== ws) return;
      this.extension = null;
      this.rejectAllRoutes(ErrorCode.EXTENSION_DISCONNECTED);
    });
  }

  private handleAgentMessage(sessionId: string, data: RawData): void {
    let request: unknown;
    try {
      request = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (isAgentRequest(request)) this.forward(sessionId, request);
  }

  private forward(sessionId: string, request: AgentRequest): void {
    if (!this.extension || this.extension.readyState !== WebSocket.OPEN) {
      this.replyError(sessionId, request.requestId, ErrorCode.EXTENSION_DISCONNECTED);
      return;
    }
    const extensionCommandId = randomUUID();
    const timeout = Math.max(0, request.timeout);
    const timer = setTimeout(() => {
      this.routes.delete(extensionCommandId);
      this.replyError(sessionId, request.requestId, ErrorCode.COMMAND_TIMEOUT);
    }, timeout);
    this.routes.set(extensionCommandId, {
      sessionId,
      agentRequestId: request.requestId,
      params: request.params,
      timer
    });
    this.send(this.extension, {
      id: extensionCommandId,
      type: 'command',
      command: request.command,
      params: request.params,
      timeout: request.timeout
    });
  }

  private handleExtensionMessage(data: RawData): void {
    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.type === 'response') {
      this.handleExtensionResponse(message as ResponseMessage);
    } else if (message.type === 'event') {
      this.handleBrowserEvent(message);
    }
  }

  private handleExtensionResponse(response: ResponseMessage): void {
    const route = this.routes.get(response.id);
    if (!route) return;
    clearTimeout(route.timer);
    this.routes.delete(response.id);
    const message: AgentResponse = {
      type: 'agent_response',
      requestId: route.agentRequestId,
      success: response.success,
      ...(response.success ? { result: response.result } : { error: response.error })
    };
    const agent = this.agents.get(route.sessionId);
    if (agent?.readyState === WebSocket.OPEN) this.send(agent, message);
  }

  private handleBrowserEvent(event: { event: string; data?: Record<string, unknown> }): void {
    if (event.event !== 'tab_removed' && event.event !== 'window_removed') return;
    const tabId = event.data?.tabId;
    const windowId = event.data?.windowId;
    if (typeof tabId === 'number') this.registry.releaseTab(tabId);
    const tabIds = event.data?.tabIds;
    if (Array.isArray(tabIds)) {
      for (const id of tabIds) if (typeof id === 'number') this.registry.releaseTab(id);
    }
    for (const [id, route] of this.routes) {
      const matchesTab = typeof tabId === 'number' && route.params.tabId === tabId;
      const matchesWindow = typeof windowId === 'number' && route.params.windowId === windowId;
      if (!matchesTab && !matchesWindow) continue;
      clearTimeout(route.timer);
      this.routes.delete(id);
      this.replyError(route.sessionId, route.agentRequestId, ErrorCode.TAB_CLOSED);
    }
  }

  private handleAgentDisconnect(sessionId: string): void {
    this.agents.delete(sessionId);
    for (const [id, route] of this.routes) {
      if (route.sessionId !== sessionId) continue;
      clearTimeout(route.timer);
      this.routes.delete(id);
    }
    if (this.stopping) return;
    this.registry.disconnect(sessionId, Date.now());
    const timer = setTimeout(() => {
      this.ownershipTimers.delete(sessionId);
      this.registry.expireDisconnected(Date.now());
    }, 30_000);
    this.ownershipTimers.set(sessionId, timer);
  }

  private rejectAllRoutes(code: ErrorCode): void {
    for (const route of this.routes.values()) {
      clearTimeout(route.timer);
      this.replyError(route.sessionId, route.agentRequestId, code);
    }
    this.routes.clear();
  }

  private replyError(sessionId: string, requestId: string, code: ErrorCode): void {
    const ws = this.agents.get(sessionId);
    if (ws?.readyState !== WebSocket.OPEN) return;
    this.send(ws, {
      type: 'agent_response',
      requestId,
      success: false,
      error: { code, message: code }
    } satisfies AgentResponse);
  }

  private sendProtocolError(ws: WebSocket, code: ErrorCode): void {
    this.send(ws, { type: 'error', error: { code, message: code } });
  }

  private send(ws: WebSocket, message: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private rejectUpgrade(socket: NodeJS.WritableStream & { destroy(): void }, status: number, message: string): void {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  private closeWebSocketServer(server: WebSocketServer): Promise<void> {
    for (const client of server.clients) client.close();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}
