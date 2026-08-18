/**
 * Authentication routes.
 *
 * Spec citations:
 * - SUAS-specs API.md §2 (`/api/v0` prefix), §3 (`/auth` resource prefix),
 *   §4 (command endpoints, server-derived authority), §6 (error bodies)
 * - SUAS-specs AUTH.md §2-§5, §8-§9
 *
 * These endpoints are the documented exception to "every non-auth request
 * requires an authenticated session" (API.md §4): issuing and verifying a
 * challenge is how a session is obtained in the first place.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/index.js';
import { appendAuditEvent } from '../../events/index.js';
import {
  createSession,
  elevateSession,
  issueChallenge,
  revokeAllUserSessions,
  revokeLiveChallenges,
  revokeSession,
  verifyChallenge,
  type ChallengeDeliveryPort,
  type MfaPort,
} from '../../auth/index.js';
import { CHALLENGE_METHODS } from '../../auth/index.js';
import { API_PREFIX } from '../../release/pins.js';
import { authenticate } from '../authenticate.js';
import { UnauthenticatedError } from '../../authz/index.js';

export interface AuthRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  readonly delivery: ChallengeDeliveryPort;
  readonly mfa: MfaPort;
}

const issueBody = z.object({
  // Pre-authentication, the server has no session to derive tenant scope from,
  // so the client supplies it. How a veteran's tenant is resolved at sign-in is
  // returned to specs in the Slice 3 conformance record.
  tenant_id: z.string().uuid(),
  destination: z.string().min(3).max(320),
  method: z.enum([CHALLENGE_METHODS[0], ...CHALLENGE_METHODS.slice(1)] as [string, ...string[]]),
});

const verifyBody = z.object({
  tenant_id: z.string().uuid(),
  destination: z.string().min(3).max(320),
  code: z.string().min(1).max(512),
});

const mfaVerifyBody = z.object({
  challenge_id: z.string().min(1).max(128),
  response: z.string().min(1).max(512),
});

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post(`${API_PREFIX}/auth/challenges`, async (request, reply) => {
    const body = issueBody.parse(request.body);

    await issueChallenge(
      {
        pool: deps.pool,
        sessionSecret: deps.sessionSecret,
        delivery: deps.delivery,
      },
      {
        tenantId: body.tenant_id,
        destination: body.destination,
        method: body.method as (typeof CHALLENGE_METHODS)[number],
        correlationId: String(request.id),
      },
    );

    // Deliberately uniform: the response does not reveal whether the destination
    // is enrolled, so this endpoint cannot enumerate veterans. An unavailable
    // channel is a different matter and does surface, as a 503.
    return reply.status(202).send({ status: 'accepted' });
  });

  app.post(`${API_PREFIX}/auth/challenges/commands/verify`, async (request, reply) => {
    const body = verifyBody.parse(request.body);

    const user = await verifyChallenge(
      {
        pool: deps.pool,
        sessionSecret: deps.sessionSecret,
        delivery: deps.delivery,
      },
      {
        tenantId: body.tenant_id,
        destination: body.destination,
        secret: body.code,
        correlationId: String(request.id),
      },
    );

    const issued = await withTransaction(deps.pool, async (tx) => {
      // Any other live challenge for this destination is spent by a successful
      // sign-in, so an intercepted earlier code cannot still be used.
      await revokeLiveChallenges(tx, user.tenantId, body.destination);
      const session = await createSession(tx, deps.sessionSecret, {
        tenantId: user.tenantId,
        userId: user.userId,
      });
      await appendAuditEvent(tx, {
        eventType: 'AUTH_LOGIN_SUCCEEDED',
        action: 'CREATE_SESSION',
        targetType: 'Session',
        targetId: session.session.sessionId,
        aggregateType: 'User',
        aggregateId: user.userId,
        tenantId: user.tenantId,
        actorType: 'SYSTEM',
        actorId: user.userId,
        payload: { outcome: 'SUCCESS' },
        correlationId: String(request.id),
      });
      return session;
    });

    return reply.status(201).send({
      session_credential: issued.credential,
      expires_at: issued.session.expiresAt.toISOString(),
      // Elevation is a separate step; a fresh session is never privileged.
      mfa_elevated: false,
    });
  });

  app.post(`${API_PREFIX}/auth/mfa/challenges`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const challenge = await deps.mfa.begin(context.userId);
    return { challenge_id: challenge.challengeId, factor_type: challenge.factorType };
  });

  app.post(`${API_PREFIX}/auth/mfa/challenges/commands/verify`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const body = mfaVerifyBody.parse(request.body);

    const verified = await deps.mfa.verify(body.challenge_id, body.response);
    if (!verified) {
      await withTransaction(deps.pool, (tx) =>
        appendAuditEvent(tx, {
          eventType: 'AUTH_MFA_FAILED',
          action: 'VERIFY_MFA',
          targetType: 'Session',
          targetId: context.session.sessionId,
          aggregateType: 'User',
          aggregateId: context.userId,
          tenantId: context.tenantId,
          actorType: 'SYSTEM',
          actorId: context.userId,
          payload: { outcome: 'FAILURE' },
          correlationId: String(request.id),
        }),
      );
      throw new UnauthenticatedError('The MFA response is not valid.');
    }

    await withTransaction(deps.pool, async (tx) => {
      await elevateSession(tx, context.session.sessionId);
      await appendAuditEvent(tx, {
        eventType: 'AUTH_PRIVILEGE_ELEVATED',
        action: 'ELEVATE_SESSION',
        targetType: 'Session',
        targetId: context.session.sessionId,
        aggregateType: 'User',
        aggregateId: context.userId,
        tenantId: context.tenantId,
        actorType: 'SYSTEM',
        actorId: context.userId,
        payload: { outcome: 'SUCCESS', factor_type: deps.mfa.factorType },
        correlationId: String(request.id),
      });
    });

    return reply.status(200).send({ mfa_elevated: true });
  });

  app.post(`${API_PREFIX}/auth/sessions/commands/logout`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const everywhere = (request.body as { everywhere?: unknown } | undefined)?.everywhere === true;

    await withTransaction(deps.pool, async (tx) => {
      if (everywhere) {
        await revokeAllUserSessions(tx, context.userId, 'LOGOUT_ALL');
      } else {
        await revokeSession(tx, context.session.sessionId, 'LOGOUT');
      }
      await appendAuditEvent(tx, {
        eventType: 'AUTH_SESSION_INVALIDATED',
        action: everywhere ? 'REVOKE_ALL_SESSIONS' : 'REVOKE_SESSION',
        targetType: 'Session',
        targetId: context.session.sessionId,
        aggregateType: 'User',
        aggregateId: context.userId,
        tenantId: context.tenantId,
        actorType: 'SYSTEM',
        actorId: context.userId,
        payload: { scope: everywhere ? 'ALL' : 'CURRENT' },
        correlationId: String(request.id),
      });
    });

    return reply.status(204).send();
  });
}
