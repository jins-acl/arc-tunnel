import {
  ArcTunnelError,
  ErrorCode,
  PROTOCOL_VERSION,
  isAgentRequest,
  isAgentResponse,
  isBrowserEvent,
  isHelloMessage,
  isWelcomeMessage,
  toErrorInfo
} from '../src/protocol';
import { TEST_AUTH_TOKEN } from './helpers/auth';

describe('protocol guards', () => {
  it('requires a string token in current extension and agent hello messages', () => {
    expect(isHelloMessage({
      type: 'hello', role: 'agent', protocolVersion: PROTOCOL_VERSION, token: TEST_AUTH_TOKEN
    })).toBe(true);
    expect(isHelloMessage({
      type: 'hello', role: 'extension', protocolVersion: PROTOCOL_VERSION, token: TEST_AUTH_TOKEN
    })).toBe(true);
    expect(isHelloMessage({
      type: 'hello', role: 'agent', protocolVersion: PROTOCOL_VERSION
    })).toBe(false);
    expect(isHelloMessage({
      type: 'hello', role: 'agent', protocolVersion: PROTOCOL_VERSION, token: 42
    })).toBe(false);
    expect(isHelloMessage({
      type: 'hello', role: 'agent', protocolVersion: 999, token: TEST_AUTH_TOKEN
    })).toBe(false);
  });

  it('accepts exact welcome envelopes', () => {
    expect(isWelcomeMessage({ type: 'welcome', protocolVersion: 2, sessionId: 'session-1' })).toBe(true);
    expect(isWelcomeMessage({ type: 'welcome', protocolVersion: PROTOCOL_VERSION })).toBe(true);
    expect(isWelcomeMessage({ type: 'welcome', protocolVersion: 3 })).toBe(false);
  });

  it('accepts exact agent request envelopes', () => {
    expect(isAgentRequest({
      type: 'agent_request',
      requestId: 'req-1',
      command: 'navigate',
      params: { url: 'https://example.com' },
      timeout: 5000
    })).toBe(true);

    expect(isAgentRequest({
      type: 'agent_request',
      requestId: 'req-1',
      command: 'navigate',
      params: { url: 'https://example.com' }
    })).toBe(false);

    expect(isAgentRequest({
      type: 'agent_request',
      requestId: 'req-1',
      command: 'navigate',
      params: [],
      timeout: 5000
    })).toBe(false);
  });

  it('accepts exact agent response envelopes', () => {
    expect(isAgentResponse({
      type: 'agent_response',
      requestId: 'req-1',
      success: true,
      result: { ok: true }
    })).toBe(true);

    expect(isAgentResponse({
      type: 'agent_response',
      requestId: 'req-1',
      success: false,
      error: toErrorInfo(new ArcTunnelError(ErrorCode.COMMAND_TIMEOUT, 'Timed out'))
    })).toBe(true);

    expect(isAgentResponse({
      type: 'agent_response',
      requestId: 'req-1',
      success: false
    })).toBe(false);

    expect(isAgentResponse({
      type: 'agent_response',
      requestId: 'req-1',
      success: false,
      error: {}
    })).toBe(false);

    expect(isAgentResponse({
      type: 'agent_response',
      requestId: 'req-1',
      success: false,
      error: []
    })).toBe(false);
  });

  it('accepts exact browser event envelopes', () => {
    expect(isBrowserEvent({
      type: 'event',
      event: 'heartbeat',
      data: {},
      timestamp: Date.now()
    })).toBe(true);

    expect(isBrowserEvent({
      type: 'event',
      event: 'tab_created',
      data: { tabId: 3 },
      timestamp: Date.now()
    })).toBe(true);

    expect(isBrowserEvent({
      type: 'event',
      event: 'tab_updated',
      data: { tabId: 3 },
      timestamp: Date.now()
    })).toBe(false);

    expect(isBrowserEvent({
      type: 'event',
      event: 'tab_created',
      data: [],
      timestamp: Date.now()
    })).toBe(false);
  });
});

describe('protocol constants', () => {
  it('exports the required broker error codes', () => {
    expect(ErrorCode.TAB_NOT_OWNED).toBe('TAB_NOT_OWNED');
    expect(ErrorCode.EXTENSION_DISCONNECTED).toBe('EXTENSION_DISCONNECTED');
    expect(ErrorCode.COMMAND_TIMEOUT).toBe('COMMAND_TIMEOUT');
    expect(ErrorCode.PROTOCOL_MISMATCH).toBe('PROTOCOL_MISMATCH');
    expect(ErrorCode.PORT_IN_USE).toBe('PORT_IN_USE');
    expect(ErrorCode.RECORDING_BUSY).toBe('RECORDING_BUSY');
  });
});
