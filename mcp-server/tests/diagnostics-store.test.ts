import { DiagnosticsStore, ExtensionState } from '../src/broker/diagnostics-store';

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

  it('persists only approved event fields from inputs with extra properties', () => {
    const store = new DiagnosticsStore({ pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 });
    const input = {
      level: 'info' as const,
      category: 'broker' as const,
      code: 'SAFE_EVENT',
      summary: 'safe summary',
      url: 'https://secret.example',
      tabId: 12,
      sessionId: 'agent-secret',
      cookie: 'token=secret',
      script: 'steal()',
      params: { password: 'secret' },
      result: { private: true }
    };

    store.record(input);

    expect(Object.keys(store.eventsAfter(0).events[0]).sort()).toEqual(
      ['sequence', 'timestamp', 'level', 'category', 'code', 'summary'].sort()
    );
  });

  it('does not expose mutable references to stored events', () => {
    const store = new DiagnosticsStore({ pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 });
    let notified: Record<string, unknown> | undefined;
    store.subscribe(event => { notified = event as unknown as Record<string, unknown>; });
    const returned = store.record({ timestamp: 2_000, level: 'error', category: 'broker', code: 'BROKEN', summary: 'original' }) as unknown as Record<string, unknown>;

    returned.sequence = 99;
    returned.summary = 'changed return';
    returned.url = 'https://secret.example';
    notified!.summary = 'changed listener';
    const replayEvent = store.eventsAfter(0).events[0] as unknown as Record<string, unknown>;
    replayEvent.summary = 'changed replay';
    replayEvent.tabId = 9;

    expect(store.eventsAfter(0).events[0]).toEqual({
      sequence: 1,
      timestamp: 2_000,
      level: 'error',
      category: 'broker',
      code: 'BROKEN',
      summary: 'original'
    });
  });

  it('copies constructor state instead of retaining the broker input', () => {
    const broker = { pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 };
    const store = new DiagnosticsStore(broker);
    broker.pid = 13;
    broker.port = 1;
    broker.protocolVersion = 99;
    broker.startedAt = 4_500;

    expect(store.snapshot({ now: 5_000, connectedAgents: 0, graceAgents: 0, claimedTabs: 0, pendingCommands: 0 }).broker)
      .toEqual({ pid: 42, port: 9000, protocolVersion: 2, uptimeMs: 4_000 });
  });

  it('handles empty, retained-edge, current, and future replay cursors', () => {
    const store = new DiagnosticsStore({ pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 });
    expect(store.eventsAfter(0)).toEqual({ reset: false, events: [] });
    for (let index = 0; index < 201; index++) {
      store.record({ level: 'info', category: 'broker', code: `EVENT_${index}`, summary: `${index}` });
    }
    expect(store.eventsAfter(1).reset).toBe(false);
    expect(store.eventsAfter(201)).toEqual({ reset: false, events: [] });
    expect(store.eventsAfter(999)).toEqual({ reset: false, events: [] });
  });

  it('snapshots extension, recovery, and recent error state by value', () => {
    const store = new DiagnosticsStore({ pid: 42, port: 9000, protocolVersion: 2, startedAt: 1_000 });
    const extension: ExtensionState = { connected: true, generation: 3, reconnectPhase: 'running', lastSyncAt: 4_000 };
    store.setExtensionState(extension);
    extension.connected = false;
    store.setInventorySync('failed');
    store.setRecordingCleanup('running');
    store.record({ timestamp: 4_500, level: 'error', category: 'recovery', code: 'SYNC_FAILED', summary: 'sync failed' });
    const runtime = { now: 5_000, connectedAgents: 2, graceAgents: 1, claimedTabs: 4, pendingCommands: 3 };
    const first = store.snapshot(runtime);

    first.extension.generation = 100;
    first.recovery.inventorySync = 'idle';
    first.recentError!.summary = 'changed';

    expect(store.snapshot(runtime)).toMatchObject({
      extension: { connected: true, generation: 3, reconnectPhase: 'running', lastSyncAt: 4_000 },
      recovery: { inventorySync: 'failed', recordingCleanup: 'running' },
      recentError: { timestamp: 4_500, code: 'SYNC_FAILED', summary: 'sync failed' }
    });
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
