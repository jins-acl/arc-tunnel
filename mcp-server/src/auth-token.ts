import { timingSafeEqual } from 'crypto';

export const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const AUTH_TOKEN_BYTES = 32;

export function isValidAuthToken(value: unknown): value is string {
  return typeof value === 'string' && AUTH_TOKEN_PATTERN.test(value);
}

export function verifyAuthToken(candidate: unknown, expected: string): boolean {
  if (!isValidAuthToken(expected)) return false;

  const candidateIsValid = isValidAuthToken(candidate);
  const candidateBytes = candidateIsValid
    ? Buffer.from(candidate, 'base64url')
    : Buffer.alloc(AUTH_TOKEN_BYTES);
  const expectedBytes = Buffer.from(expected, 'base64url');
  return timingSafeEqual(candidateBytes, expectedBytes) && candidateIsValid;
}
