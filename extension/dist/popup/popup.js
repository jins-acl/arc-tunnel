"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // src/auth-token.ts
  function isValidAuthToken(value) {
    return typeof value === "string" && AUTH_TOKEN_PATTERN.test(value) && CANONICAL_FINAL_CHARACTER_PATTERN.test(value[42]);
  }
  var AUTH_TOKEN_PATTERN, CANONICAL_FINAL_CHARACTER_PATTERN;
  var init_auth_token = __esm({
    "src/auth-token.ts"() {
      "use strict";
      AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
      CANONICAL_FINAL_CHARACTER_PATTERN = /^[AEIMQUYcgkosw048]$/;
    }
  });

  // src/websocket-url.ts
  function resolveConfiguredWebSocketUrl(value) {
    if (value === void 0) return DEFAULT_WS_URL;
    if (typeof value !== "string") return "";
    return LEGACY_DEFAULT_URLS.get(value) ?? value;
  }
  function normalizeWebSocketUrl(value) {
    const resolved = resolveConfiguredWebSocketUrl(value);
    const match = LOOPBACK_ENDPOINT_PATTERN.exec(resolved);
    if (!match) return null;
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return `ws://127.0.0.1:${port}/extension`;
  }
  var DEFAULT_WS_URL, LEGACY_DEFAULT_URLS, LOOPBACK_ENDPOINT_PATTERN;
  var init_websocket_url = __esm({
    "src/websocket-url.ts"() {
      "use strict";
      DEFAULT_WS_URL = "ws://127.0.0.1:8765";
      LEGACY_DEFAULT_URLS = /* @__PURE__ */ new Map([
        ["ws://localhost:8765", DEFAULT_WS_URL],
        ["ws://localhost:8765/", DEFAULT_WS_URL],
        ["ws://localhost:8765/extension", `${DEFAULT_WS_URL}/extension`]
      ]);
      LOOPBACK_ENDPOINT_PATTERN = /^ws:\/\/127\.0\.0\.1:([0-9]+)(?:\/(?:extension)?)?$/;
    }
  });

  // src/popup/popup.ts
  var require_popup = __commonJS({
    "src/popup/popup.ts"() {
      init_auth_token();
      init_websocket_url();
      var STORAGE_KEYS = ["arc_tunnel_ws_url", "authToken"];
      function checkStatus(statusEl) {
        try {
          chrome.runtime.sendMessage({ type: "get_status" }, (response) => {
            if (chrome.runtime.lastError || !response) {
              statusEl.textContent = "Status: Disconnected";
              statusEl.className = "status disconnected";
            } else if (response.state === "auth_failed") {
              statusEl.textContent = "Status: Authentication failed";
              statusEl.className = "status disconnected";
            } else if (response.connected) {
              statusEl.textContent = "Status: Connected";
              statusEl.className = "status connected";
            } else {
              statusEl.textContent = "Status: Disconnected";
              statusEl.className = "status disconnected";
            }
          });
        } catch {
          statusEl.textContent = "Status: Disconnected";
          statusEl.className = "status disconnected";
        }
      }
      function loadConfig(urlInput, tokenInput) {
        chrome.storage.local.get([...STORAGE_KEYS], (result) => {
          if (typeof result.arc_tunnel_ws_url === "string") {
            urlInput.value = result.arc_tunnel_ws_url;
          }
          if (typeof result.authToken === "string") {
            tokenInput.value = result.authToken;
          }
        });
      }
      function saveConfig(urlInput, tokenInput, statusEl) {
        const url = urlInput.value.trim();
        const authToken = tokenInput.value;
        if (!url) {
          statusEl.textContent = "Status: URL cannot be empty";
          statusEl.className = "status disconnected";
          return;
        }
        const normalizedUrl = normalizeWebSocketUrl(url);
        if (normalizedUrl === null) {
          statusEl.textContent = "Status: WebSocket URL must be ws://127.0.0.1:<port> with an optional /extension path";
          statusEl.className = "status disconnected";
          return;
        }
        if (!isValidAuthToken(authToken)) {
          statusEl.textContent = "Status: Authentication token must be a valid 43-character token";
          statusEl.className = "status disconnected";
          return;
        }
        chrome.storage.local.set({ arc_tunnel_ws_url: normalizedUrl, authToken }, () => {
          statusEl.textContent = "Status: Saved \u2014 reconnecting...";
          statusEl.className = "status disconnected";
          setTimeout(() => checkStatus(statusEl), 2e3);
        });
      }
      document.addEventListener("DOMContentLoaded", () => {
        const statusEl = document.getElementById("status");
        const urlInput = document.getElementById("ws-url");
        const tokenInput = document.getElementById("auth-token");
        const saveBtn = document.getElementById("save-config");
        if (!statusEl || !urlInput || !tokenInput || !saveBtn) return;
        statusEl.textContent = "Status: Checking...";
        statusEl.className = "status disconnected";
        loadConfig(urlInput, tokenInput);
        checkStatus(statusEl);
        const interval = setInterval(() => checkStatus(statusEl), 3e3);
        saveBtn.addEventListener("click", () => saveConfig(urlInput, tokenInput, statusEl));
        const saveOnEnter = (event) => {
          if (event.key === "Enter") {
            saveConfig(urlInput, tokenInput, statusEl);
          }
        };
        urlInput.addEventListener("keypress", saveOnEnter);
        tokenInput.addEventListener("keypress", saveOnEnter);
        window.addEventListener("unload", () => clearInterval(interval));
      });
    }
  });
  require_popup();
})();
