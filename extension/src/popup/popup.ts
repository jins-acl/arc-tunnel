// extension/src/popup/popup.ts

function checkStatus(statusEl: HTMLElement) {
  try {
    chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.connected) {
        statusEl.textContent = 'Status: Disconnected';
        statusEl.className = 'status disconnected';
      } else {
        statusEl.textContent = 'Status: Connected';
        statusEl.className = 'status connected';
      }
    });
  } catch (e) {
    statusEl.textContent = 'Status: Disconnected';
    statusEl.className = 'status disconnected';
  }
}

function loadConfig(urlInput: HTMLInputElement) {
  chrome.storage.local.get(['arc_tunnel_ws_url'], (result) => {
    if (typeof result.arc_tunnel_ws_url === 'string') {
      urlInput.value = result.arc_tunnel_ws_url;
    }
  });
}

function saveConfig(urlInput: HTMLInputElement, statusEl: HTMLElement) {
  const url = urlInput.value.trim();
  if (!url) {
    statusEl.textContent = 'Status: URL cannot be empty';
    statusEl.className = 'status disconnected';
    return;
  }

  chrome.storage.local.set({ arc_tunnel_ws_url: url }, () => {
    statusEl.textContent = 'Status: Saved — reconnecting...';
    statusEl.className = 'status disconnected';
    // The background script will detect the storage change and reconnect
    setTimeout(() => checkStatus(statusEl), 2000);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const urlInput = document.getElementById('ws-url') as HTMLInputElement;
  const saveBtn = document.getElementById('save-config');

  if (!statusEl || !urlInput || !saveBtn) return;

  statusEl.textContent = 'Status: Checking...';
  statusEl.className = 'status disconnected';

  // Load saved config
  loadConfig(urlInput);

  // Check status
  checkStatus(statusEl);

  // Auto-refresh every 3s while popup is open
  const interval = setInterval(() => checkStatus(statusEl), 3000);

  // Save button handler
  saveBtn.addEventListener('click', () => saveConfig(urlInput, statusEl));

  // Enter key handler
  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      saveConfig(urlInput, statusEl);
    }
  });

  // Clean up interval when popup closes
  window.addEventListener('unload', () => clearInterval(interval));
});
