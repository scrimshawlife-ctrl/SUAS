/**
 * Authentication endpoint evidence (requires PostgreSQL).
 *
 * SUAS-specs API.md §2, §4, §6; AUTH.md §2-§5, §8-§9.
 *
 * Drives the whole sign-in path through HTTP: issue a challenge, verify it,
 * receive a session, elevate it, and log out.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createUser } from '../../src/identity/index.js';
import type { RecordingChallengeDelivery, TestMfaFactor } from '../../src/auth/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { validEnv } from '../helpers/env.js';

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({ env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply' }), listen: false });
});

afterAll(async () => {
  await app.close();
});

function delivery(): RecordingChallengeDelivery {
  return app.challengeDelivery as RecordingChallengeDelivery;
}

async function enrol(): Promise<{ tenantId: string; email: string }> {
  const pool = app.pool;
  if (pool === undefined) throw new Error('The test app has no database pool.');
  const tenantId = randomUUID();
  const email = syntheticEmail(`veteran-${randomUUID().slice(0, 8)}`);
  await createUser(pool, { tenantId, email, status: 'ACTIVE' });
  return { tenantId, email };
}

async function signIn(): Promise<string> {
  const { tenantId, email } = await enrol();

  const issued = await app.server.inject({
    method: 'POST',
    url: '/api/v0/auth/challenges',
    payload: { tenant_id: tenantId, destination: email, method: 'EMAIL_OTP' },
  });
  expect(issued.statusCode).toBe(202);

  const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';
  const verified = await app.server.inject({
    method: 'POST',
    url: '/api/v0/auth/challenges/commands/verify',
    payload: { tenant_id: tenantId, destination: email, code },
  });
  expect(verified.statusCode).toBe(201);
  return verified.json().session_credential as string;
}

describe('POST /api/v0/auth/challenges', () => {
  it('accepts an issue request for an enrolled destination', async () => {
    const { tenantId, email } = await enrol();
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      payload: { tenant_id: tenantId, destination: email, method: 'EMAIL_OTP' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'accepted' });
    expect(delivery().lastFor(email.toLowerCase())).toBeDefined();
  });

  it('answers identically for an unenrolled destination, so it cannot enumerate users', async () => {
    const enrolled = await enrol();
    const stranger = syntheticEmail('nobody');

    const known = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      payload: { tenant_id: enrolled.tenantId, destination: enrolled.email, method: 'EMAIL_OTP' },
    });
    const unknown = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      payload: { tenant_id: enrolled.tenantId, destination: stranger, method: 'EMAIL_OTP' },
    });

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
    expect(delivery().lastFor(stranger.toLowerCase())).toBeUndefined();
  });

  it('rejects a malformed request with the released error shape', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      payload: { tenant_id: 'not-a-uuid', destination: 'x', method: 'CARRIER_PIGEON' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/v0/auth/challenges/commands/verify', () => {
  it('exchanges a valid code for a session credential', async () => {
    const credential = await signIn();
    expect(credential.length).toBeGreaterThan(20);
  });

  it('returns an unelevated session', async () => {
    const { tenantId, email } = await enrol();
    await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      payload: { tenant_id: tenantId, destination: email, method: 'EMAIL_OTP' },
    });
    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';
    const verified = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges/commands/verify',
      payload: { tenant_id: tenantId, destination: email, code },
    });
    expect(verified.json().mfa_elevated).toBe(false);
  });

  it('rejects a wrong code with a uniform message', async () => {
    const { tenantId, email } = await enrol();
    await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      payload: { tenant_id: tenantId, destination: email, method: 'EMAIL_OTP' },
    });

    const response = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges/commands/verify',
      payload: { tenant_id: tenantId, destination: email, code: '000000' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('CHALLENGE_INVALID');

    // A wrong code and an unknown destination must be indistinguishable, or the
    // endpoint becomes an oracle for which addresses are enrolled.
    const unknownDestination = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges/commands/verify',
      payload: {
        tenant_id: tenantId,
        destination: syntheticEmail('never-enrolled'),
        code: '000000',
      },
    });
    expect(unknownDestination.statusCode).toBe(response.statusCode);
    expect(unknownDestination.json()).toEqual(response.json());
  });

  it('spends other live challenges for the destination on success', async () => {
    const { tenantId, email } = await enrol();
    await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      payload: { tenant_id: tenantId, destination: email, method: 'EMAIL_OTP' },
    });
    const firstCode = delivery().lastFor(email.toLowerCase())?.secret ?? '';

    await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      payload: { tenant_id: tenantId, destination: email, method: 'EMAIL_OTP' },
    });
    const secondCode = delivery().lastFor(email.toLowerCase())?.secret ?? '';

    const ok = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges/commands/verify',
      payload: { tenant_id: tenantId, destination: email, code: secondCode },
    });
    expect(ok.statusCode).toBe(201);

    const stale = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges/commands/verify',
      payload: { tenant_id: tenantId, destination: email, code: firstCode },
    });
    expect(stale.statusCode).toBe(401);
  });
});

describe('MFA elevation over HTTP', () => {
  it('elevates a session after a verified factor', async () => {
    const credential = await signIn();

    const begun = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/mfa/challenges',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(begun.statusCode).toBe(200);

    const challengeId = begun.json().challenge_id as string;
    const factor = app.mfa as TestMfaFactor;

    const verified = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/mfa/challenges/commands/verify',
      headers: { authorization: `Bearer ${credential}` },
      payload: { challenge_id: challengeId, response: factor.expectedResponse(challengeId) },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json().mfa_elevated).toBe(true);
  });

  it('refuses to elevate on a wrong factor response', async () => {
    const credential = await signIn();
    const begun = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/mfa/challenges',
      headers: { authorization: `Bearer ${credential}` },
    });

    const response = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/mfa/challenges/commands/verify',
      headers: { authorization: `Bearer ${credential}` },
      payload: { challenge_id: begun.json().challenge_id as string, response: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires a session before a factor can even be started', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/mfa/challenges',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/v0/auth/sessions/commands/logout', () => {
  it('ends the session, and the credential stops working immediately', async () => {
    const credential = await signIn();

    const loggedOut = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/sessions/commands/logout',
      headers: { authorization: `Bearer ${credential}` },
      payload: {},
    });
    expect(loggedOut.statusCode).toBe(204);

    const after = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/mfa/challenges',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('API.md §4 — authenticated by default', () => {
  it('rejects a bare token that is not a real credential', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/mfa/challenges',
      headers: { authorization: 'Bearer made-up-credential' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/mfa/challenges',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(response.statusCode).toBe(401);
  });
});
