import { ArcTunnelError, ErrorCode } from '../protocol';

export interface AgentSession {
  id: string;
  connected: boolean;
  disconnectedAt: number | null;
  windowId: number | null;
  tabIds: Set<number>;
  recordingIds: Set<string>;
  savedSessionIds: Set<string>;
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; code: ErrorCode.TAB_NOT_OWNED };

export class SessionRegistry {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly tabOwners = new Map<number, string>();

  createSession(id: string): AgentSession {
    const session: AgentSession = {
      id,
      connected: true,
      disconnectedAt: null,
      windowId: null,
      tabIds: new Set(),
      recordingIds: new Set(),
      savedSessionIds: new Set()
    };
    this.sessions.set(id, session);
    return session;
  }

  assignWindow(sessionId: string, windowId: number, tabIds: number[]): void {
    const session = this.requireSession(sessionId);
    for (const tabId of session.tabIds) {
      this.tabOwners.delete(tabId);
    }
    session.tabIds.clear();
    session.windowId = windowId;
    for (const tabId of tabIds) {
      session.tabIds.add(tabId);
      this.tabOwners.set(tabId, sessionId);
    }
  }

  claimTab(sessionId: string, tabId: number): ClaimResult {
    const session = this.requireSession(sessionId);
    const owner = this.tabOwners.get(tabId);
    if (owner && owner !== sessionId) {
      return { ok: false, code: ErrorCode.TAB_NOT_OWNED };
    }
    session.tabIds.add(tabId);
    this.tabOwners.set(tabId, sessionId);
    return { ok: true };
  }

  releaseTab(tabId: number): void {
    const owner = this.tabOwners.get(tabId);
    if (!owner) return;
    this.sessions.get(owner)?.tabIds.delete(tabId);
    this.tabOwners.delete(tabId);
  }

  assertOwnsTab(sessionId: string, tabId: number): void {
    this.requireSession(sessionId);
    if (this.tabOwners.get(tabId) !== sessionId) {
      throw new ArcTunnelError(ErrorCode.TAB_NOT_OWNED, ErrorCode.TAB_NOT_OWNED);
    }
  }

  visibleTabs<T extends { tabId: number }>(sessionId: string, tabs: T[]): Array<T & { ownership: 'owned' | 'unclaimed' }> {
    this.requireSession(sessionId);
    return tabs.flatMap((tab) => {
      const owner = this.tabOwners.get(tab.tabId);
      if (owner && owner !== sessionId) return [];
      return [{ ...tab, ownership: owner === sessionId ? 'owned' as const : 'unclaimed' as const }];
    });
  }

  disconnect(sessionId: string, now: number): void {
    const session = this.requireSession(sessionId);
    session.connected = false;
    session.disconnectedAt = now;
  }

  expireDisconnected(now: number): number[] {
    const expired: number[] = [];
    for (const session of this.sessions.values()) {
      if (session.connected || session.disconnectedAt == null || now - session.disconnectedAt < 30_000) continue;
      for (const tabId of session.tabIds) {
        this.tabOwners.delete(tabId);
        expired.push(tabId);
      }
      session.tabIds.clear();
      session.windowId = null;
    }
    return expired;
  }

  private requireSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new ArcTunnelError(ErrorCode.SESSION_NOT_FOUND, ErrorCode.SESSION_NOT_FOUND);
    }
    return session;
  }
}
