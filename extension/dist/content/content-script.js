"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // src/shared/selector-builder.ts
  function buildSelector(el) {
    if (el.id && !/^\d/.test(el.id) && el.id.length < 36) return "#" + CSS.escape(el.id);
    const path = [];
    let curr = el;
    while (curr && curr.nodeType === 1 && path.length < 5) {
      const tag = curr.tagName.toLowerCase();
      if (curr.className && typeof curr.className === "string") {
        const classes = curr.className.trim().split(/\s+/).slice(0, 3);
        if (classes.length) {
          path.unshift(tag + "." + classes.map((c) => CSS.escape(c)).join("."));
          curr = curr.parentElement;
          continue;
        }
      }
      path.unshift(tag);
      curr = curr.parentElement;
    }
    return path.join(" > ");
  }
  var init_selector_builder = __esm({
    "src/shared/selector-builder.ts"() {
      "use strict";
    }
  });

  // src/content/content-script.ts
  var require_content_script = __commonJS({
    "src/content/content-script.ts"() {
      init_selector_builder();
      function getElementInfo(el) {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          className: el.className || "",
          text: (el.textContent || "").trim().substring(0, 200),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          selector: buildSelector(el)
        };
      }
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.type === "inspect_element") {
          const el = document.querySelector(message.selector);
          sendResponse(el ? { found: true, info: getElementInfo(el) } : { found: false });
          return true;
        }
        if (message.type === "list_interactive_elements") {
          const selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [onclick]';
          const elements = Array.from(document.querySelectorAll(selectors)).slice(0, 100);
          sendResponse({
            elements: elements.map(getElementInfo)
          });
          return true;
        }
        if (message.type === "get_page_info") {
          sendResponse({
            url: window.location.href,
            title: document.title,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            viewport: { width: window.innerWidth, height: window.innerHeight }
          });
          return true;
        }
        return false;
      });
    }
  });
  require_content_script();
})();
