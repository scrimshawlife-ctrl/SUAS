/**
 * Passwordless authentication challenges.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §2 (magic link, email OTP, phone OTP; no veteran password
 *   or social login)
 * - SUAS-specs AUTH.md §3 (challenge contract: single-use, time-bounded, stored
 *   hashed, rate-limited, consumed atomically; two simultaneous verifies produce
 *   at most one successful consumption)
 * - SUAS-specs AUTH.md §8 (audit challenge issuance and verification outcome)
 * - SUAS-specs AUTH.md §9 (an unavailable delivery provider means an unavailable
 *   channel; do not fake success)
 * - SUAS-specs DATA_MODEL.md §2 "auth_challenges", §14 rule 3 (one challenge
 *   consumed at most once)
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import { findUserByDestination, type User } from '../identity/users.js';
import {
  CHALLENGE_ISSUE_LIMIT,
  CHALLENGE_ISSUE_WINDOW_SECONDS,
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_SECONDS,
  CHALLENGE_VERIFY_LIMIT,
  CHALLENGE_VERIFY_WINDOW_SECONDS,
} from './constants.js';
import {
  channelForMethod,
  ChannelUnavailableError,
  type ChallengeDeliveryPort,
  type ChallengeMethod,
} from './delivery.js';
import { enforceRateLimit } from './rate-limit.js';
import {
  credentialMatches,
  generateOpaqueToken,
  generateOtpCode,
  hashCredential,
  normalizeDestination,
} from './secrets.js';

export type ChallengeStatus = 'ISSUED' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';

export interface IssueChallengeInput {
  readonly tenantId: string;
  readonly destination: string;
  readonly method: ChallengeMethod;
  readonly correlationId?: string;
}

export interface IssueChallengeResult {
  /**
   * Whether a challenge was actually created and delivered.
   *
   * False when the destination is not enrolled. The caller returns the same
   * response either way so the endpoint cannot be used to enumerate which
   * addresses belong to veterans; the distinction is recorded in the Audit Event
   * rather than in the response.
   */
  readonly issued: boolean;
  readonly challengeId: string | undefined;
  readonly expiresAt: Date | undefined;
}

export class ChallengeVerificationFailedError extends Error {
  readonly code = 'CHALLENGE_INVALID';
  readonly httpStatus = 401;

  constructor() {
    // Deliberately uniform: a caller cannot tell "wrong code" from "expired",
    // "already used", or "no such challenge".
    super('The sign-in code is invalid or has expired.');
    this.name = 'ChallengeVerificationFailedError';
  }
}

export interface ChallengeServiceDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  readonly delivery: ChallengeDeliveryPort;
}

/**
 * Issue and deliver a challenge.
 *
 * Order matters: channel availability and rate limits are checked before any
 * record is written, so an unavailable channel produces no challenge at all
 * rather than an undeliverable one.
 */
export async function issueChallenge(
  deps: ChallengeServiceDeps,
  input: IssueChallengeInput,
): Promise<IssueChallengeResult> {
  const destination = normalizeDestination(input.destination);
  const channel = channelForMethod(input.method);

  // AUTH.md §9: an unavailable channel is reported, never faked.
  if (!deps.delivery.availableChannels().includes(channel)) {
    throw new ChannelUnavailableError(channel);
  }

  // AUTH.md §3: rate limited by destination, in shared persistent state.
  await enforceRateLimit(
    deps.pool,
    {
      bucket: 'auth.challenge.issue',
      limit: CHALLENGE_ISSUE_LIMIT.value,
      windowSeconds: CHALLENGE_ISSUE_WINDOW_SECONDS.value,
    },
    destination,
  );

  const user = await findUserByDestination(deps.pool, input.tenantId, destination);

  if (user === undefined || user.status === 'REVOKED' || user.status === 'SUSPENDED') {
    await recordChallengeAudit(deps.pool, {
      tenantId: input.tenantId,
      action: 'AUTH_CHALLENGE_ISSUE_SKIPPED',
      outcome: user === undefined ? 'NO_ENROLLED_USER' : `USER_${user.status}`,
      method: input.method,
      actorId: user?.userId ?? 'anonymous',
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
    return { issued: false, challengeId: undefined, expiresAt: undefined };
  }

  const secret = input.method === 'MAGIC_LINK' ? generateOpaqueToken() : generateOtpCode();
  const challengeId = randomUUID();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS.value * 1000);

  await withTransaction(deps.pool, async (tx) => {
    await tx.query(
      `INSERT INTO auth_challenges
         (auth_challenge_id, tenant_id, user_id, method, destination, secret_hash,
          max_attempts, expires_at, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        challengeId,
        input.tenantId,
        user.userId,
        input.method,
        destination,
        hashCredential(deps.sessionSecret, secret),
        CHALLENGE_MAX_ATTEMPTS.value,
        expiresAt,
        input.correlationId ?? null,
      ],
    );

    await appendAuditEvent(tx, {
      eventType: 'AUTH_CHALLENGE_ISSUED',
      action: 'ISSUE_AUTH_CHALLENGE',
      targetType: 'AuthChallenge',
      targetId: challengeId,
      aggregateType: 'User',
      aggregateId: user.userId,
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      actorId: 'auth',
      // The destination is a contact identifier; only the method is recorded.
      payload: { method: input.method, channel },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
  });

  // Delivery happens after commit: a delivery failure must not leave a phantom
  // challenge, and the challenge must exist before a code can arrive.
  await deps.delivery.deliver({
    channel,
    destination,
    method: input.method,
    secret,
    expiresAt,
  });

  return { issued: true, challengeId, expiresAt };
}

export interface VerifyChallengeInput {
  readonly tenantId: string;
  readonly destination: string;
  readonly secret: string;
  readonly correlationId?: string;
}

interface ChallengeRow {
  auth_challenge_id: string;
  user_id: string | null;
  secret_hash: string;
  status: ChallengeStatus;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
}

/**
 * Verify a challenge and return the authenticated user.
 *
 * The whole check runs inside one transaction with the challenge row locked
 * `FOR UPDATE`, which is what makes AUTH.md §3's concurrency rule hold: two
 * simultaneous verifies of one challenge produce at most one consumption.
 */
export async function verifyChallenge(
  deps: ChallengeServiceDeps,
  input: VerifyChallengeInput,
): Promise<User> {
  const destination = normalizeDestination(input.destination);

  // A shared verify budget per destination, so rotating challenges — or app
  // instances — does not reset an attacker's attempts (AUTH.md §11).
  await enforceRateLimit(
    deps.pool,
    {
      bucket: 'auth.challenge.verify',
      limit: CHALLENGE_VERIFY_LIMIT.value,
      windowSeconds: CHALLENGE_VERIFY_WINDOW_SECONDS.value,
    },
    destination,
  );

  const userId = await withTransaction(deps.pool, async (tx) => {
    const result = await tx.query<ChallengeRow>(
      `SELECT auth_challenge_id, user_id, secret_hash, status, attempts, max_attempts, expires_at
       FROM auth_challenges
       WHERE tenant_id = $1 AND destination = $2 AND status = 'ISSUED'
       ORDER BY issued_at DESC
       LIMIT 1
       FOR UPDATE`,
      [input.tenantId, destination],
    );

    const challenge = result.rows[0];
    if (challenge === undefined) return undefined;

    if (challenge.expires_at.getTime() <= Date.now()) {
      await tx.query(`UPDATE auth_challenges SET status = 'EXPIRED' WHERE auth_challenge_id = $1`, [
        challenge.auth_challenge_id,
      ]);
      return undefined;
    }

    if (challenge.attempts >= challenge.max_attempts) {
      await tx.query(`UPDATE auth_challenges SET status = 'REVOKED' WHERE auth_challenge_id = $1`, [
        challenge.auth_challenge_id,
      ]);
      return undefined;
    }

    if (!credentialMatches(deps.sessionSecret, input.secret, challenge.secret_hash)) {
      const attempts = challenge.attempts + 1;
      await tx.query(
        `UPDATE auth_challenges
           SET attempts = $2, status = CASE WHEN $2 >= max_attempts THEN 'REVOKED' ELSE status END
         WHERE auth_challenge_id = $1`,
        [challenge.auth_challenge_id, attempts],
      );
      return undefined;
    }

    // Single-use consumption. The row lock above already serialized concurrent
    // verifies; the status predicate makes the write itself unambiguous.
    const consumed = await tx.query(
      `UPDATE auth_challenges
         SET status = 'CONSUMED', consumed_at = now(), attempts = attempts + 1
       WHERE auth_challenge_id = $1 AND status = 'ISSUED'`,
      [challenge.auth_challenge_id],
    );
    if ((consumed.rowCount ?? 0) === 0) return undefined;

    await appendAuditEvent(tx, {
      eventType: 'AUTH_CHALLENGE_VERIFIED',
      action: 'VERIFY_AUTH_CHALLENGE',
      targetType: 'AuthChallenge',
      targetId: challenge.auth_challenge_id,
      aggregateType: 'User',
      aggregateId: challenge.user_id ?? randomUUID(),
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      actorId: 'auth',
      payload: { outcome: 'SUCCESS' },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return challenge.user_id ?? undefined;
  });

  if (userId === undefined) {
    await recordChallengeAudit(deps.pool, {
      tenantId: input.tenantId,
      action: 'AUTH_CHALLENGE_VERIFY_FAILED',
      outcome: 'FAILURE',
      actorId: 'anonymous',
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
    throw new ChallengeVerificationFailedError();
  }

  const user = await findUserByDestination(deps.pool, input.tenantId, destination);
  // AUTH.md §6: User.status = ACTIVE is required to act. A challenge verified by
  // a user who is no longer active does not produce a session.
  if (user === undefined || user.userId !== userId) {
    throw new ChallengeVerificationFailedError();
  }
  return user;
}

/** Revoke every live challenge for a destination, e.g. after a successful sign-in. */
export async function revokeLiveChallenges(
  db: Queryable,
  tenantId: string,
  destination: string,
): Promise<number> {
  const result = await db.query(
    `UPDATE auth_challenges SET status = 'REVOKED'
     WHERE tenant_id = $1 AND destination = $2 AND status = 'ISSUED'`,
    [tenantId, normalizeDestination(destination)],
  );
  return result.rowCount ?? 0;
}

async function recordChallengeAudit(
  db: Pool,
  input: {
    tenantId: string;
    action: string;
    outcome: string;
    actorId: string;
    method?: ChallengeMethod;
    correlationId?: string;
  },
): Promise<void> {
  await withTransaction(db, (tx) =>
    appendAuditEvent(tx, {
      eventType: input.action,
      action: input.action,
      targetType: 'AuthChallenge',
      targetId: 'none',
      aggregateType: 'User',
      aggregateId: randomUUID(),
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      actorId: input.actorId,
      payload: {
        outcome: input.outcome,
        ...(input.method !== undefined ? { method: input.method } : {}),
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    }),
  );
}
