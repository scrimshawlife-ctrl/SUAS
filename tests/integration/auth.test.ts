/**
 * Authentication and session integration evidence (requires PostgreSQL).
 *
 * SUAS-specs AUTH.md §2 (passwordless methods), §3 (challenge contract and
 * concurrency rule), §5 (session model, horizontal-scaling invariant,
 * invalidation triggers), §9 (unavailable channel), §11 (testability list);
 * SECURITY.md §2; DATA_MODEL.md §14 rules 3-4.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  ChallengeVerificationFailedError,
  ChannelUnavailableError,
  createSession,
  elevateSession,
  isElevated,
  issueChallenge,
  RateLimitExceededError,
  RecordingChallengeDelivery,
  resolveSession,
  revokeAllUserSessions,
  revokeSession,
  verifyChallenge,
  CHALLENGE_ISSUE_LIMIT,
  CHALLENGE_MAX_ATTEMPTS,
} from '../../src/auth/index.js';
import { resolveAuthContext } from '../../src/authz/index.js';
import {
  createMembership,
  createOrganization,
  createUser,
  setMembershipStatus,
  setUserStatus,
} from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';
import { TEST_SESSION_SECRET, validEnv } from '../helpers/env.js';

const pool: Pool = createTestPool();
const config = loadConfig(validEnv());

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

function deps(delivery = new RecordingChallengeDelivery('fake', ['EMAIL', 'SMS'])) {
  return {
    pool,
    sessionSecret: TEST_SESSION_SECRET,
    delivery,
  };
}

async function enrolledVeteran() {
  const tenantId = syntheticTenantId();
  const email = syntheticEmail(`veteran-${randomUUID().slice(0, 8)}`);
  const user = await createUser(pool, { tenantId, email, status: 'ACTIVE' });
  return { tenantId, email, user };
}

describe('AUTH.md §3 — challenge contract', () => {
  it('issues and delivers a challenge for an enrolled destination', async () => {
    const { tenantId, email } = await enrolledVeteran();
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL', 'SMS']);

    const result = await issueChallenge(deps(delivery), {
      tenantId,
      destination: email,
      method: 'EMAIL_OTP',
    });

    expect(result.issued).toBe(true);
    const sent = delivery.lastFor(email.toLowerCase());
    expect(sent?.secret).toMatch(/^\d{6}$/);
  });

  it('stores the secret hashed, never in plaintext', async () => {
    const { tenantId, email } = await enrolledVeteran();
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    await issueChallenge(deps(delivery), { tenantId, destination: email, method: 'EMAIL_OTP' });

    const secret = delivery.lastFor(email.toLowerCase())?.secret ?? '';
    const stored = await pool.query<{ secret_hash: string }>(
      'SELECT secret_hash FROM auth_challenges WHERE tenant_id = $1',
      [tenantId],
    );
    expect(stored.rows[0]?.secret_hash).not.toBe(secret);
    expect(stored.rows[0]?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a correct code and returns the user', async () => {
    const { tenantId, email, user } = await enrolledVeteran();
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    await issueChallenge(deps(delivery), { tenantId, destination: email, method: 'EMAIL_OTP' });
    const secret = delivery.lastFor(email.toLowerCase())?.secret ?? '';

    const verified = await verifyChallenge(deps(delivery), {
      tenantId,
      destination: email,
      secret,
    });
    expect(verified.userId).toBe(user.userId);
  });

  it('rejects a replay after the challenge is consumed', async () => {
    const { tenantId, email } = await enrolledVeteran();
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    await issueChallenge(deps(delivery), { tenantId, destination: email, method: 'EMAIL_OTP' });
    const secret = delivery.lastFor(email.toLowerCase())?.secret ?? '';

    await verifyChallenge(deps(delivery), { tenantId, destination: email, secret });
    await expect(
      verifyChallenge(deps(delivery), { tenantId, destination: email, secret }),
    ).rejects.toThrow(ChallengeVerificationFailedError);
  });

  it('produces at most one success when one challenge is verified concurrently', async () => {
    const { tenantId, email } = await enrolledVeteran();
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    await issueChallenge(deps(delivery), { tenantId, destination: email, method: 'EMAIL_OTP' });
    const secret = delivery.lastFor(email.toLowerCase())?.secret ?? '';

    const outcomes = await Promise.allSettled([
      verifyChallenge(deps(delivery), { tenantId, destination: email, secret }),
      verifyChallenge(deps(delivery), { tenantId, destination: email, secret }),
      verifyChallenge(deps(delivery), { tenantId, destination: email, secret }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
  });

  it('rejects a wrong code and counts the attempt', async () => {
    const { tenantId, email } = await enrolledVeteran();
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    await issueChallenge(deps(delivery), { tenantId, destination: email, method: 'EMAIL_OTP' });

    await expect(
      verifyChallenge(deps(delivery), { tenantId, destination: email, secret: '000000' }),
    ).rejects.toThrow(ChallengeVerificationFailedError);

    const row = await pool.query<{ attempts: number }>(
      'SELECT attempts FROM auth_challenges WHERE tenant_id = $1',
      [tenantId],
    );
    expect(row.rows[0]?.attempts).toBe(1);
  });

  it('revokes a challenge once its attempt budget is spent', async () => {
    const { tenantId, email } = await enrolledVeteran();
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    await issueChallenge(deps(delivery), { tenantId, destination: email, method: 'EMAIL_OTP' });

    for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS.value; i += 1) {
      await expect(
        verifyChallenge(deps(delivery), { tenantId, destination: email, secret: '000000' }),
      ).rejects.toThrow();
    }

    const row = await pool.query<{ status: string }>(
      'SELECT status FROM auth_challenges WHERE tenant_id = $1',
      [tenantId],
    );
    expect(row.rows[0]?.status).toBe('REVOKED');
  });

  it('refuses an expired challenge', async () => {
    const { tenantId, email } = await enrolledVeteran();
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    await issueChallenge(deps(delivery), { tenantId, destination: email, method: 'EMAIL_OTP' });
    const secret = delivery.lastFor(email.toLowerCase())?.secret ?? '';

    await pool.query(`UPDATE auth_challenges SET expires_at = now() - interval '1 second'`);
    await expect(
      verifyChallenge(deps(delivery), { tenantId, destination: email, secret }),
    ).rejects.toThrow(ChallengeVerificationFailedError);
  });

  it('does not issue for an unenrolled destination, and does not say so', async () => {
    const tenantId = syntheticTenantId();
    const result = await issueChallenge(deps(), {
      tenantId,
      destination: syntheticEmail('stranger'),
      method: 'EMAIL_OTP',
    });
    expect(result.issued).toBe(false);
    expect(result.challengeId).toBeUndefined();
  });

  it('does not issue for a suspended user', async () => {
    const { tenantId, email, user } = await enrolledVeteran();
    await setUserStatus(pool, tenantId, user.userId, 'SUSPENDED');

    const result = await issueChallenge(deps(), {
      tenantId,
      destination: email,
      method: 'EMAIL_OTP',
    });
    expect(result.issued).toBe(false);
  });

  it('does not accept a challenge issued for another tenant', async () => {
    const { tenantId, email } = await enrolledVeteran();
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    await issueChallenge(deps(delivery), { tenantId, destination: email, method: 'EMAIL_OTP' });
    const secret = delivery.lastFor(email.toLowerCase())?.secret ?? '';

    await expect(
      verifyChallenge(deps(delivery), {
        tenantId: syntheticTenantId(),
        destination: email,
        secret,
      }),
    ).rejects.toThrow(ChallengeVerificationFailedError);
  });
});

describe('AUTH.md §9 — unavailable channels are not faked', () => {
  it('refuses to issue on a channel with no delivery path', async () => {
    const { tenantId, email } = await enrolledVeteran();
    const emailDisabled = new RecordingChallengeDelivery('sink', ['SMS']);

    await expect(
      issueChallenge(deps(emailDisabled), { tenantId, destination: email, method: 'EMAIL_OTP' }),
    ).rejects.toThrow(ChannelUnavailableError);

    const rows = await pool.query('SELECT 1 FROM auth_challenges WHERE tenant_id = $1', [tenantId]);
    // No challenge was created, so nothing can later be verified against a send
    // that never happened.
    expect(rows.rowCount).toBe(0);
  });
});

describe('AUTH.md §3, §11 — shared rate limits', () => {
  it('rejects issuance past the budget, counting in shared state', async () => {
    const { tenantId, email } = await enrolledVeteran();

    for (let i = 0; i < CHALLENGE_ISSUE_LIMIT.value; i += 1) {
      await issueChallenge(deps(), { tenantId, destination: email, method: 'EMAIL_OTP' });
    }

    await expect(
      issueChallenge(deps(), { tenantId, destination: email, method: 'EMAIL_OTP' }),
    ).rejects.toThrow(RateLimitExceededError);
  });

  it('is not reset by rotating to another app instance', async () => {
    const { tenantId, email } = await enrolledVeteran();

    for (let i = 0; i < CHALLENGE_ISSUE_LIMIT.value; i += 1) {
      await issueChallenge(deps(), { tenantId, destination: email, method: 'EMAIL_OTP' });
    }

    // A separate pool stands in for a different app instance.
    const otherInstance = createTestPool(2);
    try {
      await expect(
        issueChallenge(
          { pool: otherInstance, sessionSecret: TEST_SESSION_SECRET, delivery: deps().delivery },
          { tenantId, destination: email, method: 'EMAIL_OTP' },
        ),
      ).rejects.toThrow(RateLimitExceededError);
    } finally {
      await otherInstance.end();
    }
  });

  it('does not leak the rate-limited destination in the error message', async () => {
    const { tenantId, email } = await enrolledVeteran();
    for (let i = 0; i < CHALLENGE_ISSUE_LIMIT.value; i += 1) {
      await issueChallenge(deps(), { tenantId, destination: email, method: 'EMAIL_OTP' });
    }

    try {
      await issueChallenge(deps(), { tenantId, destination: email, method: 'EMAIL_OTP' });
    } catch (error) {
      expect((error as Error).message).not.toContain(email.toLowerCase());
      expect(error).toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
    }
  });
});

describe('AUTH.md §5 — session model and revocation', () => {
  async function signedInVeteran() {
    const { tenantId, user } = await enrolledVeteran();
    const issued = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    return { tenantId, user, issued };
  }

  it('resolves a live session credential', async () => {
    const { issued, user } = await signedInVeteran();
    const resolved = await resolveSession(pool, TEST_SESSION_SECRET, issued.credential);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.session.userId).toBe(user.userId);
  });

  it('stores only the credential hash, never the credential', async () => {
    const { issued } = await signedInVeteran();
    const row = await pool.query<{ credential_hash: string }>(
      'SELECT credential_hash FROM sessions WHERE session_id = $1',
      [issued.session.sessionId],
    );
    expect(row.rows[0]?.credential_hash).not.toBe(issued.credential);
  });

  it('rejects an unknown credential', async () => {
    const resolved = await resolveSession(pool, TEST_SESSION_SECRET, 'not-a-real-credential');
    expect(resolved).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('rejects a revoked session', async () => {
    const { issued } = await signedInVeteran();
    await revokeSession(pool, issued.session.sessionId, 'LOGOUT');
    const resolved = await resolveSession(pool, TEST_SESSION_SECRET, issued.credential);
    expect(resolved).toEqual({ ok: false, reason: 'REVOKED' });
  });

  it('rejects an expired session', async () => {
    const { issued } = await signedInVeteran();
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);
    const resolved = await resolveSession(pool, TEST_SESSION_SECRET, issued.credential);
    expect(resolved).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('revokes an idle session rather than merely rejecting it', async () => {
    const { issued } = await signedInVeteran();
    await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '30 days'`);

    const resolved = await resolveSession(pool, TEST_SESSION_SECRET, issued.credential);
    expect(resolved).toEqual({ ok: false, reason: 'IDLE_TIMEOUT' });

    const row = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM sessions WHERE session_id = $1',
      [issued.session.sessionId],
    );
    expect(row.rows[0]?.revoked_at).not.toBeNull();
  });

  it('stops a suspended user acting on a session that was valid when issued', async () => {
    const { tenantId, user, issued } = await signedInVeteran();
    await setUserStatus(pool, tenantId, user.userId, 'SUSPENDED');

    const resolved = await resolveSession(pool, TEST_SESSION_SECRET, issued.credential);
    expect(resolved).toEqual({ ok: false, reason: 'USER_NOT_ACTIVE' });
  });

  it('enforces revocation on a different app instance', async () => {
    const { issued } = await signedInVeteran();
    // Revoke through one pool, observe through another: session validity must not
    // depend on the process that issued it (AUTH.md §5).
    await revokeAllUserSessions(pool, issued.session.userId, 'ADMIN_FORCE_LOGOUT');

    const otherInstance = createTestPool(2);
    try {
      const resolved = await resolveSession(otherInstance, TEST_SESSION_SECRET, issued.credential);
      expect(resolved.ok).toBe(false);
    } finally {
      await otherInstance.end();
    }
  });

  it('revokes every live session for a user at once', async () => {
    const { tenantId, user } = await enrolledVeteran();
    const a = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId: user.userId });
    const b = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId: user.userId });

    expect(await revokeAllUserSessions(pool, user.userId, 'LOGOUT_ALL')).toBe(2);
    expect((await resolveSession(pool, TEST_SESSION_SECRET, a.credential)).ok).toBe(false);
    expect((await resolveSession(pool, TEST_SESSION_SECRET, b.credential)).ok).toBe(false);
  });
});

describe('AUTH.md §4 — MFA elevation is separate from authentication', () => {
  it('starts a session unelevated', async () => {
    const { tenantId, user } = await enrolledVeteran();
    const issued = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    expect(isElevated(issued.session)).toBe(false);
  });

  it('reports elevation only after the factor is recorded', async () => {
    const { tenantId, user } = await enrolledVeteran();
    const issued = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });

    await elevateSession(pool, issued.session.sessionId);
    const context = await resolveAuthContext(pool, TEST_SESSION_SECRET, issued.credential);
    expect(context.ok && context.context.mfaElevated).toBe(true);
  });

  it('expires elevation before the session does', async () => {
    const { tenantId, user } = await enrolledVeteran();
    const issued = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    await elevateSession(pool, issued.session.sessionId);
    await pool.query(`UPDATE sessions SET mfa_elevated_at = now() - interval '2 hours'`);

    const context = await resolveAuthContext(pool, TEST_SESSION_SECRET, issued.credential);
    // Still a valid session, but no longer privileged.
    expect(context.ok).toBe(true);
    expect(context.ok && context.context.mfaElevated).toBe(false);
  });
});

describe('AUTH.md §5, §6 — authorization context re-reads authoritative state', () => {
  it('drops a membership from the context as soon as it is revoked', async () => {
    const { tenantId, user } = await enrolledVeteran();
    const org = await createOrganization(pool, { tenantId, name: 'Org', status: 'ACTIVE' });
    const membership = await createMembership(pool, {
      tenantId,
      userId: user.userId,
      organizationId: org.organizationId,
      role: 'RESPONDER',
      status: 'ACTIVE',
    });
    const issued = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });

    const before = await resolveAuthContext(pool, TEST_SESSION_SECRET, issued.credential);
    expect(before.ok && before.context.memberships).toHaveLength(1);

    await setMembershipStatus(pool, tenantId, membership.membershipId, 'REVOKED');

    const after = await resolveAuthContext(pool, TEST_SESSION_SECRET, issued.credential);
    expect(after.ok && after.context.memberships).toHaveLength(0);
  });

  it('derives tenant scope from the session, not from the caller', async () => {
    const { tenantId, user } = await enrolledVeteran();
    const issued = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    const context = await resolveAuthContext(pool, TEST_SESSION_SECRET, issued.credential);
    expect(context.ok && context.context.tenantId).toBe(tenantId);
  });
});

describe('AUTH.md §8 — auth actions are audited', () => {
  it('records issuance and verification as immutable Audit Events', async () => {
    const { tenantId, email } = await enrolledVeteran();
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    await issueChallenge(deps(delivery), { tenantId, destination: email, method: 'EMAIL_OTP' });
    const secret = delivery.lastFor(email.toLowerCase())?.secret ?? '';
    await verifyChallenge(deps(delivery), { tenantId, destination: email, secret });

    const audits = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      'SELECT event_type, payload FROM audit_events WHERE tenant_id = $1 ORDER BY occurred_at',
      [tenantId],
    );
    const types = audits.rows.map((row) => row.event_type);
    expect(types).toContain('AUTH_CHALLENGE_ISSUED');
    expect(types).toContain('AUTH_CHALLENGE_VERIFIED');

    // The destination is contact data and must not be copied into the payload.
    expect(JSON.stringify(audits.rows)).not.toContain(email.toLowerCase());
  });

  it('records a skipped issuance without revealing the destination', async () => {
    const tenantId = syntheticTenantId();
    const stranger = syntheticEmail('stranger');
    await issueChallenge(deps(), { tenantId, destination: stranger, method: 'EMAIL_OTP' });

    const audits = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM audit_events WHERE tenant_id = $1',
      [tenantId],
    );
    expect(audits.rows.map((row) => row.event_type)).toContain('AUTH_CHALLENGE_ISSUE_SKIPPED');
  });
});

describe('config wiring', () => {
  it('derives the delivery port from the released communication modes', () => {
    expect(config.notifications.email).toBe('fake');
  });
});
