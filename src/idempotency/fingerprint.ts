/**
 * Canonical request fingerprinting.
 *
 * Spec citations:
 * - SUAS-specs API.md §7.3-§7.4 — the same key with the same canonical request
 *   fingerprint reuses the original authoritative result; the same key with a
 *   conflicting request body or scope returns 409 IDEMPOTENCY_CONFLICT.
 * - SUAS-specs DATA_MODEL.md §10 (canonical request fingerprint column).
 *
 * "Canonical" must not depend on JSON key order or on incidental whitespace, or
 * a client that serializes the same request differently would be told its
 * identical retry conflicts.
 */

import { createHash } from 'node:crypto';

export type FingerprintableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FingerprintableValue[]
  | { [key: string]: FingerprintableValue };

/**
 * Deterministic serialization: object keys sorted, array order preserved
 * (array order is meaningful), `undefined` members omitted.
 */
export function canonicalize(value: FingerprintableValue): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);
    return `{${entries.join(',')}}`;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Cannot fingerprint a non-finite number.');
  }

  return JSON.stringify(value);
}

/** Stable fingerprint of a request body plus its logical scope. */
export function fingerprintRequest(value: FingerprintableValue): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/**
 * Compose the idempotency scope.
 * API.md §7.2: scope includes tenant plus the logical command/route and the
 * actor/aggregate context as appropriate. Tenant is a separate column, so it is
 * not repeated here.
 */
export function commandScope(parts: {
  command: string;
  aggregateType?: string;
  aggregateId?: string;
  actorId?: string;
}): string {
  return [parts.command, parts.aggregateType, parts.aggregateId, parts.actorId]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(':');
}
