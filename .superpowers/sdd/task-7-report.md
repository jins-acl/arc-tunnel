# Task 7 Report: Recording, Replay, Saved-Session Ownership, And Reconnect Sync

## Status

Implemented agent-scoped recording and saved-session authorization, owned-workspace save/restore parameters, extension singleton recording rejection, and authoritative reconnect reconciliation while preserving fresh-Broker unclaimed inventory semantics.

## RED evidence

Command: `cd mcp-server && npm test -- --runInBand tests/broker-ownership.test.ts`

- Exit 1; 1 suite failed, 9 tests passed, 3 failed.
- Cross-agent `stop_recording` incorrectly resolved `{ ok: true }`.
- `save_session` forwarded no `tabIds`.
- removed tab 202 remained `owned` after extension reconnect.

Command: `cd extension && npm test`

- Exit 1; 12 tests, 10 passed, 2 failed.
- `saveSession` called forbidden `chrome.tabs.query({})` (`Error: must not query all tabs`).
- `restoreSession` returned `undefined` instead of `[1]` and did not target the supplied window.

Additional replay RED: `cd mcp-server && npm test -- --runInBand tests/broker-ownership.test.ts -t "does not leak recording"`

- Exit 1; owner replay after successful stop failed with `RECORDING_NOT_FOUND`, proving active-recording state needed separation from retained recording ownership.

## GREEN and verification evidence

Command: `cd mcp-server && npx tsc --noEmit && npm test -- --runInBand tests/broker-ownership.test.ts tests/broker-server.test.ts tests/session-registry.test.ts && npm run build`

- Exit 0; 3 suites passed, 33 tests passed; TypeScript and esbuild succeeded.

Command: `cd extension && npm test && npx tsc --noEmit && npm run build`

- Exit 0; 13 tests passed, 0 failed; TypeScript succeeded; `Extension build complete`.
- Lightweight Node+esbuild tests cover explicit-tab save, window-targeted restore with returned tab IDs, and exact `RECORDING_BUSY` command response.

Command: `cd mcp-server && npm test -- --runInBand`

- All assertions pass: 13 suites passed, 85 tests passed, 0 failed.
- Process exits 1 due the unchanged historical Jest late log from `src/websocket-server.ts:72`: `Cannot log after tests are done` / `Attempted to log "Extension disconnected (id=1)"`.

Command: `git diff --check`

- Exit 0; no whitespace errors (Git emitted only working-tree LF/CRLF conversion warnings).

## Files

- Broker source: `mcp-server/src/broker/session-registry.ts`, `mcp-server/src/broker/broker-server.ts`
- Broker tests: `mcp-server/tests/broker-ownership.test.ts`
- Extension source: `extension/src/background/session-manager.ts`, `extension/src/background/command-handler.ts`
- Extension tests/config: `extension/tests/session-manager.test.js`, `extension/package.json`
- Rebuilt artifacts: `mcp-server/dist/arc-tunnel-broker.js`, `mcp-server/dist/arc-tunnel-broker.js.map`, `extension/dist/background/service-worker.js`

## Self-review

- Resource identifiers are registered only in successful extension response handling; failed/time-out routes cannot claim ownership.
- Stop authorization uses only the active recording, while completed recording IDs remain available to their owner for replay.
- Foreign stop/replay/restore return the existing exact codes `RECORDING_NOT_FOUND` and `SESSION_NOT_FOUND`.
- Save receives registry-owned `tabIds`; restore receives the owned/lazily-created `windowId`, and restored tabs are claimed by the requesting agent.
- Reconnect parsing uses focused record/array/string guards. Replacement-extension sync prunes missing tabs but retains present ownership; a fresh Broker skips retention because its registry is empty.
- Expired disconnected sessions clear tabs, window, recording identifiers, active state, and saved-session identifiers; route cleanup remains unchanged.
- Existing lifecycle generation and scheduler authorization tests remain green.

## Concerns

- The known legacy websocket-server late-log defect still makes the otherwise fully passing MCP suite exit 1; it is outside Task 7 and unchanged.
