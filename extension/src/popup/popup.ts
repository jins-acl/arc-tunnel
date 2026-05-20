// extension/src/popup/popup.ts
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;

  // Show checking state until we hear from the service worker
  statusEl.textContent = 'Status: Checking...';
  statusEl.className = 'status disconnected';

  try {
    chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
      if (chrome.runtime.lastError) {
        // Service worker not reachable
        statusEl.textContent = 'Status: Disconnected';
        statusEl.className = 'status disconnected';
        return;
      }
      if (response && response.connected) {
        statusEl.textContent = 'Status: Connected';
        statusEl.className = 'status connected';
      } else {
        statusEl.textContent = 'Status: Disconnected';
        statusEl.className = 'status disconnected';
      }
    });
  } catch (e) {
    statusEl.textContent = 'Status: Disconnected';
    statusEl.className = 'status disconnected';
  }
});
