/**
 * Synthetic fixture boundary evidence.
 *
 * SUAS-specs ENVIRONMENT.md §2, §7; TESTING.md §12; HANDOFF.md §5.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  assertSyntheticContact,
  assertSyntheticEnvironment,
  FixtureBoundaryError,
  isSyntheticEmail,
  isSyntheticPhone,
  scanForNonSyntheticContactData,
  syntheticEmail,
  syntheticPhone,
} from '../../src/testing/fixture-boundary.js';
import { validEnv } from '../helpers/env.js';

describe('environment gate', () => {
  it.each(['LOCAL', 'TEST'])('permits fixtures in %s', (environment) => {
    expect(() =>
      assertSyntheticEnvironment(loadConfig(validEnv({ SUAS_ENV: environment }))),
    ).not.toThrow();
  });

  it('refuses fixtures in PRODUCTION', () => {
    // PRODUCTION cannot be loaded through loadConfig while SPEC-018 is open, so the
    // boundary is exercised against a hand-built config object.
    const config = { ...loadConfig(validEnv()), environment: 'PRODUCTION' as const };
    expect(() => assertSyntheticEnvironment(config)).toThrow(FixtureBoundaryError);
  });

  it('refuses fixtures whenever real external effects are enabled', () => {
    const config = { ...loadConfig(validEnv()), allowRealExternalEffects: true };
    expect(() => assertSyntheticEnvironment(config)).toThrow(FixtureBoundaryError);
  });
});

describe('synthetic contact data', () => {
  it.each([
    'veteran-01@example.invalid',
    'responder@example.com',
    'admin@sub.example.org',
    'someone@thing.test',
  ])('accepts reserved address %s', (email) => {
    expect(isSyntheticEmail(email)).toBe(true);
  });

  it.each(['someone@gmail.com', 'contact@va.gov', 'person@realclinic.org'])(
    'rejects routable address %s',
    (email) => {
      expect(isSyntheticEmail(email)).toBe(false);
    },
  );

  it.each(['+1-555-555-0123', '(555) 555-0100', '5555550199'])(
    'accepts reserved number %s',
    (phone) => {
      expect(isSyntheticPhone(phone)).toBe(true);
    },
  );

  it.each(['+1-415-555-1234', '(212) 867-5309', '5555550200'])(
    'rejects potentially real number %s',
    (phone) => {
      expect(isSyntheticPhone(phone)).toBe(false);
    },
  );

  it('generates values that satisfy its own boundary', () => {
    expect(() => assertSyntheticContact(syntheticEmail('veteran-01'))).not.toThrow();
    expect(() => assertSyntheticContact(syntheticPhone(7))).not.toThrow();
    expect(syntheticPhone(7)).toBe('+1-555-555-0107');
  });

  it('rejects an out-of-range synthetic phone index', () => {
    expect(() => syntheticPhone(100)).toThrow(FixtureBoundaryError);
  });
});

describe('scanForNonSyntheticContactData', () => {
  it('finds routable contact data in fixture text', () => {
    const findings = scanForNonSyntheticContactData(
      'name: Test Veteran\nemail: real.person@gmail.com\nphone: (415) 555-1234\n',
    );
    expect(findings.map((finding) => finding.kind).sort()).toEqual(['email', 'phone']);
  });

  it('ignores connection-string credentials but not adjacent contact data', () => {
    const findings = scanForNonSyntheticContactData(
      'DATABASE_URL=postgresql://user:pw@db.internal:5432/suas\ncontact: real.person@gmail.com\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.value).toBe('real.person@gmail.com');
  });

  it('ignores long digit runs that are not phone numbers', () => {
    expect(
      scanForNonSyntheticContactData('checksum 1787084602308551234 and 0.1.1 build 20260818'),
    ).toEqual([]);
  });

  it('passes clean synthetic fixture text', () => {
    expect(
      scanForNonSyntheticContactData('email: veteran-01@example.invalid\nphone: +1-555-555-0101\n'),
    ).toEqual([]);
  });
});
