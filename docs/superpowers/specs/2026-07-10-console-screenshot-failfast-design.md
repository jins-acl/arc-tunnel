# Arc Tunnel Console History, Screenshot Delivery, and Fail-Fast Design

Date: 2026-07-10
Status: Approved for implementation planning

## Scope

This change closes three remaining browser-tool gaps:

- D: `get_console_logs` must expose useful logs from before the tool call instead of
  beginning capture only when called.
- F: `screenshot` must avoid placing large base64 PNG payloads in MCP text content and
  must support explicit compression and resizing controls.
- C: stalled `execute_script` and `get_content` paths must have deterministic bounded
  tests and a repeatable real-browser frozen-page validation.

Existing tool names, tab ownership rules, Broker protocol version 2, and custom Broker
configuration remain unchanged.

## D: Page Console History

### Capture architecture

The extension will add a dedicated `console-hook` bundle as a static content script
running at `document_start` in the page's `MAIN` execution world. The manifest will
declare the Chromium version required for main-world content scripts.

The hook will:

- install idempotently under a private `Symbol.for(...)` key;
- wrap `console.debug`, `console.log`, `console.info`, `console.warn`, and
  `console.error` while still calling the original method with the original receiver;
- serialize arguments defensively without invoking arbitrary getters;
- bound individual text values and retain only the latest 500 entries;
- store level, rendered text, timestamp, and a best-effort source marker in a page-owned
  ring buffer.

Because the buffer lives in the page, it survives MV3 service-worker suspension. It is
recreated on navigation. Tabs already open when the extension is installed or reloaded
must be refreshed once before pre-call history is available.

### Retrieval and fallback

`get_console_logs` will first read the main-world ring buffer through
`chrome.scripting.executeScript({ world: 'MAIN' })`. It will preserve the existing
`logs` response field and add capture metadata:

```json
{
  "logs": [],
  "capture": {
    "source": "page-buffer",
    "historyAvailable": true,
    "limit": 500
  }
}
```

For restricted pages or an old tab without the hook, the command will fall back to CDP.
The CDP listener must be registered before `Runtime.enable`, preventing replayed events
from being lost. Fallback metadata will use `source: "cdp"` and explicitly report that
history before capture began is not guaranteed.

`minLevel` filtering will apply after retrieval. `warn` and `warning` will normalize to
one severity so the filter is consistent across page-buffer and CDP sources.

## F: Screenshot Delivery and Size Controls

### Tool inputs

The `screenshot` schema will keep `tabId` and `fullPage` and add optional inputs:

- `format`: `jpeg` or `png`; default `jpeg`.
- `quality`: integer 1-100; default 80 for JPEG and ignored for PNG.
- `maxWidth`: optional positive output-width limit.
- `maxHeight`: optional positive output-height limit.

The tool description will explain the defaults, the lossless PNG override, resizing,
and the cost of full-page images.

### Capture and resize pipeline

Both `chrome.tabs.captureVisibleTab` and CDP `Page.captureScreenshot` will receive the
requested format and JPEG quality. Existing activation timeout and CDP fallback behavior
remain intact.

When a dimension limit is supplied, an isolated image-processing helper will decode the
capture, calculate an aspect-ratio-preserving scale no greater than 1, and re-encode via
`createImageBitmap` and `OffscreenCanvas`. Invalid dimensions or quality values will be
rejected before capture. If the browser lacks the required resize primitives, a resize
request will fail clearly rather than silently returning an oversized image.

The extension response will contain the base64 data plus non-sensitive metadata such as
MIME type, output dimensions, original dimensions when decoded, and whether resizing
occurred.

### MCP response

The lightweight MCP client will special-case a successful `screenshot` result and emit
standard MCP image content:

```json
{
  "content": [
    { "type": "image", "data": "<base64>", "mimeType": "image/jpeg" },
    { "type": "text", "text": "{\"format\":\"jpeg\",\"quality\":80}" }
  ]
}
```

The base64 payload must not also appear in text content. Other tools retain the existing
JSON text response behavior. Malformed screenshot results will return a normal MCP tool
error rather than leaking a large or unusable text payload.

## C: Frozen-Page Fail-Fast Verification

The existing timeout policy remains:

- generic CDP commands, including `Runtime.evaluate`: 5 seconds;
- `Input.*` commands: 15 seconds;
- lightweight-first execution: 1.5 seconds before CDP fallback;
- Broker command deadline: 30 seconds.

Automated tests will cover `execute_script` and `get_content` when both the lightweight
path and CDP callback stall. They must return a coded `TIMEOUT` within a bounded interval
and must not wait for the Broker deadline. The tests will also ensure the longer input
timeout remains unchanged.

A repeatable manual validation script or documented harness will serve a local page,
schedule a permanent main-thread busy loop, and then verify through the real extension:

- `execute_script` and `get_content` fail with `TIMEOUT` in approximately 6.5 seconds
  and within an 8-second acceptance bound;
- `screenshot` still succeeds where compositor capture is available;
- `close_tab` still closes the frozen tab;
- the validation releases claims, closes created tabs, stops only processes it started,
  and never stops an unknown listener.

If the real browser produces a different timing, implementation will return to root-cause
analysis rather than widening timeouts blindly.

## Compatibility and Security

- The console hook captures only the page's own console arguments and does not transmit
  them until an Agent explicitly calls `get_console_logs` on a claimed tab.
- Console entries are bounded in count and size to avoid unbounded page memory use or
  oversized Broker responses.
- The hook does not expose extension APIs to the main world.
- Screenshot metadata excludes URLs, cookies, page text, and Agent/session identifiers.
- Existing saved extension configuration and protocol version remain compatible.
- The committed `extension/dist/` and MCP bundles must be rebuilt with source changes.

## Test and Review Gates

Each of D, F, and C will follow RED-GREEN-REFACTOR and receive independent specification
and code-quality review before the next item begins. Completion requires:

1. focused extension and MCP tests;
2. repository `npm run verify`;
3. deterministic committed-bundle checks;
4. real Edge validation for console history, screenshot delivery, and frozen-page timing;
5. Ubuntu and Windows CI success;
6. merge of the reviewed branch into `master` and verification of the resulting remote
   `master` commit.
