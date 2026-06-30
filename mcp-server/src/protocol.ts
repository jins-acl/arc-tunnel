import { ErrorCode, ErrorInfo } from './types';

export { ErrorCode, ErrorInfo } from './types';

export const PROTOCOL_VERSION = 2;

export type ConnectionRole = 'agent' | 'extension';
export type BrowserEventName = 'heartbeat' | 'tab_created' | 'tab_removed' | 'window_removed';

export interface HelloMessage {
  type: 'hello';
  role: ConnectionRole;
  protocolVersion: number;
  clientName?: string;
}

export interface WelcomeMessage {
  type: 'welcome';
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId?: string;
}

export interface AgentRequest {
  type: 'agent_request';
  requestId: string;
  command: string;
  params: Record<string, unknown>;
  timeout: number;
}

export interface AgentResponse {
  type: 'agent_response';
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: ErrorInfo;
}

export interface BrowserEvent {
  type: 'event';
  event: BrowserEventName;
  data: Record<string, unknown>;
  timestamp: number;
}

export class ArcTunnelError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) {
    super(message);
    this.name = 'ArcTunnelError';
  }
}

export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof ArcTunnelError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isHelloMessage(value: unknown): value is HelloMessage {
  return isRecord(value)
    && value.type === 'hello'
    && (value.role === 'agent' || value.role === 'extension')
    && value.protocolVersion === PROTOCOL_VERSION
    && (value.clientName === undefined || typeof value.clientName === 'string');
}

export function isWelcomeMessage(value: unknown): value is WelcomeMessage {
  return isRecord(value)
    && value.type === 'welcome'
    && value.protocolVersion === PROTOCOL_VERSION
    && (value.sessionId === undefined || typeof value.sessionId === 'string');
}

export function isAgentRequest(value: unknown): value is AgentRequest {
  return isRecord(value)
    && value.type === 'agent_request'
    && typeof value.requestId === 'string'
    && typeof value.command === 'string'
    && isRecord(value.params)
    && typeof value.timeout === 'number';
}

export function isAgentResponse(value: unknown): value is AgentResponse {
  return isRecord(value)
    && value.type === 'agent_response'
    && typeof value.requestId === 'string'
    && typeof value.success === 'boolean'
    && (value.success || isRecord(value.error));
}

export function isBrowserEvent(value: unknown): value is BrowserEvent {
  return isRecord(value)
    && value.type === 'event'
    && (value.event === 'heartbeat'
      || value.event === 'tab_created'
      || value.event === 'tab_removed'
      || value.event === 'window_removed')
    && isRecord(value.data)
    && typeof value.timestamp === 'number';
}
