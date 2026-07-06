import { randomUUID } from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
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
  isBrowserEvent,
  ArcTunnelError,
  toErrorInfo
} from '../protocol';
import { ResponseMessage } from '../types';
import { SessionRegistry } from './session-registry';
import { TabScheduler } from './tab-scheduler';
import { DiagnosticEvent, DiagnosticsStore, RecoveryPhase } from './diagnostics-store';

const DASHBOARD_ASSETS = new Map<string, readonly [string, string]>([
  ['/dashboard', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']]
]);

interface PendingRoute {
  sessionId: string;
  agentRequestId: string;
  params: Record<string, unknown>;
  command: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  recordingCleanup: boolean;
}

interface BrokerDependencies {
  registry?: SessionRegistry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBrowserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function tabIdsFromResult(value: unknown, field: 'tabs' | 'tabIds' = 'tabs'): number[] {
  if (!isRecord(value) || !Array.isArray(value[field])) return [];
  return value[field].flatMap(item => {
    if (field === 'tabIds') return typeof item === 'number' ? [item] : [];
    return isRecord(item) && typeof item.tabId === 'number' ? [item.tabId] : [];
  });
}

function stringResultField(value: unknown, field: 'recordingId' | 'sessionId'): string | null {
  return isRecord(value) && typeof value[field] === 'string' && value[field].length > 0
    ? value[field] as string
    : null;
}

function isExtensionResponse(value: unknown): value is ResponseMessage {
  if (!isRecord(value) || value.type !== 'response' || typeof value.id !== 'string' || typeof value.success !== 'boolean') {
    return false;
  }
  if (value.success) return true;
  return isRecord(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string';
}

function restoredTabIds(value: unknown): number[] | null {
  if (!isRecord(value) || !Array.isArray(value.tabIds)) return null;
  return value.tabIds.every(isBrowserId)
    ? value.tabIds as number[]
    : null;
}

function createdWindowTabIds(value: Record<string, unknown>): number[] | null {
  const ids: number[] = [];
  if (value.tabId !== undefined) {
    if (!isBrowserId(value.tabId)) return null;
    ids.push(value.tabId);
  }
  if (value.tabs !== undefined) {
    if (!Array.isArray(value.tabs)) return null;
    for (const tab of value.tabs) {
      if (!isRecord(tab) || !isBrowserId(tab.tabId)) return null;
      ids.push(tab.tabId);
    }
  }
  return ids;
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
  private readonly windowInitializations = new Map<string, Promise<{ windowId: number; result: unknown }>>();
  private readonly closedTabIds = new Set<number>();
  private readonly tabGenerations = new Map<number, number>();
  private readonly sseClients = new Set<http.ServerResponse>();
  private diagnostics!: DiagnosticsStore;
  private extensionGeneration = 0;
  private extensionReconnectPhase: RecoveryPhase = 'idle';
  private extensionLastSyncAt: number | null = null;
  private httpServer: http.Server | null = null;
  private extension: WebSocket | null = null;
  private listeningPort: number | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  private extensionSync: Promise<void> = Promise.resolve();
  private hasActivatedExtension = false;
  private recordingReservationSessionId: string | null = null;
  private recordingCleanupSessionId: string | null = null;

  constructor(private readonly config: BrokerConfig, dependencies: BrokerDependencies = {}) {
    this.registry = dependencies.registry ?? new SessionRegistry();
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const startedAt = Date.now();

    this.httpServer = http.createServer((request, response) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
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
      if (request.method === 'GET' && request.url === '/api/status') {
        this.writeDiagnosticHeaders(response, 'application/json; charset=utf-8');
        response.writeHead(200);
        response.end(JSON.stringify(this.diagnosticsSnapshot()));
        return;
      }
      if (request.method === 'GET' && new URL(request.url || '/', 'http://localhost').pathname === '/api/events') {
        this.openEventStream(request, response);
        return;
      }
      const dashboardAsset = request.method === 'GET' ? DASHBOARD_ASSETS.get(pathname) : undefined;
      if (dashboardAsset) {
        this.serveDashboardAsset(response, dashboardAsset);
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
        this.diagnostics = new DiagnosticsStore({
          pid: process.pid, port: address.port, protocolVersion: PROTOCOL_VERSION, startedAt
        });
        this.recordDiagnostic('info', 'broker', 'BROKER_STARTED', 'Broker 已启动');
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
    this.recordDiagnostic('info', 'broker', 'BROKER_STOPPING', 'Broker 正在停止');

    this.rejectAllRoutes(ErrorCode.EXTENSION_DISCONNECTED);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const timer of this.ownershipTimers.values()) clearTimeout(timer);
    this.ownershipTimers.clear();

    for (const ws of this.agents.values()) ws.close();
    this.agents.clear();
    this.extension?.close();
    this.extension = null;

    for (const response of this.sseClients) response.destroy();
    this.sseClients.clear();

    await Promise.all([this.closeWebSocketServer(this.agentWss), this.closeWebSocketServer(this.extensionWss)]);
    this.httpServer = null;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    this.listeningPort = null;
  }

  address(): BrokerAddress {
    if (this.listeningPort == null) throw new Error('Broker is not listening');
    return { host: '127.0.0.1', port: this.listeningPort };
  }

  dashboardUrl(): string {
    return `http://${this.address().host}:${this.address().port}/`;
  }

  private writeDiagnosticHeaders(response: http.ServerResponse, contentType: string): void {
    response.setHeader('content-type', contentType);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('content-security-policy', "default-src 'none'");
  }

  private serveDashboardAsset(
    response: http.ServerResponse,
    [filename, contentType]: readonly [string, string]
  ): void {
    const bundledDirectory = path.join(__dirname, 'dashboard');
    const directory = fs.existsSync(bundledDirectory)
      ? bundledDirectory
      : path.join(__dirname, '..', 'dashboard');
    this.writeDashboardHeaders(response, contentType);
    fs.readFile(path.join(directory, filename), (error, contents) => {
      if (error) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(contents);
    });
  }

  private writeDashboardHeaders(response: http.ServerResponse, contentType: string): void {
    response.setHeader('content-type', contentType);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
  }

  private diagnosticsSnapshot() {
    const counts = this.registry.diagnosticsCounts();
    return this.diagnostics.snapshot({
      now: Date.now(), connectedAgents: counts.connected, graceAgents: counts.grace,
      claimedTabs: counts.claimedTabs, pendingCommands: this.routes.size
    });
  }

  private openEventStream(request: http.IncomingMessage, response: http.ServerResponse): void {
    this.writeDiagnosticHeaders(response, 'text/event-stream; charset=utf-8');
    response.setHeader('connection', 'keep-alive');
    response.writeHead(200);
    response.flushHeaders();
    this.sseClients.add(response);
    let closed = false;
    let unsubscribe = (): void => undefined;
    const frames: string[] = [];
    let draining = false;
    let drainTimer: NodeJS.Timeout | null = null;
    const close = () => {
      if (closed) return;
      closed = true;
      if (drainTimer) clearTimeout(drainTimer);
      unsubscribe();
      this.sseClients.delete(response);
    };
    const failSlowClient = () => {
      close();
      response.destroy();
    };
    const pump = () => {
      if (closed || draining) return;
      while (frames.length > 0) {
        if (response.write(frames.shift()!)) continue;
        draining = true;
        const resume = () => {
          if (!draining) return;
          draining = false;
          if (drainTimer) clearTimeout(drainTimer);
          drainTimer = null;
          pump();
        };
        response.once('drain', resume);
        drainTimer = setTimeout(() => {
          response.off('drain', resume);
          failSlowClient();
        }, 100);
        return;
      }
    };
    const writeFrame = (frame: string): boolean => {
      if (closed) return false;
      if (frames.length >= 256) {
        failSlowClient();
        return false;
      }
      frames.push(frame);
      pump();
      return !closed;
    };
    let replaying = true;
    let lastSent = -1;
    const pending: DiagnosticEvent[] = [];
    const write = (event: DiagnosticEvent) => {
      if (event.sequence <= lastSent || closed) return;
      if (replaying) {
        pending.push(event);
        return;
      }
      if (writeFrame(`id: ${event.sequence}\nevent: diagnostic\ndata: ${JSON.stringify(event)}\n\n`)) {
        lastSent = event.sequence;
      }
    };
    unsubscribe = this.diagnostics.subscribe(write);
    request.once('close', close);
    response.once('close', close);
    const url = new URL(request.url || '/', 'http://localhost');
    const rawSequence = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
    const cursor = Array.isArray(rawSequence) ? rawSequence[0] : rawSequence;
    const parsed = /^\d+$/.test(cursor) ? Number(cursor) : 0;
    const sequence = Number.isSafeInteger(parsed) ? parsed : 0;
    lastSent = sequence;
    const replay = this.diagnostics.eventsAfter(sequence);
    if (replay.reset) {
      if (!writeFrame(`event: RESET\ndata: ${JSON.stringify(this.diagnosticsSnapshot())}\n\n`)) return;
    }
    for (const event of replay.events) write(event);
    replaying = false;
    for (const event of pending.sort((left, right) => left.sequence - right.sequence)) write(event);
  }

  private recordDiagnostic(
    level: 'info' | 'warning' | 'error', category: 'broker' | 'connection' | 'ownership' | 'recovery',
    code: string, summary: string
  ): void {
    this.diagnostics.record({ level, category, code, summary });
  }

  private publishExtensionState(): void {
    this.diagnostics.setExtensionState({
      connected: this.isExtensionConnected(), generation: this.extensionGeneration,
      reconnectPhase: this.extensionReconnectPhase, lastSyncAt: this.extensionLastSyncAt
    });
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
      this.recordDiagnostic('info', 'connection', 'AGENT_CONNECTED', 'Agent 已连接');
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
      this.recordDiagnostic('warning', 'connection', 'EXTENSION_REPLACED', '扩展连接已被替换');
      this.rejectAllRoutes(ErrorCode.EXTENSION_DISCONNECTED);
      this.extension.close(1012, 'replaced');
    }
    this.extension = ws;
    this.extensionGeneration++;
    const generation = this.extensionGeneration;
    this.recordDiagnostic('info', 'connection', 'EXTENSION_CONNECTED', '扩展已连接');
    this.publishExtensionState();
    if (sendWelcome) this.send(ws, { type: 'welcome', protocolVersion: PROTOCOL_VERSION } satisfies WelcomeMessage);
    ws.on('message', (data) => this.handleExtensionMessage(ws, data));
    if (this.hasActivatedExtension) {
      this.extensionReconnectPhase = 'running';
      this.publishExtensionState();
      this.extensionSync = new Promise(resolve => setImmediate(resolve))
        .then(() => this.cleanupDisconnectedRecording(ws, generation))
        .then(() => this.syncExtensionInventory(ws, generation))
        .then(() => {
          if (!this.isCurrentExtension(ws, generation)) return;
          this.extensionReconnectPhase = 'idle';
          this.extensionLastSyncAt = Date.now();
          this.publishExtensionState();
        })
        .catch(() => {
          if (!this.isCurrentExtension(ws, generation)) return;
          this.extensionReconnectPhase = 'failed';
          this.extension = null;
          this.publishExtensionState();
          this.recordDiagnostic('warning', 'connection', 'EXTENSION_DISCONNECTED', '扩展已断开');
          this.rejectAllRoutes(ErrorCode.EXTENSION_DISCONNECTED);
          ws.close(1012, 'inventory synchronization failed');
        });
    } else {
      this.hasActivatedExtension = true;
      this.extensionSync = Promise.resolve();
    }
    ws.once('close', () => {
      if (this.extension !== ws) return;
      this.extension = null;
      this.publishExtensionState();
      this.recordDiagnostic('warning', 'connection', 'EXTENSION_DISCONNECTED', '扩展已断开');
      this.rejectAllRoutes(ErrorCode.EXTENSION_DISCONNECTED);
    });
  }

  private isCurrentExtension(ws: WebSocket, generation: number): boolean {
    return this.extension === ws && this.extensionGeneration === generation;
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
      await this.extensionSync;
      this.registry.assertConnected(sessionId);
      const result = await this.executeRequest(sessionId, request);
      this.replySuccess(sessionId, request.requestId, result);
    } catch (error) {
      const info = toErrorInfo(error);
      this.replyError(sessionId, request.requestId, info.code as ErrorCode, info.message);
    }
  }

  private executeRequest(sessionId: string, request: AgentRequest): Promise<unknown> {
    if (request.command === 'claim_tab') return this.claimTab(sessionId, request);
    if (request.command === 'release_tab') return Promise.resolve(this.releaseTab(sessionId, request.params));
    if (request.command === 'create_tab') return this.queueOwnedTabCreation(sessionId, request);
    if (request.command === 'list_tabs') return this.listVisibleTabs(sessionId, request);
    if (request.command === 'start_recording') return this.startRecording(sessionId, request);
    if (request.command === 'stop_recording') this.registry.assertOwnsRecording(sessionId);
    if (request.command === 'replay_recording') {
      this.registry.assertOwnsRecording(sessionId, request.params.recordingId);
      if (typeof request.params.tabId !== 'number') {
        throw new ArcTunnelError(ErrorCode.TAB_NOT_OWNED, ErrorCode.TAB_NOT_OWNED);
      }
    }
    if (request.command === 'save_session') {
      return this.sendExtensionCommand(sessionId, {
        ...request,
        params: { ...request.params, tabIds: this.registry.ownedTabIds(sessionId) }
      });
    }
    if (request.command === 'restore_session') return this.restoreOwnedSession(sessionId, request);

    const tabId = request.params.tabId;
    if (typeof tabId === 'number') {
      this.registry.assertOwnsTab(sessionId, tabId);
      const generation = this.tabGeneration(tabId);
      return this.scheduler.run(tabId, () => {
        this.registry.assertConnected(sessionId);
        if (this.tabGeneration(tabId) !== generation) {
          throw new ArcTunnelError(ErrorCode.TAB_CLOSED, ErrorCode.TAB_CLOSED);
        }
        if (this.closedTabIds.has(tabId)) {
          throw new ArcTunnelError(ErrorCode.TAB_CLOSED, ErrorCode.TAB_CLOSED);
        }
        this.registry.assertOwnsTab(sessionId, tabId);
        return this.sendExtensionCommand(sessionId, request);
      });
    }
    return this.sendExtensionCommand(sessionId, request);
  }

  private async startRecording(sessionId: string, request: AgentRequest): Promise<unknown> {
    if (this.recordingReservationSessionId !== null || this.registry.hasActiveRecording()) {
      throw new ArcTunnelError(ErrorCode.RECORDING_BUSY, ErrorCode.RECORDING_BUSY);
    }
    this.recordingReservationSessionId = sessionId;
    try {
      return await this.sendOwnedTabCommand(sessionId, request);
    } catch (error) {
      if (this.recordingReservationSessionId === sessionId) this.recordingReservationSessionId = null;
      if (this.recordingCleanupSessionId === sessionId) {
        const ws = this.extension;
        if (ws) void this.cleanupDisconnectedRecording(ws, this.extensionGeneration);
      }
      throw error;
    }
  }

  private sendOwnedTabCommand(sessionId: string, request: AgentRequest): Promise<unknown> {
    const tabId = request.params.tabId;
    if (typeof tabId !== 'number') return this.sendExtensionCommand(sessionId, request);
    this.registry.assertOwnsTab(sessionId, tabId);
    const generation = this.tabGeneration(tabId);
    return this.scheduler.run(tabId, () => {
      this.registry.assertConnected(sessionId);
      if (this.tabGeneration(tabId) !== generation || this.closedTabIds.has(tabId)) {
        throw new ArcTunnelError(ErrorCode.TAB_CLOSED, ErrorCode.TAB_CLOSED);
      }
      this.registry.assertOwnsTab(sessionId, tabId);
      return this.sendExtensionCommand(sessionId, request);
    });
  }

  private async restoreOwnedSession(sessionId: string, request: AgentRequest): Promise<unknown> {
    this.registry.assertOwnsSavedSession(sessionId, request.params.sessionId);
    const { windowId } = await this.ensureOwnedWindow(sessionId, request, {});
    const result = await this.sendExtensionCommand(sessionId, {
      ...request, params: { ...request.params, windowId }
    });
    const tabIds = restoredTabIds(result);
    if (tabIds === null) throw new ArcTunnelError(ErrorCode.SESSION_RESTORE_FAILED, ErrorCode.SESSION_RESTORE_FAILED);
    this.registry.claimTabsAtomically(sessionId, tabIds);
    return result;
  }

  private async claimTab(sessionId: string, request: AgentRequest): Promise<{ tabId: number; ownership: 'owned' }> {
    const tabId = request.params.tabId;
    if (typeof tabId !== 'number') throw new ArcTunnelError(ErrorCode.TAB_NOT_OWNED, ErrorCode.TAB_NOT_OWNED);
    const inventory = await this.sendExtensionCommand(sessionId, {
      ...request,
      command: 'list_tabs',
      params: {}
    }) as any;
    const exists = Array.isArray(inventory?.tabs)
      && inventory.tabs.some((tab: any) => tab?.tabId === tabId);
    if (!exists) throw new ArcTunnelError(ErrorCode.TAB_NOT_FOUND, ErrorCode.TAB_NOT_FOUND);
    const result = this.registry.claimTab(sessionId, tabId);
    if (!result.ok) throw new ArcTunnelError(result.code, result.code);
    this.closedTabIds.delete(tabId);
    this.recordDiagnostic('info', 'ownership', 'TAB_CLAIMED', '标签页所有权已认领');
    return { tabId, ownership: 'owned' };
  }

  private releaseTab(sessionId: string, params: Record<string, unknown>): { tabId: number; ownership: 'unclaimed' } {
    const tabId = params.tabId;
    if (typeof tabId !== 'number') throw new ArcTunnelError(ErrorCode.TAB_NOT_OWNED, ErrorCode.TAB_NOT_OWNED);
    this.registry.assertOwnsTab(sessionId, tabId);
    this.registry.releaseTab(tabId);
    this.recordDiagnostic('info', 'ownership', 'TAB_RELEASED', '标签页所有权已释放');
    return { tabId, ownership: 'unclaimed' };
  }

  private async createOwnedTab(sessionId: string, request: AgentRequest): Promise<unknown> {
    this.registry.assertConnected(sessionId);
    let windowId = this.registry.windowId(sessionId);
    if (windowId == null) {
      const joinedExistingInitialization = this.windowInitializations.has(sessionId);
      const initialized = await this.ensureOwnedWindow(sessionId, request, request.params);
      if (!joinedExistingInitialization) return initialized.result;
      windowId = initialized.windowId;
    }
    const result = await this.sendExtensionCommand(sessionId, {
      ...request,
      params: { ...request.params, windowId }
    });
    if (!isRecord(result) || !isBrowserId(result.tabId)) {
      throw new ArcTunnelError(ErrorCode.TAB_NOT_FOUND, ErrorCode.TAB_NOT_FOUND);
    }
    this.registry.claimTab(sessionId, result.tabId);
    this.closedTabIds.delete(result.tabId);
    return result;
  }

  private ensureOwnedWindow(
    sessionId: string,
    request: AgentRequest,
    params: Record<string, unknown>
  ): Promise<{ windowId: number; result: unknown }> {
    const existing = this.registry.windowId(sessionId);
    if (existing != null) return Promise.resolve({ windowId: existing, result: { windowId: existing } });
    const pending = this.windowInitializations.get(sessionId);
    if (pending) return pending;
    const initialization = this.sendExtensionCommand(sessionId, { ...request, command: 'create_window', params })
      .then(result => {
        if (!isRecord(result) || !isBrowserId(result.windowId)) {
          throw new ArcTunnelError(ErrorCode.SESSION_RESTORE_FAILED, ErrorCode.SESSION_RESTORE_FAILED);
        }
        const tabIds = createdWindowTabIds(result);
        if (tabIds === null) throw new ArcTunnelError(ErrorCode.SESSION_RESTORE_FAILED, ErrorCode.SESSION_RESTORE_FAILED);
        this.registry.assignWindow(sessionId, result.windowId, tabIds);
        for (const tabId of tabIds) this.closedTabIds.delete(tabId);
        return { windowId: result.windowId, result };
      });
    this.windowInitializations.set(sessionId, initialization);
    const clear = () => {
      if (this.windowInitializations.get(sessionId) === initialization) this.windowInitializations.delete(sessionId);
    };
    void initialization.then(clear, clear);
    return initialization;
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

  private sendExtensionCommand(
    sessionId: string,
    request: AgentRequest,
    recordingCleanup = false
  ): Promise<unknown> {
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
        command: request.command,
        timer,
        resolve,
        reject,
        recordingCleanup
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

  private handleExtensionMessage(ws: WebSocket, data: RawData): void {
    if (this.extension !== ws) return;
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (isExtensionResponse(message)) {
      this.handleExtensionResponse(message);
    } else if (isBrowserEvent(message)) {
      this.handleBrowserEvent(message);
    }
  }

  private handleExtensionResponse(response: ResponseMessage): void {
    const route = this.routes.get(response.id);
    if (!route) return;
    clearTimeout(route.timer);
    this.routes.delete(response.id);
    if (response.success) {
      const result = response.result;
      const recordingId = stringResultField(result, 'recordingId');
      const savedSessionId = stringResultField(result, 'sessionId');
      if (route.command === 'start_recording' && recordingId === null) {
        route.reject(new ArcTunnelError(ErrorCode.RECORDING_NOT_FOUND, ErrorCode.RECORDING_NOT_FOUND));
        return;
      }
      if (route.command === 'save_session' && savedSessionId === null) {
        route.reject(new ArcTunnelError(ErrorCode.SESSION_NOT_FOUND, ErrorCode.SESSION_NOT_FOUND));
        return;
      }
      if (route.command === 'start_recording' && recordingId) {
        this.registry.addRecording(route.sessionId, recordingId);
        if (this.recordingCleanupSessionId === route.sessionId) {
          const ws = this.extension;
          if (ws) void this.cleanupDisconnectedRecording(ws, this.extensionGeneration);
        }
      }
      if (route.command === 'stop_recording') this.registry.clearRecordings(route.sessionId);
      if (route.command === 'stop_recording' && this.recordingReservationSessionId === route.sessionId) {
        this.recordingReservationSessionId = null;
      }
      if (route.command === 'save_session' && savedSessionId) {
        this.registry.addSavedSession(route.sessionId, savedSessionId);
      }
      route.resolve(result);
    }
    else if (route.recordingCleanup && response.error?.message === 'No active recording') {
      route.resolve(undefined);
    } else {
      if (route.command === 'start_recording' && this.recordingCleanupSessionId === route.sessionId) {
        this.recordingCleanupSessionId = null;
        this.pruneExpiredSessions();
      }
      route.reject(new ArcTunnelError(response.error?.code as ErrorCode, response.error?.message ?? 'Extension command failed', response.error?.details));
    }
  }

  private async syncExtensionInventory(ws: WebSocket, generation: number): Promise<void> {
    if (!this.isCurrentExtension(ws, generation) || ws.readyState !== WebSocket.OPEN) return;
    this.diagnostics.setInventorySync('running');
    this.recordDiagnostic('info', 'recovery', 'INVENTORY_SYNC_STARTED', '标签页清单同步已开始');
    try {
      const result = await this.sendExtensionCommand('', {
        type: 'agent_request', requestId: 'extension-sync', command: 'list_tabs', params: {}, timeout: 1_000
      });
      if (!this.isCurrentExtension(ws, generation)) return;
      this.registry.reconcileTabs(new Set(tabIdsFromResult(result)));
      this.diagnostics.setInventorySync('idle');
      this.recordDiagnostic('info', 'recovery', 'INVENTORY_SYNC_COMPLETED', '标签页清单同步已完成');
    } catch (error) {
      if (this.isCurrentExtension(ws, generation)) {
        this.diagnostics.setInventorySync('failed');
        this.recordDiagnostic('error', 'recovery', 'INVENTORY_SYNC_FAILED', '标签页清单同步失败');
      }
      throw error;
    }
  }

  private handleBrowserEvent(event: { event: string; data?: Record<string, unknown> }): void {
    if (event.event === 'tab_created') {
      if (typeof event.data?.tabId === 'number') this.closedTabIds.delete(event.data.tabId);
      return;
    }
    if (event.event !== 'tab_removed' && event.event !== 'window_removed') return;
    const tabId = event.data?.tabId;
    const windowId = event.data?.windowId;
    const removedTabIds = new Set<number>();
    if (typeof tabId === 'number') {
      this.registry.releaseTab(tabId);
      this.closedTabIds.add(tabId);
      this.advanceTabGeneration(tabId);
      removedTabIds.add(tabId);
    }
    if (event.event === 'window_removed' && typeof windowId === 'number') {
      for (const id of this.registry.releaseWindow(windowId)) {
        this.closedTabIds.add(id);
        this.advanceTabGeneration(id);
        removedTabIds.add(id);
      }
    }
    for (const [id, route] of this.routes) {
      const matchesTab = typeof route.params.tabId === 'number' && removedTabIds.has(route.params.tabId);
      const matchesWindow = typeof windowId === 'number' && route.params.windowId === windowId;
      if (!matchesTab && !matchesWindow) continue;
      clearTimeout(route.timer);
      this.routes.delete(id);
      route.reject(new ArcTunnelError(ErrorCode.TAB_CLOSED, ErrorCode.TAB_CLOSED));
    }
    for (const id of removedTabIds) this.retireClosedTabMetadata(id, this.tabGeneration(id));
  }

  private tabGeneration(tabId: number): number {
    return this.tabGenerations.get(tabId) ?? 0;
  }

  private advanceTabGeneration(tabId: number): void {
    this.tabGenerations.set(tabId, this.tabGeneration(tabId) + 1);
  }

  private handleAgentDisconnect(sessionId: string): void {
    this.agents.delete(sessionId);
    const hasActiveRecording = this.registry.activeRecordingId(sessionId) !== null;
    const hasStartingRecording = this.recordingReservationSessionId === sessionId;
    for (const [id, route] of this.routes) {
      if (route.sessionId !== sessionId) continue;
      if (hasStartingRecording && route.command === 'start_recording') continue;
      clearTimeout(route.timer);
      this.routes.delete(id);
      route.reject(new ArcTunnelError(ErrorCode.EXTENSION_DISCONNECTED, ErrorCode.EXTENSION_DISCONNECTED));
    }
    if (hasActiveRecording || hasStartingRecording) {
      this.recordingCleanupSessionId = sessionId;
      const ws = this.extension;
      if (hasActiveRecording && ws) void this.cleanupDisconnectedRecording(ws, this.extensionGeneration);
    } else if (this.recordingReservationSessionId === sessionId) {
      this.recordingReservationSessionId = null;
    }
    if (this.stopping) return;
    this.registry.disconnect(sessionId, Date.now());
    this.recordDiagnostic('warning', 'connection', 'AGENT_GRACE_STARTED', 'Agent 已进入宽限期');
    const timer = setTimeout(() => {
      this.ownershipTimers.delete(sessionId);
      const now = Date.now();
      const released = this.registry.expireDisconnected(now);
      this.pruneExpiredSessions(now);
      if (released.length > 0) {
        this.recordDiagnostic('info', 'ownership', 'TAB_OWNERSHIP_EXPIRED', '宽限期结束，标签页所有权已释放');
      }
      this.recordDiagnostic('info', 'connection', 'AGENT_GRACE_EXPIRED', 'Agent 宽限期已结束');
    }, 30_000);
    this.ownershipTimers.set(sessionId, timer);
  }

  private async cleanupDisconnectedRecording(ws: WebSocket, generation: number): Promise<void> {
    const sessionId = this.recordingCleanupSessionId;
    if (!sessionId || !this.isCurrentExtension(ws, generation) || ws.readyState !== WebSocket.OPEN) return;
    this.diagnostics.setRecordingCleanup('running');
    this.recordDiagnostic('info', 'recovery', 'RECORDING_CLEANUP_STARTED', '录制清理已开始');
    try {
      await this.sendExtensionCommand(sessionId, {
        type: 'agent_request', requestId: 'disconnect-recording-cleanup',
        command: 'stop_recording', params: {}, timeout: 1_000
      }, true);
      if (!this.isCurrentExtension(ws, generation)) return;
      if (this.recordingCleanupSessionId === sessionId) this.recordingCleanupSessionId = null;
      this.diagnostics.setRecordingCleanup('idle');
      this.recordDiagnostic('info', 'recovery', 'RECORDING_CLEANUP_COMPLETED', '录制清理已完成');
    } catch {
      if (!this.isCurrentExtension(ws, generation)) return;
      this.diagnostics.setRecordingCleanup('failed');
      this.recordDiagnostic('error', 'recovery', 'RECORDING_CLEANUP_FAILED', '录制清理失败');
      if (this.extension === ws) ws.close(1012, 'recording cleanup failed');
    } finally {
      if (!this.isCurrentExtension(ws, generation)) return;
      this.registry.clearRecordings(sessionId);
      if (this.recordingReservationSessionId === sessionId) this.recordingReservationSessionId = null;
      this.pruneExpiredSessions();
    }
  }

  private retireClosedTabMetadata(tabId: number, generation: number): void {
    void this.scheduler.whenIdle(tabId).then(() => {
      if (!this.closedTabIds.has(tabId) || this.tabGeneration(tabId) !== generation) return;
      this.closedTabIds.delete(tabId);
      this.tabGenerations.delete(tabId);
    });
  }

  private pruneExpiredSessions(now = Date.now()): void {
    const retained = new Set<string>();
    if (this.recordingCleanupSessionId) retained.add(this.recordingCleanupSessionId);
    if (this.recordingReservationSessionId) retained.add(this.recordingReservationSessionId);
    this.registry.pruneDisconnected(now, retained);
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
