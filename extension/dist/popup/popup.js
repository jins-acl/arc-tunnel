"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // src/popup/popup.ts
  var require_popup = __commonJS({
    "src/popup/popup.ts"() {
      function checkStatus(statusEl) {
        try {
          chrome.runtime.sendMessage({ type: "get_status" }, (response) => {
            if (chrome.runtime.lastError || !response || !response.connected) {
              statusEl.textContent = "Status: Disconnected";
              statusEl.className = "status disconnected";
            } else {
              statusEl.textContent = "Status: Connected";
              statusEl.className = "status connected";
            }
          });
        } catch (e) {
          statusEl.textContent = "Status: Disconnected";
          statusEl.className = "status disconnected";
        }
      }
      document.addEventListener("DOMContentLoaded", () => {
        const statusEl = document.getElementById("status");
        if (!statusEl) return;
        statusEl.textContent = "Status: Checking...";
        statusEl.className = "status disconnected";
        checkStatus(statusEl);
        const interval = setInterval(() => checkStatus(statusEl), 3e3);
        window.addEventListener("unload", () => clearInterval(interval));
      });
    }
  });
  require_popup();
})();
