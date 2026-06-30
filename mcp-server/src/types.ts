// WebSocket message types
export interface CommandMessage {
  id: string;
  type: 'command';
  command: string;
  params: any;
  timeout?: number;
}

export interface ResponseMessage {
  id: string;
  type: 'response';
  success: boolean;
  result?: any;
  error?: ErrorInfo;
}

export interface EventMessage {
  type: 'event';
  event: string;
  data: any;
  timestamp: number;
}

export interface ErrorInfo {
  code: string;
  message: string;
  details?: unknown;
}

// Error codes
export enum ErrorCode {
  CONNECTION_LOST = 'CONNECTION_LOST',
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR',
  EXTENSION_DISCONNECTED = 'EXTENSION_DISCONNECTED',
  TAB_NOT_FOUND = 'TAB_NOT_FOUND',
  TAB_NOT_OWNED = 'TAB_NOT_OWNED',
  TAB_CLOSED = 'TAB_CLOSED',
  DEBUGGER_ATTACH_FAILED = 'DEBUGGER_ATTACH_FAILED',
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  ELEMENT_NOT_VISIBLE = 'ELEMENT_NOT_VISIBLE',
  ELEMENT_NOT_INTERACTABLE = 'ELEMENT_NOT_INTERACTABLE',
  TIMEOUT = 'TIMEOUT',
  COMMAND_TIMEOUT = 'COMMAND_TIMEOUT',
  SCRIPT_ERROR = 'SCRIPT_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  PROTOCOL_MISMATCH = 'PROTOCOL_MISMATCH',
  PORT_IN_USE = 'PORT_IN_USE',
  RECORDING_NOT_FOUND = 'RECORDING_NOT_FOUND',
  RECORDING_BUSY = 'RECORDING_BUSY',
  PLAYBACK_FAILED = 'PLAYBACK_FAILED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_RESTORE_FAILED = 'SESSION_RESTORE_FAILED'
}

// Pending command tracking
export interface PendingCommand {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}
