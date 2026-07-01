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
  isAgentRequest,
  ArcTunnelError,
  toErrorInfo
} from '../protocol';
import { ResponseMessage } from '../types';
import { SessionRegistry } from './session-registry';
import { TabScheduler } from './tab-scheduler';

interface PendingRoute {
  sessionId: string;
  agentRequestId: string;
  params: Record<string, unknown>;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
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
  private readonly scheduler = new TabScheduler();
  private readonly agents = new Map<string, WebSocket>();
  private readonly routes = new Map<string, PendingRoute>();
  private readonly ownershipTimers = new Map<string, NodeJS.Timeout>();
  private readonly tabCreationTails = new Map<string, Promise<unknown>>();
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
    await new Promise<void>((resolve) => setImmediate(resolve));
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
    if (isAgentRequest(request)) void this.forward(sessionId, request);
  }

  private async forward(sessionId: string, request: AgentRequest): Promise<void> {
    if (!this.extension || this.extension.readyState !== WebSocket.OPEN) {
      this.replyError(sessionId, request.requestId, ErrorCode.EXTENSION_DISCONNECTED);
      return;
    }
    try {
      const result = await this.executeRequest(sessionId, request);
      this.replySuccess(sessionId, request.requestId, result);
    } catch (error) {
      const info = toErrorInfo(error);
      this.replyError(sessionId, request.requestId, info.code as ErrorCode, info.message);
    }
  }

  private executeRequest(sessionId: string, request: AgentRequest): Promise<unknown> {
    if (request.command === 'claim_tab') return Promise.resolve(this.claimTab(sessionId, request.params));
    if (request.command === 'release_tab') return Promise.resolve(this.releaseTab(sessionId, request.params));
    if (request.command === 'create_tab') return this.queueOwnedTabCreation(sessionId, request);
    if (request.command === 'list_tabs') return this.listVisibleTabs(sessionId, request);

    const tabId = request.params.tabId;
    if (typeof tabId === 'number') {
      this.registry.assertOwnsTab(sessionId, tabId);
      return this.scheduler.run(tabId, () => this.sendExtensionCommand(sessionId, request));
    }
    return this.sendExtensionCommand(sessionId, request);
  }

  private claimTab(sessionId: string, params: Record<string, unknown>): { tabId: number; ownership: 'owned' } {
    const tabId = params.tabId;
    if (typeof tabId !== 'number') throw new ArcTunnelError(ErrorCode.TAB_NOT_OWNED, ErrorCode.TAB_NOT_OWNED);
    const result = this.registry.claimTab(sessionId, tabId);
    if (!result.ok) throw new ArcTunnelError(result.code, result.code);
    return { tabId, ownership: 'owned' };
  }

  private releaseTab(sessionId: string, params: Record<string, unknown>): { tabId: number; ownership: 'unclaimed' } {
    const tabId = params.tabId;
    if (typeof tabId !== 'number') throw new ArcTunnelError(ErrorCode.TAB_NOT_OWNED, ErrorCode.TAB_NOT_OWNED);
    this.registry.assertOwnsTab(sessionId, tabId);
    this.registry.releaseTab(tabId);
    return { tabId, ownership: 'unclaimed' };
  }

  private async createOwnedTab(sessionId: string, request: AgentRequest): Promise<unknown> {
    const windowId = this.registry.windowId(sessionId);
    if (windowId == null) {
      const result = await this.sendExtensionCommand(sessionId, { ...request, command: 'create_window' }) as any;
      const tabs = Array.isArray(result?.tabs) ? result.tabs : [];
      const tabIds = tabs.flatMap((tab: any) => typeof tab.tabId === 'number' ? [tab.tabId] : []);
      if (typeof result?.tabId === 'number') tabIds.push(result.tabId);
      this.registry.assignWindow(sessionId, result.windowId, tabIds);
      return result;
    }
    const result = await this.sendExtensionCommand(sessionId, {
      ...request,
      params: { ...request.params, windowId }
    }) as any;
    if (typeof result?.tabId === 'number') this.registry.claimTab(sessionId, result.tabId);
    return result;
  }

  private queueOwnedTabCreation(sessionId: string, request: AgentRequest): Promise<unknown> {
    const previous = this.tabCreationTails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.createOwnedTab(sessionId, request));
    this.tabCreationTails.set(sessionId, current);
    const clear = () => {
      if (this.tabCreationTails.get(sessionId) === current) this.tabCreationTails.delete(sessionId);
    };
    void current.then(clear, clear);
    return current;
  }

  private async listVisibleTabs(sessionId: string, request: AgentRequest): Promise<unknown> {
    const result = await this.sendExtensionCommand(sessionId, request) as any;
    const tabs = Array.isArray(result?.tabs) ? result.tabs : [];
    return { ...result, tabs: this.registry.visibleTabs(sessionId, tabs) };
  }

  private sendExtensionCommand(sessionId: string, request: AgentRequest): Promise<unknown> {
    if (!this.extension || this.extension.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ArcTunnelError(ErrorCode.EXTENSION_DISCONNECTED, ErrorCode.EXTENSION_DISCONNECTED));
    }
    const extensionCommandId = randomUUID();
    const timeout = Math.max(0, request.timeout);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.routes.delete(extensionCommandId);
        reject(new ArcTunnelError(ErrorCode.COMMAND_TIMEOUT, ErrorCode.COMMAND_TIMEOUT));
      }, timeout);
      this.routes.set(extensionCommandId, {
        sessionId,
        agentRequestId: request.requestId,
        params: request.params,
        timer,
        resolve,
        reject
      });
      this.send(this.extension!, {
        id: extensionCommandId,
        type: 'command',
        command: request.command,
        params: request.params,
        timeout: request.timeout
      });
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
    if (response.success) route.resolve(response.result);
    else route.reject(new ArcTunnelError(response.error?.code as ErrorCode, response.error?.message ?? 'Extension command failed', response.error?.details));
  }

  private handleBrowserEvent(event: { event: string; data?: Record<string, unknown> }): void {
    if (event.event !== 'tab_removed' && event.event !== 'window_removed') return;
    const tabId = event.data?.tabId;
    const windowId = event.data?.windowId;
    const removedTabIds = new Set<number>();
    if (typeof tabId === 'number') {
      this.registry.releaseTab(tabId);
      removedTabIds.add(tabId);
    }
    if (event.event === 'window_removed' && typeof windowId === 'number') {
      for (const id of this.registry.releaseWindow(windowId)) removedTabIds.add(id);
    }
    for (const [id, route] of this.routes) {
      const matchesTab = typeof route.params.tabId === 'number' && removedTabIds.has(route.params.tabId);
      const matchesWindow = typeof windowId === 'number' && route.params.windowId === windowId;
      if (!matchesTab && !matchesWindow) continue;
      clearTimeout(route.timer);
      this.routes.delete(id);
      route.reject(new ArcTunnelError(ErrorCode.TAB_CLOSED, ErrorCode.TAB_CLOSED));
    }
  }

  private handleAgentDisconnect(sessionId: string): void {
    this.agents.delete(sessionId);
    for (const [id, route] of this.routes) {
      if (route.sessionId !== sessionId) continue;
      clearTimeout(route.timer);
      this.routes.delete(id);
      route.reject(new ArcTunnelError(ErrorCode.EXTENSION_DISCONNECTED, ErrorCode.EXTENSION_DISCONNECTED));
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
      route.reject(new ArcTunnelError(code, code));
    }
    this.routes.clear();
  }

  private replySuccess(sessionId: string, requestId: string, result: unknown): void {
    const ws = this.agents.get(sessionId);
    if (ws?.readyState === WebSocket.OPEN) this.send(ws, {
      type: 'agent_response', requestId, success: true, result
    } satisfies AgentResponse);
  }

  private replyError(sessionId: string, requestId: string, code: ErrorCode, message: string = code): void {
    const ws = this.agents.get(sessionId);
    if (ws?.readyState !== WebSocket.OPEN) return;
    this.send(ws, {
      type: 'agent_response',
      requestId,
      success: false,
      error: { code, message }
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
