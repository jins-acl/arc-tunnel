import { ArcTunnelError, ErrorCode } from '../src/protocol';
import { SessionRegistry } from '../src/broker/session-registry';

describe('SessionRegistry', () => {
  it('reports only aggregate connected, grace, and claimed-tab counts', () => {
    const registry = new SessionRegistry();
    registry.createSession('connected-secret');
    registry.createSession('grace-secret');
    registry.claimTab('connected-secret', 91);
    registry.claimTab('grace-secret', 92);
    registry.disconnect('grace-secret', 1_000);

    expect(registry.diagnosticsCounts()).toEqual({ connected: 1, grace: 1, claimedTabs: 2 });
  });

  it('does not count an expired retained session as grace', () => {
    const registry = new SessionRegistry();
    registry.createSession('retained-cleanup');
    registry.disconnect('retained-cleanup', 1_000);

    registry.expireDisconnected(31_000);
    registry.pruneDisconnected(31_000, new Set(['retained-cleanup']));

    expect(registry.diagnosticsCounts()).toEqual({ connected: 0, grace: 0, claimedTabs: 0 });
    expect(() => registry.assertConnected('retained-cleanup')).toThrow(ErrorCode.EXTENSION_DISCONNECTED);
  });

  it('enforces ownership boundaries and per-session visibility', () => {
    const registry = new SessionRegistry();
    const alpha = registry.createSession('alpha');
    const beta = registry.createSession('beta');

    registry.assignWindow(alpha.id, 10, [101]);

    expect(registry.claimTab(beta.id, 101)).toEqual({ ok: false, code: ErrorCode.TAB_NOT_OWNED });
    expect(() => registry.assertOwnsTab(beta.id, 101)).toThrow(ErrorCode.TAB_NOT_OWNED);
    expect(registry.visibleTabs(alpha.id, [{ tabId: 101 }, { tabId: 102 }])).toEqual([
      { tabId: 101, ownership: 'owned' },
      { tabId: 102, ownership: 'unclaimed' }
    ]);
    expect(registry.visibleTabs(beta.id, [{ tabId: 101 }, { tabId: 102 }])).toEqual([
      { tabId: 102, ownership: 'unclaimed' }
    ]);
  });

  it('releases and reassigns ownership explicitly', () => {
    const registry = new SessionRegistry();
    const alpha = registry.createSession('alpha');
    const beta = registry.createSession('beta');

    expect(registry.claimTab(alpha.id, 201)).toEqual({ ok: true });
    expect(registry.claimTab(beta.id, 201)).toEqual({ ok: false, code: ErrorCode.TAB_NOT_OWNED });

    registry.releaseTab(201);

    expect(registry.claimTab(beta.id, 201)).toEqual({ ok: true });
    expect(() => registry.assertOwnsTab(alpha.id, 201)).toThrow(ErrorCode.TAB_NOT_OWNED);
    expect(registry.visibleTabs(beta.id, [{ tabId: 201 }, { tabId: 202 }])).toEqual([
      { tabId: 201, ownership: 'owned' },
      { tabId: 202, ownership: 'unclaimed' }
    ]);
  });

  it('releases every owned tab for a removed window atomically', () => {
    const registry = new SessionRegistry();
    const alpha = registry.createSession('alpha');
    const beta = registry.createSession('beta');

    registry.assignWindow(alpha.id, 88, [701, 702]);

    expect(registry.releaseWindow(88)).toEqual([701, 702]);
    expect(registry.claimTab(beta.id, 701)).toEqual({ ok: true });
    expect(registry.claimTab(beta.id, 702)).toEqual({ ok: true });
    expect(registry.releaseWindow(88)).toEqual([]);
  });

  it('replaces previously assigned window tabs for the same session', () => {
    const registry = new SessionRegistry();
    const alpha = registry.createSession('alpha');
    const beta = registry.createSession('beta');

    registry.assignWindow(alpha.id, 10, [301, 302]);
    registry.assignWindow(alpha.id, 11, [303]);

    expect(registry.claimTab(beta.id, 301)).toEqual({ ok: true });
    expect(registry.claimTab(beta.id, 302)).toEqual({ ok: true });
    expect(registry.claimTab(beta.id, 303)).toEqual({ ok: false, code: ErrorCode.TAB_NOT_OWNED });
  });

  it('rejects a window assignment collision without partially mutating ownership', () => {
    const registry = new SessionRegistry();
    const alpha = registry.createSession('alpha');
    const beta = registry.createSession('beta');
    const gamma = registry.createSession('gamma');

    registry.assignWindow(alpha.id, 10, [301, 302]);
    registry.assignWindow(beta.id, 20, [401]);

    expect(() => registry.assignWindow(beta.id, 21, [402, 301])).toThrow(ErrorCode.TAB_NOT_OWNED);
    expect(() => registry.assertOwnsTab(alpha.id, 301)).not.toThrow();
    expect(() => registry.assertOwnsTab(alpha.id, 302)).not.toThrow();
    expect(() => registry.assertOwnsTab(beta.id, 401)).not.toThrow();
    expect(registry.claimTab(gamma.id, 402)).toEqual({ ok: true });
  });

  it('rejects a duplicate session ID without corrupting existing ownership', () => {
    const registry = new SessionRegistry();
    const alpha = registry.createSession('alpha');
    const beta = registry.createSession('beta');

    registry.assignWindow(alpha.id, 10, [501]);

    expect(() => registry.createSession(alpha.id)).toThrow('Session already exists: alpha');
    expect(() => registry.assertOwnsTab(alpha.id, 501)).not.toThrow();
    expect(registry.claimTab(beta.id, 501)).toEqual({ ok: false, code: ErrorCode.TAB_NOT_OWNED });
  });

  it('expires disconnected ownership at exactly 30 seconds', () => {
    const registry = new SessionRegistry();
    const alpha = registry.createSession('alpha');
    const beta = registry.createSession('beta');

    registry.assignWindow(alpha.id, 12, [401, 402]);
    registry.disconnect(alpha.id, 1_000);

    expect(registry.expireDisconnected(30_999)).toEqual([]);
    expect(registry.claimTab(beta.id, 401)).toEqual({ ok: false, code: ErrorCode.TAB_NOT_OWNED });
    expect(registry.expireDisconnected(31_000)).toEqual([401, 402]);
    expect(registry.claimTab(beta.id, 401)).toEqual({ ok: true });
    expect(registry.visibleTabs(beta.id, [{ tabId: 401 }, { tabId: 402 }])).toEqual([
      { tabId: 401, ownership: 'owned' },
      { tabId: 402, ownership: 'unclaimed' }
    ]);
  });

  it('deletes expired sessions unless lifecycle cleanup still retains them', () => {
    const registry = new SessionRegistry();
    registry.createSession('alpha');
    registry.disconnect('alpha', 1_000);
    registry.expireDisconnected(31_000);

    expect(registry.pruneDisconnected(31_000, new Set(['alpha']))).toEqual([]);
    expect(() => registry.assertConnected('alpha')).toThrow(ErrorCode.EXTENSION_DISCONNECTED);
    expect(registry.pruneDisconnected(31_000)).toEqual(['alpha']);
    expect(() => registry.assertConnected('alpha')).toThrow(ErrorCode.SESSION_NOT_FOUND);
  });

  it('throws ArcTunnelError for unknown sessions', () => {
    const registry = new SessionRegistry();

    expect(() => registry.assignWindow('missing', 10, [1])).toThrow(ArcTunnelError);
    expect(() => registry.assignWindow('missing', 10, [1])).toThrow(ErrorCode.SESSION_NOT_FOUND);
  });
});
