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

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;

  statusEl.textContent = 'Status: Checking...';
  statusEl.className = 'status disconnected';

  checkStatus(statusEl);

  // Auto-refresh every 3s while popup is open
  const interval = setInterval(() => checkStatus(statusEl), 3000);

  // Clean up interval when popup closes
  window.addEventListener('unload', () => clearInterval(interval));
});
