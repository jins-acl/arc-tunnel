import { DiagnosticsStore } from '../src/broker/diagnostics-store';

describe('DiagnosticsStore', () => {
  it('keeps the newest 200 sequenced events and reports stale cursors', () => {
    const store = new DiagnosticsStore({ pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 });
    for (let index = 0; index < 205; index++) {
      store.record({ level: 'info', category: 'broker', code: `EVENT_${index}`, summary: `事件 ${index}` });
    }
    const replay = store.eventsAfter(0);
    expect(replay.reset).toBe(true);
    expect(replay.events).toHaveLength(200);
    expect(replay.events[0].sequence).toBe(6);
    expect(replay.events[199].sequence).toBe(205);
  });

  it('notifies and removes subscribers', () => {
    const store = new DiagnosticsStore({ pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 });
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    store.record({ level: 'warning', category: 'connection', code: 'EXTENSION_DISCONNECTED', summary: '浏览器扩展已断开' });
    unsubscribe();
    store.record({ level: 'info', category: 'connection', code: 'EXTENSION_CONNECTED', summary: '浏览器扩展已连接' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('builds a safe aggregate snapshot without identity or browser fields', () => {
    const store = new DiagnosticsStore({ pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 });
    const snapshot = store.snapshot({ now: 5_000, connectedAgents: 2, graceAgents: 1, claimedTabs: 4, pendingCommands: 3 });
    expect(snapshot).toMatchObject({
      broker: { pid: 42, port: 9000, protocolVersion: 2, uptimeMs: 4_000 },
      agents: { connected: 2, grace: 1 },
      workload: { claimedTabs: 4, pendingCommands: 3 }
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/sessionId|tabId|url|cookie|script|params/i);
  });
});
