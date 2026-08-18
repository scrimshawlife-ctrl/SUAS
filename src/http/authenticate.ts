/**
 * Request authentication.
 *
 * Spec citations:
 * - SUAS-specs API.md §4 — every non-auth request requires an authenticated
 *   session unless explicitly documented otherwise; the server derives tenant and
 *   actor authority.
 * - SUAS-specs AUTH.md §5 — authoritative session/user state is re-evaluated per
 *   request, never taken from a client claim.
 * - SUAS-specs SECURITY.md §2 — no sensitive data in logs.
 */

import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { resolveAuthContext, type AuthContext } from '../authz/index.js';
import { UnauthenticatedError } from '../authz/index.js';

/** Extract the opaque session credential from the Authorization header. */
export function readCredential(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Resolve the authenticated context or throw 401.
 *
 * The rejection reason is logged but never returned: a caller learns that the
 * credential did not work, not whether it was revoked, expired, or never existed.
 */
export async function authenticate(
  pool: Pool,
  sessionSecret: string | undefined,
  request: FastifyRequest,
): Promise<AuthContext> {
  const credential = readCredential(request);
  if (credential === undefined) {
    throw new UnauthenticatedError('A session credential is required.');
  }

  const resolution = await resolveAuthContext(pool, sessionSecret, credential);
  if (!resolution.ok) {
    request.log.info({ auth_rejection: resolution.reason }, 'session rejected');
    throw new UnauthenticatedError('The session credential is not valid.');
  }
  return resolution.context;
}
