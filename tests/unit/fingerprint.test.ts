/**
 * Canonical request fingerprint evidence.
 *
 * SUAS-specs API.md §7.3-§7.4; DATA_MODEL.md §10.
 */

import { describe, expect, it } from 'vitest';
import { canonicalize, commandScope, fingerprintRequest } from '../../src/idempotency/index.js';

describe('canonicalize', () => {
  it('is independent of object key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('is independent of key order at every depth', () => {
    const left = { outer: { z: [1, { q: 1, p: 2 }], a: true } };
    const right = { outer: { a: true, z: [1, { p: 2, q: 1 }] } };
    expect(canonicalize(left)).toBe(canonicalize(right));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('treats an omitted member and an explicit undefined alike', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('distinguishes null from a missing member', () => {
    expect(canonicalize({ a: 1, b: null })).not.toBe(canonicalize({ a: 1 }));
  });

  it('distinguishes a numeric value from its string form', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }));
  });

  it('refuses a non-finite number rather than fingerprinting it as null', () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(TypeError);
  });
});

describe('fingerprintRequest', () => {
  it('matches for identical requests serialized differently', () => {
    expect(fingerprintRequest({ category: 'FOOD', notes: null })).toBe(
      fingerprintRequest({ notes: null, category: 'FOOD' }),
    );
  });

  it('differs when any value changes', () => {
    expect(fingerprintRequest({ category: 'FOOD' })).not.toBe(
      fingerprintRequest({ category: 'SHELTER' }),
    );
  });
});

describe('commandScope', () => {
  it('composes command, aggregate, and actor context', () => {
    expect(
      commandScope({
        command: 'POST /cases/{id}/commands/claim',
        aggregateType: 'SupportCase',
        aggregateId: 'case-1',
        actorId: 'responder-1',
      }),
    ).toBe('POST /cases/{id}/commands/claim:SupportCase:case-1:responder-1');
  });

  it('omits absent context without leaving empty separators', () => {
    expect(commandScope({ command: 'POST /cases' })).toBe('POST /cases');
  });
});
