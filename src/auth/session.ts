/**
 * Sessions.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §5 — sessions are server-revocable opaque credentials;
 *   any healthy instance must observe revocation and membership/user status
 *   changes; session validity cannot depend on the issuing process; in-flight
 *   authorization after revocation re-evaluates authoritative state.
 * - SUAS-specs AUTH.md §5 "Invalidation triggers" — logout, user
 *   SUSPENDED/REVOKED, membership revoke, MFA reset, admin force logout, idle and
 *   absolute timeout.
 * - SUAS-specs SECURITY.md §2 — revocable sessions, no long-lived unrevocable
 *   bearer credentials (AUTH.md §10).
 *
 * Resolution reads authoritative state from PostgreSQL on every call. There is no
 * process-local session cache, which is the simplest mechanism that satisfies the
 * horizontal-scaling invariant rather than merely claiming to.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import {
  MFA_ELEVATION_TTL_SECONDS,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
} from './constants.js';
import { generateOpaqueToken, hashCredential } from './secrets.js';
import type { UserStatus } from '../identity/users.js';

export interface Session {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly organizationId: string | undefined;
  readonly mfaElevatedAt: Date | undefined;
  readonly issuedAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | undefined;
}

export interface IssuedSession {
  readonly session: Session;
  /** Raw credential. Returned once and never stored; only its HMAC is persisted. */
  readonly credential: string;
}

interface SessionRow {
  session_id: string;
  tenant_id: string;
  user_id: string;
  organization_id: string | null;
  mfa_elevated_at: Date | null;
  issued_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const SESSION_COLUMNS = `
  session_id, tenant_id, user_id, organization_id, mfa_elevated_at,
  issued_at, last_seen_at, expires_at, revoked_at
`;

function toSession(row: SessionRow): Session {
  return {
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    organizationId: row.organization_id ?? undefined,
    mfaElevatedAt: row.mfa_elevated_at ?? undefined,
    issuedAt: row.issued_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}

export async function createSession(
  db: Queryable,
  sessionSecret: string | undefined,
  input: { tenantId: string; userId: string; organizationId?: string },
): Promise<IssuedSession> {
  const credential = generateOpaqueToken();
  const result = await db.query<SessionRow>(
    `INSERT INTO sessions
       (session_id, tenant_id, user_id, organization_id, credential_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
     RETURNING ${SESSION_COLUMNS}`,
    [
      randomUUID(),
      input.tenantId,
      input.userId,
      input.organizationId ?? null,
      hashCredential(sessionSecret, credential),
      SESSION_ABSOLUTE_TTL_SECONDS.value,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Session insert returned no row.');
  return { session: toSession(row), credential };
}

/** Why a credential failed to resolve. Never surfaced to the client verbatim. */
export type SessionRejection =
  'NOT_FOUND' | 'REVOKED' | 'EXPIRED' | 'IDLE_TIMEOUT' | 'USER_NOT_ACTIVE';

export type SessionResolution =
  | { readonly ok: true; readonly session: Session; readonly userStatus: UserStatus }
  | { readonly ok: false; readonly reason: SessionRejection };

/**
 * Resolve a credential to a live session.
 *
 * The user's authoritative status is read in the same query, so a suspended or
 * revoked user cannot act on a session that was valid when issued — including a
 * request already in flight on another instance (AUTH.md §5).
 */
export async function resolveSession(
  db: Queryable,
  sessionSecret: string | undefined,
  credential: string,
): Promise<SessionResolution> {
  const result = await db.query<SessionRow & { user_status: UserStatus; user_deleted: boolean }>(
    `SELECT s.session_id, s.tenant_id, s.user_id, s.organization_id, s.mfa_elevated_at,
            s.issued_at, s.last_seen_at, s.expires_at, s.revoked_at,
            u.status AS user_status,
            (u.deleted_at IS NOT NULL) AS user_deleted
     FROM sessions s
     JOIN users u ON u.user_id = s.user_id
     WHERE s.credential_hash = $1`,
    [hashCredential(sessionSecret, credential)],
  );

  const row = result.rows[0];
  if (row === undefined) return { ok: false, reason: 'NOT_FOUND' };
  if (row.revoked_at !== null) return { ok: false, reason: 'REVOKED' };
  if (row.expires_at.getTime() <= Date.now()) return { ok: false, reason: 'EXPIRED' };

  const idleMs = Date.now() - row.last_seen_at.getTime();
  if (idleMs > SESSION_IDLE_TTL_SECONDS.value * 1000) {
    // Idle sessions are revoked rather than merely rejected, so the credential
    // cannot be revived by a later request.
    await revokeSession(db, row.session_id, 'IDLE_TIMEOUT');
    return { ok: false, reason: 'IDLE_TIMEOUT' };
  }

  if (row.user_deleted || row.user_status !== 'ACTIVE') {
    return { ok: false, reason: 'USER_NOT_ACTIVE' };
  }

  await db.query(`UPDATE sessions SET last_seen_at = now() WHERE session_id = $1`, [
    row.session_id,
  ]);

  return { ok: true, session: toSession(row), userStatus: row.user_status };
}

export async function revokeSession(
  db: Queryable,
  sessionId: string,
  reason: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
     WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Revoke every live session for a user.
 * AUTH.md §5: the trigger for logout-everywhere, status change, membership
 * revoke, MFA reset, and admin force logout.
 */
export async function revokeAllUserSessions(
  db: Queryable,
  userId: string,
  reason: string,
): Promise<number> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return result.rowCount ?? 0;
}

/** Mark a session MFA-elevated. AUTH.md §4: elevation follows MFA, never precedes it. */
export async function elevateSession(db: Queryable, sessionId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE sessions SET mfa_elevated_at = now()
     WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Drop elevation without ending the session, e.g. on MFA reset. */
export async function clearElevation(db: Queryable, sessionId: string): Promise<void> {
  await db.query(`UPDATE sessions SET mfa_elevated_at = NULL WHERE session_id = $1`, [sessionId]);
}

/** Elevation expires well before the session does, so privilege is time-bounded. */
export function isElevated(session: Session, now: Date = new Date()): boolean {
  if (session.mfaElevatedAt === undefined) return false;
  const ageSeconds = (now.getTime() - session.mfaElevatedAt.getTime()) / 1000;
  return ageSeconds <= MFA_ELEVATION_TTL_SECONDS.value;
}
