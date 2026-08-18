/**
 * Event envelope evidence.
 *
 * SUAS-specs EVENT_MODEL.md §2 (envelope), §3 (catalog), §8 (schema evolution),
 * §10 (testability); VERSIONING.md §3.4.
 */

import { describe, expect, it } from 'vitest';
import {
  assertBoundedPayload,
  DOMAIN_EVENT_TYPES,
  EventPayloadTooLargeError,
  isSupportedEventSchemaVersion,
  MAX_EVENT_PAYLOAD_BYTES,
  SUPPORTED_EVENT_SCHEMA_VERSIONS,
} from '../../src/events/index.js';
import { EVENT_SCHEMA_VERSION } from '../../src/release/pins.js';

describe('EVENT_MODEL.md §3 — released catalog', () => {
  it('carries exactly the 22 types released in v0.1', () => {
    expect(DOMAIN_EVENT_TYPES).toHaveLength(22);
  });

  it('includes the types named by the domain sections', () => {
    for (const type of [
      'CHECKIN_COMPLETED',
      'SUPPORT_SIGNAL_CHANGED',
      'RESPONDER_CONTACT_LOGGED',
      'CASE_RESOLVED',
      'CONSENT_REVOKED',
    ]) {
      expect(DOMAIN_EVENT_TYPES).toContain(type);
    }
  });

  it('contains no vendor-native event names', () => {
    const vendorish = DOMAIN_EVENT_TYPES.filter((type) =>
      /twilio|sendgrid|uber|lyft|stripe|webhook/i.test(type),
    );
    expect(vendorish).toEqual([]);
  });
});

describe('VERSIONING.md §3.4 — event schema version', () => {
  it('supports the released event schema version', () => {
    expect(SUPPORTED_EVENT_SCHEMA_VERSIONS).toContain(EVENT_SCHEMA_VERSION);
    expect(isSupportedEventSchemaVersion(EVENT_SCHEMA_VERSION)).toBe(true);
  });

  it('does not accept an unreleased version', () => {
    expect(isSupportedEventSchemaVersion('0.2.0')).toBe(false);
    expect(isSupportedEventSchemaVersion('')).toBe(false);
  });

  it('tracks the event schema version separately from the spec stack version', () => {
    // VERSIONING.md §3: identities must not be conflated. The spec stack is
    // 0.1.1 while the event schema remains 0.1.0.
    expect(EVENT_SCHEMA_VERSION).toBe('0.1.0');
  });
});

describe('EVENT_MODEL.md §2, §4 — payloads are bounded', () => {
  it('accepts a small structured payload', () => {
    expect(() => assertBoundedPayload({ case_id: 'c1', category: 'FOOD' })).not.toThrow();
  });

  it('rejects a payload over the bound, so notes and provider bodies cannot be dumped in', () => {
    const oversized = { note: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 1) };
    expect(() => assertBoundedPayload(oversized)).toThrow(EventPayloadTooLargeError);
  });
});
