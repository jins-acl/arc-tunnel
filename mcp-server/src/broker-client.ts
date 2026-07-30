import { randomUUID } from 'crypto';
import WebSocket, { RawData } from 'ws';
import { BrokerConfig } from './config';
import {
  AgentRequest, AgentResponse, ArcTunnelError, ErrorCode, HelloMessage,
  PROTOCOL_VERSION, isAgentResponse, isWelcomeMessage
} from './protocol';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class BrokerClient {
  private readonly pending = new Map<string, PendingCall>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => this.handleMessage(data));
    ws.once('close', () => this.rejectPending(ErrorCode.CONNECTION_LOST));
    ws.once('error', () => this.rejectPending(ErrorCode.CONNECTION_LOST));
  }

  static async connect(config: BrokerConfig): Promise<BrokerClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/agent`);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (removeErrorListener = true) => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('message', onMessage);
        ws.off('close', onClose);
        if (removeErrorListener) ws.off('error', onError);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup(false);
        ws.once('close', () => ws.off('error', onError));
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close();
        reject(error);
      };
      const onOpen = () => ws.send(JSON.stringify({
        type: 'hello', role: 'agent', protocolVersion: PROTOCOL_VERSION,
        token: config.token, clientName: 'arc-tunnel-mcp'
      } satisfies HelloMessage));
      const onMessage = (data: RawData) => {
        let message: unknown;
        try { message = JSON.parse(data.toString()); } catch {
          fail(new ArcTunnelError(ErrorCode.PROTOCOL_MISMATCH, 'Invalid Broker welcome message'));
          return;
        }
        if (!isWelcomeMessage(message)) {
          fail(new ArcTunnelError(ErrorCode.PROTOCOL_MISMATCH, 'Broker protocol mismatch'));
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => {
        if (!settled) fail(new ArcTunnelError(ErrorCode.CONNECTION_LOST, 'Unable to connect to Broker'));
      };
      const onClose = () => fail(new ArcTunnelError(ErrorCode.CONNECTION_LOST, 'Broker closed during handshake'));
      const timer = setTimeout(() => fail(new ArcTunnelError(ErrorCode.CONNECTION_LOST, 'Broker handshake timed out')), 5_000);
      ws.once('open', onOpen);
      ws.once('message', onMessage);
      ws.once('error', onError);
      ws.once('close', onClose);
    });
    return new BrokerClient(ws);
  }

  async call(command: string, params: Record<string, unknown>, timeout = 30_000): Promise<unknown> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new ArcTunnelError(ErrorCode.CONNECTION_LOST, 'Broker connection is closed');
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ArcTunnelError(ErrorCode.COMMAND_TIMEOUT, 'Broker command timed out'));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({
        type: 'agent_request', requestId, command, params, timeout
      } satisfies AgentRequest), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new ArcTunnelError(ErrorCode.CONNECTION_LOST, error.message));
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(ErrorCode.CONNECTION_LOST);
    this.ws.close();
  }

  private handleMessage(data: RawData): void {
    let message: unknown;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (!isAgentResponse(message)) return;
    const response = message as AgentResponse;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    if (response.success) {
      pending.resolve(response.result);
    } else {
      const code = response.error?.code as ErrorCode || ErrorCode.WEBSOCKET_ERROR;
      pending.reject(new ArcTunnelError(code, response.error?.message || code, response.error?.details));
    }
  }

  private rejectPending(code: ErrorCode): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ArcTunnelError(code, 'Broker connection was lost'));
    }
    this.pending.clear();
  }
}
