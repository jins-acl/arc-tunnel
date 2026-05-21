# Recording Engine — Implementation Design (v1)

**Date:** 2026-05-21  
**Status:** Approved (scoped to v1 MVP)

## Problem

`recording-engine.ts` is a skeleton: `startRecording()` sets `isRecording=true`, `recordAction()` is never called, `stopRecording()` returns `actions: []`.

## Scope: Three Phases

| Phase | Actions | Scope | Selector |
|-------|---------|-------|----------|
| **v1 (this spec)** | click, type, navigate | single-tab | primary only |
| **v2** | scroll, keydown, submit, select | single-tab | fallback chain |
| **v3** | drag, cross-tab, visual selectors | cross-tab | coordinate fallback |

v1 is the minimum viable recording — captures the three most important interactions for replay.

## Architecture

```
User interacts with page
    │
    ▼
DOM event listeners (injected via Page.addScriptToEvaluateOnNewDocument)
    │  click → XPath-like CSS selector + tag + text + coordinates
    │  input → debounced 500ms, full value + selector
    │  navigate → detected via CDP Page.frameNavigated (not DOM polling)
    ▼
window.__web_bridge_record(action)
    │  (bound via Runtime.addBinding)
    ▼
RecordingEngine.recordAction()
    │  push to actions[]
    ▼
stopRecording() → saved to chrome.storage.local
```

### Why Page.addScriptToEvaluateOnNewDocument

One-shot `Runtime.evaluate` is wiped on page refresh or iframe navigation. `Page.addScriptToEvaluateOnNewDocument` runs the listener script on every frame load, ensuring recording survives refreshes, redirects, and iframe navigations.

### Why CDP Page.frameNavigated for navigate detection

DOM events (popstate, hashchange) miss link clicks, form submissions, and redirects. `Page.frameNavigated` covers all navigation types. The background page receives this via `chrome.debugger.onEvent` with `tabId`, matching the frame's URL to detect tab-level navigation.

## Files Changed

| File | Change |
|------|--------|
| `extension/src/background/recording-engine.ts` | Constructor takes `(debuggerController, tabManager)`. Add `injectListeners(tabId)`, `removeListeners(tabId)`, CDP event handler for `Page.frameNavigated`. Binding callback routes to `recordAction()`. |
| `extension/src/background/debugger-controller.ts` | Add `addBinding(tabId, name)`, `removeBinding(tabId, name)`, `addScriptOnNewDocument(tabId, script)` methods. |
| `extension/src/background/service-worker.ts` | Pass `debuggerController` to `RecordingEngine` constructor. |
| `extension/src/background/command-handler.ts` | `startRecording` → attach debugger + inject listeners. `stopRecording` → remove listeners. |
| `extension/src/types/index.ts` | Add `tabId` and `pageUrl` to `Action`. Expand `Action.type` to include new types. |
| `mcp-server/src/tools/index.ts` | Remove `[EXPERIMENTAL]` prefix from recording tools. |

## v1 Action Types

| Type | Source | Stored Fields |
|------|--------|---------------|
| `click` | click event (capture phase) | selector, tag, textContent(≤100), x, y, tabId, pageUrl |
| `type` | input event (debounced 500ms trailing) | selector, full value, tabId, pageUrl |
| `navigate` | CDP Page.frameNavigated | url, title, tabId |

## Injection Lifecycle

```
startRecording(tabId):
  1. Ensure CDP debugger attached to tabId
  2. Runtime.addBinding("__web_bridge_record") → binds window.__web_bridge_record to background
  3. Page.addScriptToEvaluateOnNewDocument(script) → injects listeners into every frame load
  4. Page.enable() → enables frame navigated events
  5. Register chrome.debugger.onEvent listener for Page.frameNavigated
  6. recordingEngine.startRecording(tabId)

stopRecording():
  1. Remove chrome.debugger.onEvent listener
  2. Runtime.removeBinding("__web_bridge_record")
  3. recordingEngine.stopRecording()
  4. (Optionally) detach debugger if no other features using it
```

## Injected Script (v1)

```javascript
(function() {
  // Build unique CSS selector for an element
  function buildSelector(el) {
    if (el.id && !/^\d/.test(el.id) && el.id.length < 36) return '#' + CSS.escape(el.id);
    var path = [];
    while (el && el.nodeType === 1 && path.length < 5) {
      var tag = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        var classes = el.className.trim().split(/\s+/).slice(0, 3).map(function(c) { return c; });
        if (classes.length) tag += '.' + classes.map(function(c) { return CSS.escape(c); }).join('.');
      }
      path.unshift(tag);
      el = el.parentElement;
    }
    return path.join(' > ');
  }

  function getActionContext(el) {
    return {
      selector: buildSelector(el),
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text: (el.textContent || '').trim().substring(0, 100),
      x: event ? event.clientX : 0,
      y: event ? event.clientY : 0
    };
  }

  // Click capture
  document.addEventListener('click', function(e) {
    window.__web_bridge_record({
      type: 'click',
      tabId: 0, // filled by background
      pageUrl: location.href,
      timestamp: Date.now(),
      target: { primary: getActionContext(e.target).selector },
      context: getActionContext(e.target)
    });
  }, true);

  // Input debounced capture
  var inputTimers = new WeakMap();
  document.addEventListener('input', function(e) {
    var el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return;
    if (inputTimers.has(el)) clearTimeout(inputTimers.get(el));
    inputTimers.set(el, setTimeout(function() {
      inputTimers.delete(el);
      window.__web_bridge_record({
        type: 'type',
        tabId: 0,
        pageUrl: location.href,
        timestamp: Date.now(),
        target: { primary: buildSelector(el) },
        text: el.value || el.textContent || ''
      });
    }, 500));
  }, true);
})();
```

## Known Limitations (documented, deferred to v2/v3)

- **Cross-origin iframes**: events inside cross-origin iframes are invisible to injected listeners
- **Shadow DOM**: `buildSelector()` does not penetrate shadow roots; elements inside shadow DOM will resolve to the shadow host
- **chrome:// pages**: CDP cannot attach debugger to chrome:// or chrome-extension:// URLs
- **Service worker restart**: terminates recording; state is not persisted to chrome.storage.session
- **Fallback chain**: v1 uses primary selector only; if selector fails during replay, the action is skipped. Full fallback chain (ElementTarget.fallbacks, context.nearbyText) deferred to v2.

## Backward Compatibility

Existing recordings (with `actions: []`) are unaffected — the empty array means no actions to replay. The `Action.type` expansion is additive (new union members), so old recordings with `navigate | click | type | wait` types are still valid. `PlaybackEngine` already handles unknown types by skipping — adding a `default: console.warn` case in the switch is recommended.

## Error Handling

- CDP attach failure → throw with code `DEBUGGER_ATTACH_FAILED`
- `Runtime.addBinding` collision → catch error, assume binding is already set (reconnect-after-SW-restart scenario)
- `chrome.storage.local.set` failure → log warning, return recording data anyway (caller has the object)
- Malformed data from page → validate required fields in binding callback, discard invalid actions

## Testing

- **Unit**: `buildSelector()` produces valid selectors; `recordAction()` appends with correct timestamp; debounce coalesces rapid inputs
- **Manual integration**: record click+type+navigate, stop, verify actions array, replay, verify each action executed
