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
      function loadConfig(urlInput) {
        chrome.storage.local.get(["arc_tunnel_ws_url"], (result) => {
          if (typeof result.arc_tunnel_ws_url === "string") {
            urlInput.value = result.arc_tunnel_ws_url;
          }
        });
      }
      function saveConfig(urlInput, statusEl) {
        const url = urlInput.value.trim();
        if (!url) {
          statusEl.textContent = "Status: URL cannot be empty";
          statusEl.className = "status disconnected";
          return;
        }
        chrome.storage.local.set({ arc_tunnel_ws_url: url }, () => {
          statusEl.textContent = "Status: Saved \u2014 reconnecting...";
          statusEl.className = "status disconnected";
          setTimeout(() => checkStatus(statusEl), 2e3);
        });
      }
      document.addEventListener("DOMContentLoaded", () => {
        const statusEl = document.getElementById("status");
        const urlInput = document.getElementById("ws-url");
        const saveBtn = document.getElementById("save-config");
        if (!statusEl || !urlInput || !saveBtn) return;
        statusEl.textContent = "Status: Checking...";
        statusEl.className = "status disconnected";
        loadConfig(urlInput);
        checkStatus(statusEl);
        const interval = setInterval(() => checkStatus(statusEl), 3e3);
        saveBtn.addEventListener("click", () => saveConfig(urlInput, statusEl));
        urlInput.addEventListener("keypress", (e) => {
          if (e.key === "Enter") {
            saveConfig(urlInput, statusEl);
          }
        });
        window.addEventListener("unload", () => clearInterval(interval));
      });
    }
  });
  require_popup();
})();
