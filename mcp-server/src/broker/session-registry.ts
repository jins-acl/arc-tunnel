import { ArcTunnelError, ErrorCode } from '../protocol';

export interface AgentSession {
  id: string;
  connected: boolean;
  disconnectedAt: number | null;
  windowId: number | null;
  tabIds: Set<number>;
  recordingIds: Set<string>;
  activeRecordingId: string | null;
  savedSessionIds: Set<string>;
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; code: ErrorCode.TAB_NOT_OWNED };

export class SessionRegistry {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly tabOwners = new Map<number, string>();

  createSession(id: string): AgentSession {
    if (this.sessions.has(id)) {
      throw new Error(`Session already exists: ${id}`);
    }
    const session: AgentSession = {
      id,
      connected: true,
      disconnectedAt: null,
      windowId: null,
      tabIds: new Set(),
      recordingIds: new Set(),
      activeRecordingId: null,
      savedSessionIds: new Set()
    };
    this.sessions.set(id, session);
    return session;
  }

  windowId(sessionId: string): number | null {
    return this.requireSession(sessionId).windowId;
  }

  ownedTabIds(sessionId: string): number[] {
    return [...this.requireSession(sessionId).tabIds];
  }

  addRecording(sessionId: string, recordingId: string): void {
    const session = this.requireSession(sessionId);
    session.recordingIds.add(recordingId);
    session.activeRecordingId = recordingId;
  }

  assertOwnsRecording(sessionId: string, recordingId?: unknown): void {
    const session = this.requireSession(sessionId);
    const owns = typeof recordingId === 'string'
      ? session.recordingIds.has(recordingId)
      : session.activeRecordingId !== null;
    if (!owns) throw new ArcTunnelError(ErrorCode.RECORDING_NOT_FOUND, ErrorCode.RECORDING_NOT_FOUND);
  }

  hasActiveRecording(): boolean {
    return [...this.sessions.values()].some(session => session.activeRecordingId !== null);
  }

  clearRecordings(sessionId: string): void {
    this.requireSession(sessionId).activeRecordingId = null;
  }

  addSavedSession(sessionId: string, savedSessionId: string): void {
    this.requireSession(sessionId).savedSessionIds.add(savedSessionId);
  }

  assertOwnsSavedSession(sessionId: string, savedSessionId: unknown): void {
    if (typeof savedSessionId !== 'string' || !this.requireSession(sessionId).savedSessionIds.has(savedSessionId)) {
      throw new ArcTunnelError(ErrorCode.SESSION_NOT_FOUND, ErrorCode.SESSION_NOT_FOUND);
    }
  }

  reconcileTabs(existingTabIds: Set<number>): void {
    for (const tabId of [...this.tabOwners.keys()]) {
      if (!existingTabIds.has(tabId)) this.releaseTab(tabId);
    }
  }

  assignWindow(sessionId: string, windowId: number, tabIds: number[]): void {
    const session = this.requireSession(sessionId);
    for (const tabId of tabIds) {
      const owner = this.tabOwners.get(tabId);
      if (owner && owner !== sessionId) {
        throw new ArcTunnelError(ErrorCode.TAB_NOT_OWNED, ErrorCode.TAB_NOT_OWNED);
      }
    }
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

  claimTabsAtomically(sessionId: string, tabIds: number[]): void {
    const session = this.requireSession(sessionId);
    for (const tabId of tabIds) {
      const owner = this.tabOwners.get(tabId);
      if (owner && owner !== sessionId) {
        throw new ArcTunnelError(ErrorCode.TAB_NOT_OWNED, ErrorCode.TAB_NOT_OWNED);
      }
    }
    for (const tabId of tabIds) {
      session.tabIds.add(tabId);
      this.tabOwners.set(tabId, sessionId);
    }
  }

  releaseTab(tabId: number): void {
    const owner = this.tabOwners.get(tabId);
    if (!owner) return;
    this.sessions.get(owner)?.tabIds.delete(tabId);
    this.tabOwners.delete(tabId);
  }

  releaseWindow(windowId: number): number[] {
    const released: number[] = [];
    for (const session of this.sessions.values()) {
      if (session.windowId !== windowId) continue;
      for (const tabId of session.tabIds) {
        if (this.tabOwners.get(tabId) === session.id) {
          this.tabOwners.delete(tabId);
          released.push(tabId);
        }
      }
      session.tabIds.clear();
      session.windowId = null;
    }
    return released;
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
      session.recordingIds.clear();
      session.activeRecordingId = null;
      session.savedSessionIds.clear();
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
