import { ArcTunnelError, ErrorCode } from '../src/protocol';
import { SessionRegistry } from '../src/broker/session-registry';

describe('SessionRegistry', () => {
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

  it('throws ArcTunnelError for unknown sessions', () => {
    const registry = new SessionRegistry();

    expect(() => registry.assignWindow('missing', 10, [1])).toThrow(ArcTunnelError);
    expect(() => registry.assignWindow('missing', 10, [1])).toThrow(ErrorCode.SESSION_NOT_FOUND);
  });
});
