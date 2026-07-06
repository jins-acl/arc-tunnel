# Operations Control Center — Task 3 Report

## Status

Implemented the Chinese read-only Operations Control Center, exact static-asset routing, and build-time dashboard asset copying. No CLI, wrapper, mutation endpoint, browser-control command, or sensitive browser field was added.

## TDD evidence

### RED

Created `mcp-server/tests/dashboard.test.ts` before production changes and ran:

```text
cd mcp-server
npx jest --runInBand tests/dashboard.test.ts
```

Observed 4 expected failures:

- `/dashboard` returned 404 instead of 200.
- Required semantic IDs and browser functions were absent.
- `src/dashboard/dashboard.js` did not exist.
- `/dashboard/` returned 404 because the allowlist was not implemented.

The failures were caused by the missing feature rather than test syntax or setup.

### GREEN

After the minimal implementation, the same focused command passed:

```text
Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
```

The tests cover Chinese copy, same-origin assets, restrictive CSP, all required region IDs, the required browser functions, SSE/RESET wiring, safe DOM rendering, read-only API use, sensitive-name exclusion, and exact allowlist rejection.

## Implementation

- Added a semantic Chinese C-layout UI with status cards, Agent workload metrics, connection recovery, category filtering, diagnostic copying, and an offline banner.
- `renderStatus`, `appendEvent`, `setCategory`, and `copyDiagnostics` are plain browser functions.
- Event rows are created with `document.createElement` and populated with `textContent`; event data is never injected with `innerHTML`.
- Status is fetched from `/api/status`; events use `EventSource('/api/events')`; `RESET` clears rendered events and refetches status.
- The UI retains at most 200 diagnostic events.
- Diagnostic copying serializes only the current safe status snapshot and retained diagnostic events.
- Dashboard HTTP serving uses a fixed four-entry allowlist for `/dashboard`, `/dashboard/`, CSS, and JavaScript. Unknown dashboard paths return 404.
- Dashboard CSP uses same-origin defaults/scripts/styles/connections and disables objects, base URIs, and framing.
- The awaited build runs all three esbuild bundles before replacing `dist/dashboard` with a recursive copy of `src/dashboard`. The success log occurs only after copying.

## HTTP verification

Started the built `dist/arc-tunnel-broker.js` on an OS-selected temporary free port, requested the three copied resources, and stopped that owned process in `finally`.

```text
GET /dashboard                     200
GET /dashboard/dashboard.css       200
GET /dashboard/dashboard.js        200
CSP default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self';
    object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

The brief's literal `--port 0` check cannot run against the existing configuration parser because it rejects port 0. Per scope, Task 3 did not modify CLI/config behavior; the equivalent owned-process HTTP validation used a temporary nonzero free port.

## Verification summary

Fresh final verification:

- Focused dashboard Jest: 1 suite, 4 tests passed.
- MCP full Jest: 19 suites, 143 tests passed.
- TypeScript: `npx tsc -p tsconfig.test.json --noEmit` exited 0.
- Build: `npm run build` exited 0 and logged `MCP server build complete`.
- Artifact check: all three `dist/dashboard` files plus the Broker bundle and source map exist.
- `git diff --check`: exited 0 (Git emitted only line-ending conversion notices).

## Files

Created:

- `mcp-server/src/dashboard/index.html`
- `mcp-server/src/dashboard/dashboard.css`
- `mcp-server/src/dashboard/dashboard.js`
- `mcp-server/tests/dashboard.test.ts`
- `mcp-server/dist/dashboard/index.html`
- `mcp-server/dist/dashboard/dashboard.css`
- `mcp-server/dist/dashboard/dashboard.js`
- `.superpowers/sdd/ops-task-3-report.md`

Modified/generated:

- `mcp-server/src/broker/broker-server.ts`
- `mcp-server/esbuild.config.js`
- `mcp-server/dist/arc-tunnel-broker.js`
- `mcp-server/dist/arc-tunnel-broker.js.map`

## Self-review

- Confirmed no arbitrary request path is concatenated into a filesystem path; only allowlisted filenames reach `path.join`.
- Confirmed static pages and assets are GET-only and expose no mutation route.
- Confirmed API security headers remain unchanged (`default-src 'none'`), while dashboard pages receive the separate same-origin CSP.
- Confirmed source-mode tests resolve `src/dashboard`, while bundled execution resolves `dist/dashboard`.
- Confirmed no unrelated worktree changes were present or included.
- Remaining scoped concern: existing `--port 0` rejection noted above; changing it belongs to the configuration/CLI owner, not this task.

## Commit

Committed with subject `feat: add Chinese operations dashboard`; the final commit ID is supplied in the task handoff (this report is contained in that same commit).
