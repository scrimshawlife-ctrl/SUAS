/**
 * Credential generation and hashing.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §3 — challenge secrets are "stored hashed/opaque, never
 *   plaintext secret material".
 * - SUAS-specs AUTH.md §5 — sessions are opaque revocable credentials.
 * - SUAS-specs SECURITY.md §2 — no secrets in git, logs, or client bundles.
 * - SUAS-specs ENVIRONMENT.md §6 — session/signing secrets are a secret class.
 *
 * Stored values are keyed HMACs rather than bare hashes: a six-digit OTP has too
 * little entropy for an unkeyed digest to protect if the database leaks, so the
 * server-side secret is required to check a candidate.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { OTP_CODE_DIGITS } from './constants.js';

export class SessionSecretMissingError extends Error {
  constructor() {
    super(
      'SUAS_SESSION_SECRET is required for authentication but is not configured ' +
        '(SUAS-specs ENVIRONMENT.md §3 "Auth / sessions", §5 required-secrets rule).',
    );
    this.name = 'SessionSecretMissingError';
  }
}

/** Keyed digest of a credential. The raw value is never persisted. */
export function hashCredential(secret: string | undefined, value: string): string {
  if (secret === undefined || secret === '') {
    throw new SessionSecretMissingError();
  }
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/** Constant-time comparison, so a candidate cannot be recovered by timing. */
export function credentialMatches(
  secret: string | undefined,
  candidate: string,
  storedHash: string,
): boolean {
  const computed = hashCredential(secret, candidate);
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Opaque high-entropy credential for magic links and sessions. */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Numeric code for OTP delivery. Uniformly random, not derived from time. */
export function generateOtpCode(digits = OTP_CODE_DIGITS.value): string {
  const max = 10 ** digits;
  return String(randomInt(0, max)).padStart(digits, '0');
}

/**
 * Normalize a destination for lookup and rate limiting, so casing or formatting
 * cannot be used to sidestep either.
 */
export function normalizeDestination(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed.replace(/[^\d+]/g, '');
}
