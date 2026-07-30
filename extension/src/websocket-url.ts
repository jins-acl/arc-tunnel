export const DEFAULT_WS_URL = 'ws://127.0.0.1:8765';

const LEGACY_DEFAULT_URLS = new Map([
  ['ws://localhost:8765', DEFAULT_WS_URL],
  ['ws://localhost:8765/', DEFAULT_WS_URL],
  ['ws://localhost:8765/extension', `${DEFAULT_WS_URL}/extension`]
]);

const LOOPBACK_ENDPOINT_PATTERN =
  /^ws:\/\/127\.0\.0\.1:([0-9]+)(?:\/(?:extension)?)?$/;

export function resolveConfiguredWebSocketUrl(value: unknown): string {
  if (value === undefined) return DEFAULT_WS_URL;
  if (typeof value !== 'string') return '';
  return LEGACY_DEFAULT_URLS.get(value) ?? value;
}

export function normalizeWebSocketUrl(value: unknown): string | null {
  const resolved = resolveConfiguredWebSocketUrl(value);
  const match = LOOPBACK_ENDPOINT_PATTERN.exec(resolved);
  if (!match) return null;

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return `ws://127.0.0.1:${port}/extension`;
}
