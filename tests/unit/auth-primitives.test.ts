/**
 * Auth primitive evidence.
 *
 * SUAS-specs AUTH.md §3 (constants are documented and labelled INFERRED; secrets
 * stored hashed), §4 (MFA factor selected later), §9 (unavailable channel is not
 * faked); SECURITY.md §2; ENVIRONMENT.md §3.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  availableChannels,
  channelForMethod,
  ChannelUnavailableError,
  createChallengeDelivery,
  createMfaPort,
  credentialMatches,
  generateOpaqueToken,
  generateOtpCode,
  hashCredential,
  INFERRED,
  INFERRED_AUTH_CONSTANTS,
  MfaUnavailableError,
  normalizeDestination,
  SessionSecretMissingError,
  TestMfaFactor,
} from '../../src/auth/index.js';
import { validEnv } from '../helpers/env.js';

const SECRET = 'x'.repeat(48);

describe('AUTH.md §3, §5 — deferred constants are labelled', () => {
  it('marks every auth constant INFERRED, since none is a released decision', () => {
    for (const [name, constant] of Object.entries(INFERRED_AUTH_CONSTANTS)) {
      expect(constant.lifecycle, `${name} must be labelled INFERRED`).toBe(INFERRED);
      expect(constant.value).toBeGreaterThan(0);
      expect(constant.rationale.length).toBeGreaterThan(20);
    }
  });

  it('keeps MFA elevation shorter than the session it elevates', () => {
    expect(INFERRED_AUTH_CONSTANTS.MFA_ELEVATION_TTL_SECONDS?.value).toBeLessThan(
      INFERRED_AUTH_CONSTANTS.SESSION_IDLE_TTL_SECONDS?.value ?? 0,
    );
    expect(INFERRED_AUTH_CONSTANTS.SESSION_IDLE_TTL_SECONDS?.value).toBeLessThan(
      INFERRED_AUTH_CONSTANTS.SESSION_ABSOLUTE_TTL_SECONDS?.value ?? 0,
    );
  });
});

describe('AUTH.md §3 — credential handling', () => {
  it('never returns the raw value from hashing', () => {
    const hash = hashCredential(SECRET, '123456');
    expect(hash).not.toContain('123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keys the digest, so a leaked database alone cannot check a candidate', () => {
    expect(hashCredential(SECRET, '123456')).not.toBe(hashCredential('y'.repeat(48), '123456'));
  });

  it('refuses to hash without a configured secret', () => {
    expect(() => hashCredential(undefined, '123456')).toThrow(SessionSecretMissingError);
    expect(() => hashCredential('', '123456')).toThrow(SessionSecretMissingError);
  });

  it('matches only the correct candidate', () => {
    const stored = hashCredential(SECRET, '123456');
    expect(credentialMatches(SECRET, '123456', stored)).toBe(true);
    expect(credentialMatches(SECRET, '123457', stored)).toBe(false);
  });

  it('generates distinct high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(50);
  });

  it('generates fixed-length numeric OTP codes', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it('normalizes destinations so casing or formatting cannot dodge lookups', () => {
    expect(normalizeDestination('  Veteran@Example.Invalid ')).toBe('veteran@example.invalid');
    expect(normalizeDestination('+1 (555) 555-0101')).toBe('+15555550101');
  });
});

describe('AUTH.md §9 — an unavailable channel is not faked', () => {
  it('reports both channels when both modes are configured', () => {
    const config = loadConfig(validEnv({ SUAS_EMAIL_MODE: 'fake', SUAS_SMS_MODE: 'sink' }));
    expect(availableChannels(config).sort()).toEqual(['EMAIL', 'SMS']);
  });

  it('drops a channel whose mode is disabled', () => {
    const config = loadConfig(validEnv({ SUAS_EMAIL_MODE: 'disabled', SUAS_SMS_MODE: 'fake' }));
    expect(availableChannels(config)).toEqual(['SMS']);
  });

  it('refuses delivery on a disabled channel rather than reporting success', async () => {
    const config = loadConfig(validEnv({ SUAS_EMAIL_MODE: 'disabled', SUAS_SMS_MODE: 'fake' }));
    const delivery = createChallengeDelivery(config);

    await expect(
      delivery.deliver({
        channel: 'EMAIL',
        destination: 'veteran@example.invalid',
        method: 'EMAIL_OTP',
        secret: '123456',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(ChannelUnavailableError);
  });

  it('maps methods to the channel that carries them', () => {
    expect(channelForMethod('MAGIC_LINK')).toBe('EMAIL');
    expect(channelForMethod('EMAIL_OTP')).toBe('EMAIL');
    expect(channelForMethod('PHONE_OTP')).toBe('SMS');
  });

  it('produces no external effect in fake mode, only a recorded delivery', async () => {
    const config = loadConfig(validEnv({ SUAS_EMAIL_MODE: 'fake' }));
    const delivery = createChallengeDelivery(config);
    await delivery.deliver({
      channel: 'EMAIL',
      destination: 'veteran@example.invalid',
      method: 'EMAIL_OTP',
      secret: '123456',
      expiresAt: new Date(),
    });
    expect(delivery.implementation).toBe('recording-fake');
  });
});

describe('AUTH.md §4 — MFA factor boundary', () => {
  it.each(['LOCAL', 'TEST', 'STAGING'])('provides the test factor in %s', (environment) => {
    const port = createMfaPort(loadConfig(validEnv({ SUAS_ENV: environment })));
    expect(port.factorType).toBe('TEST_FACTOR');
  });

  it('refuses to supply a factor in PRODUCTION, where a test factor must not elevate', () => {
    const config = { ...loadConfig(validEnv()), environment: 'PRODUCTION' as const };
    expect(() => createMfaPort(config)).toThrow(MfaUnavailableError);
  });

  it('consumes a factor challenge once', async () => {
    const factor = new TestMfaFactor();
    const challenge = await factor.begin('user-1');
    const response = factor.expectedResponse(challenge.challengeId);

    expect(await factor.verify(challenge.challengeId, response)).toBe(true);
    expect(await factor.verify(challenge.challengeId, response)).toBe(false);
  });

  it('rejects a wrong factor response', async () => {
    const factor = new TestMfaFactor();
    const challenge = await factor.begin('user-1');
    expect(await factor.verify(challenge.challengeId, 'wrong')).toBe(false);
  });
});
