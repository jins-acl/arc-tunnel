// extension/src/background/session-manager.ts
import { SessionData, TabState } from '../types';

export class SessionManager {
  async saveSession(name: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const tabs = await chrome.tabs.query({});
    const tabStates: TabState[] = [];

    for (const tab of tabs) {
      if (tab.id && tab.url) {
        let cookies: chrome.cookies.Cookie[] = [];
        try {
          cookies = await chrome.cookies.getAll({ url: tab.url });
        } catch (error) {
          console.warn(`Failed to get cookies for ${tab.url}:`, error);
        }

        // NOTE: localStorage/sessionStorage are NOT captured — reading them
        // requires CDP Runtime.evaluate per tab. Only cookies are persisted.
        tabStates.push({
          url: tab.url,
          cookies,
          localStorage: {},
          sessionStorage: {}
        });
      }
    }

    const session: SessionData = {
      id: sessionId,
      name,
      tabs: tabStates,
      savedAt: new Date().toISOString()
    };

    await chrome.storage.local.set({
      [`session_${sessionId}`]: session
    });

    console.log(`Session saved: ${sessionId} (${tabStates.length} tabs)`);
    return sessionId;
  }

  async restoreSession(sessionId: string): Promise<void> {
    const result = await chrome.storage.local.get(`session_${sessionId}`);
    const session = result[`session_${sessionId}`] as SessionData | undefined;

    if (!session) {
      throw new Error('Session not found');
    }

    console.log(`Restoring session: ${sessionId} (${session.tabs.length} tabs)`);

    for (const tabState of session.tabs) {
      try {
        // Create tab
        const tab = await chrome.tabs.create({ url: tabState.url });

        // Restore cookies
        if (tab.id) {
          for (const cookie of tabState.cookies) {
            try {
              await chrome.cookies.set({
                url: tabState.url,
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || '/',
                secure: cookie.secure,
                httpOnly: cookie.httpOnly
              });
            } catch (cookieError) {
              console.warn(`Failed to restore cookie ${cookie.name}:`, cookieError);
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to restore tab ${tabState.url}:`, error);
      }
    }

    console.log('Session restored');
  }

  async listSessions(): Promise<SessionData[]> {
    const allData = await chrome.storage.local.get(null);
    const sessions: SessionData[] = [];

    for (const key of Object.keys(allData)) {
      if (key.startsWith('session_')) {
        sessions.push(allData[key] as SessionData);
      }
    }

    return sessions;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await chrome.storage.local.remove(`session_${sessionId}`);
    console.log(`Session deleted: ${sessionId}`);
  }
}
