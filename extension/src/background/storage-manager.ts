// extension/src/background/storage-manager.ts
// Manage cookies, localStorage, sessionStorage

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

export class StorageManager {
  // ─── Cookies ───

  async listCookies(tabId: number, domain?: string): Promise<CookieEntry[]> {
    const url = await this.getTabUrl(tabId);
    const cookies = await chrome.cookies.getAll({ url, domain });
    return cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite
    }));
  }

  async getCookie(tabId: number, name: string): Promise<CookieEntry | null> {
    const url = await this.getTabUrl(tabId);
    const cookies = await chrome.cookies.getAll({ url, name });
    if (cookies.length === 0) return null;
    const c = cookies[0];
    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite
    };
  }

  async setCookie(tabId: number, name: string, value: string, options?: { domain?: string; path?: string; secure?: boolean; httpOnly?: boolean }): Promise<void> {
    const url = await this.getTabUrl(tabId);
    const urlObj = new URL(url);
    await chrome.cookies.set({
      url,
      name,
      value,
      domain: options?.domain || urlObj.hostname,
      path: options?.path || '/',
      secure: options?.secure ?? false,
      httpOnly: options?.httpOnly ?? false
    });
  }

  async deleteCookie(tabId: number, name: string): Promise<void> {
    const url = await this.getTabUrl(tabId);
    await chrome.cookies.remove({ url, name });
  }

  async clearCookies(tabId: number): Promise<void> {
    const url = await this.getTabUrl(tabId);
    const cookies = await chrome.cookies.getAll({ url });
    for (const c of cookies) {
      await chrome.cookies.remove({ url, name: c.name });
    }
  }

  // ─── localStorage / sessionStorage ───

  async listStorage(tabId: number, type: 'local' | 'session'): Promise<Record<string, string>> {
    // We use chrome.scripting.executeScript instead of debuggerController.executeScript
    // because storage operations do NOT require debugger attachment, making them lighter-weight.
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (storeType: 'localStorage' | 'sessionStorage') => {
        const store = storeType === 'localStorage' ? localStorage : sessionStorage;
        const result: Record<string, string> = {};
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (key) result[key] = store.getItem(key) || '';
        }
        return result;
      },
      args: [type === 'local' ? 'localStorage' : 'sessionStorage']
    });
    return results[0]?.result || {};
  }

  async getStorageItem(tabId: number, type: 'local' | 'session', key: string): Promise<string | null> {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (storeType: 'localStorage' | 'sessionStorage', key: string) => {
        const store = storeType === 'localStorage' ? localStorage : sessionStorage;
        return store.getItem(key);
      },
      args: [type === 'local' ? 'localStorage' : 'sessionStorage', key]
    });
    return results[0]?.result ?? null;
  }

  async setStorageItem(tabId: number, type: 'local' | 'session', key: string, value: string): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (storeType: 'localStorage' | 'sessionStorage', key: string, value: string) => {
        const store = storeType === 'localStorage' ? localStorage : sessionStorage;
        store.setItem(key, value);
      },
      args: [type === 'local' ? 'localStorage' : 'sessionStorage', key, value]
    });
  }

  async deleteStorageItem(tabId: number, type: 'local' | 'session', key: string): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (storeType: 'localStorage' | 'sessionStorage', key: string) => {
        const store = storeType === 'localStorage' ? localStorage : sessionStorage;
        store.removeItem(key);
      },
      args: [type === 'local' ? 'localStorage' : 'sessionStorage', key]
    });
  }

  async clearStorage(tabId: number, type: 'local' | 'session'): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (storeType: 'localStorage' | 'sessionStorage') => {
        const store = storeType === 'localStorage' ? localStorage : sessionStorage;
        store.clear();
      },
      args: [type === 'local' ? 'localStorage' : 'sessionStorage']
    });
  }

  private async getTabUrl(tabId: number): Promise<string> {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || '';
  }
}
