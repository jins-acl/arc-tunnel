// extension/src/popup/popup.ts
import { isValidAuthToken } from '../auth-token';
import { normalizeWebSocketUrl } from '../websocket-url';

const STORAGE_KEYS = ['arc_tunnel_ws_url', 'authToken'] as const;

function checkStatus(statusEl: HTMLElement) {
  try {
    chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        statusEl.textContent = 'Status: Disconnected';
        statusEl.className = 'status disconnected';
      } else if (response.state === 'auth_failed') {
        statusEl.textContent = 'Status: Authentication failed';
        statusEl.className = 'status disconnected';
      } else if (response.connected) {
        statusEl.textContent = 'Status: Connected';
        statusEl.className = 'status connected';
      } else {
        statusEl.textContent = 'Status: Disconnected';
        statusEl.className = 'status disconnected';
      }
    });
  } catch {
    statusEl.textContent = 'Status: Disconnected';
    statusEl.className = 'status disconnected';
  }
}

function loadConfig(urlInput: HTMLInputElement, tokenInput: HTMLInputElement) {
  chrome.storage.local.get([...STORAGE_KEYS], (result) => {
    if (typeof result.arc_tunnel_ws_url === 'string') {
      urlInput.value = result.arc_tunnel_ws_url;
    }
    if (typeof result.authToken === 'string') {
      tokenInput.value = result.authToken;
    }
  });
}

function saveConfig(
  urlInput: HTMLInputElement,
  tokenInput: HTMLInputElement,
  statusEl: HTMLElement
) {
  const url = urlInput.value.trim();
  const authToken = tokenInput.value;
  if (!url) {
    statusEl.textContent = 'Status: URL cannot be empty';
    statusEl.className = 'status disconnected';
    return;
  }
  const normalizedUrl = normalizeWebSocketUrl(url);
  if (normalizedUrl === null) {
    statusEl.textContent =
      'Status: WebSocket URL must be ws://127.0.0.1:<port> with an optional /extension path';
    statusEl.className = 'status disconnected';
    return;
  }
  if (!isValidAuthToken(authToken)) {
    statusEl.textContent = 'Status: Authentication token must be a valid 43-character token';
    statusEl.className = 'status disconnected';
    return;
  }

  chrome.storage.local.set({ arc_tunnel_ws_url: normalizedUrl, authToken }, () => {
    statusEl.textContent = 'Status: Saved — reconnecting...';
    statusEl.className = 'status disconnected';
    // The background script will detect the storage change and reconnect
    setTimeout(() => checkStatus(statusEl), 2000);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const urlInput = document.getElementById('ws-url') as HTMLInputElement;
  const tokenInput = document.getElementById('auth-token') as HTMLInputElement;
  const saveBtn = document.getElementById('save-config');

  if (!statusEl || !urlInput || !tokenInput || !saveBtn) return;

  statusEl.textContent = 'Status: Checking...';
  statusEl.className = 'status disconnected';

  // Load saved config
  loadConfig(urlInput, tokenInput);

  // Check status
  checkStatus(statusEl);

  // Auto-refresh every 3s while popup is open
  const interval = setInterval(() => checkStatus(statusEl), 3000);

  // Save button handler
  saveBtn.addEventListener('click', () => saveConfig(urlInput, tokenInput, statusEl));

  // Enter key handler
  const saveOnEnter = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      saveConfig(urlInput, tokenInput, statusEl);
    }
  };
  urlInput.addEventListener('keypress', saveOnEnter);
  tokenInput.addEventListener('keypress', saveOnEnter);

  // Clean up interval when popup closes
  window.addEventListener('unload', () => clearInterval(interval));
});
