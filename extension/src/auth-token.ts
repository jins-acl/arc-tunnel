export const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CANONICAL_FINAL_CHARACTER_PATTERN = /^[AEIMQUYcgkosw048]$/;

export function isValidAuthToken(value: unknown): value is string {
  return typeof value === 'string'
    && AUTH_TOKEN_PATTERN.test(value)
    && CANONICAL_FINAL_CHARACTER_PATTERN.test(value[42]);
}
