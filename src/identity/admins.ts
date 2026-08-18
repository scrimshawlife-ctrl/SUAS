/**
 * SUAS System Administrator grants.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §6 — "global `SUAS_ADMIN` is distinct"; org-admin cannot
 *   become SUAS-admin by self-service role mutation.
 * - SUAS-specs ONBOARDING.md §3 — "SUAS-admin is globally bound, not org-bound".
 * - SUAS-specs ADMIN.md §1-§2 — Org Admin ≠ SUAS Admin; SUAS-admin actions
 *   require MFA and audit.
 *
 * The released data model names no table for this global role, so it is an
 * explicit grant with an author, a revoker, and timestamps rather than a boolean
 * on the user row. That keeps "who made this person a SUAS admin, and when"
 * answerable. The representation is returned to specs in the Slice 3 record.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';

export interface SuasAdminGrant {
  readonly adminGrantId: string;
  readonly userId: string;
  readonly status: 'ACTIVE' | 'REVOKED';
  readonly grantedBy: string | undefined;
}

interface GrantRow {
  admin_grant_id: string;
  user_id: string;
  status: 'ACTIVE' | 'REVOKED';
  granted_by: string | null;
}

function toGrant(row: GrantRow): SuasAdminGrant {
  return {
    adminGrantId: row.admin_grant_id,
    userId: row.user_id,
    status: row.status,
    grantedBy: row.granted_by ?? undefined,
  };
}

/**
 * Grant the global SUAS-admin role.
 *
 * `grantedBy` is the acting administrator. Callers append the Audit Event; this
 * function does not, so the caller's request context travels with it.
 */
export async function grantSuasAdmin(
  db: Queryable,
  userId: string,
  grantedBy: string | undefined,
): Promise<SuasAdminGrant> {
  const result = await db.query<GrantRow>(
    `INSERT INTO suas_admin_grants (admin_grant_id, user_id, granted_by)
     VALUES ($1, $2, $3)
     RETURNING admin_grant_id, user_id, status, granted_by`,
    [randomUUID(), userId, grantedBy ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Admin grant insert returned no row.');
  return toGrant(row);
}

export async function revokeSuasAdmin(
  db: Queryable,
  userId: string,
  revokedBy: string | undefined,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE suas_admin_grants
       SET status = 'REVOKED', revoked_at = now(), revoked_by = $2
     WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId, revokedBy ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Whether a user currently holds the global role.
 *
 * Evaluated live rather than cached, so a revoked grant stops conferring
 * authority immediately across every instance (AUTH.md §5).
 */
export async function isSuasAdmin(db: Queryable, userId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM suas_admin_grants g
     JOIN users u ON u.user_id = g.user_id
     WHERE g.user_id = $1 AND g.status = 'ACTIVE'
       AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`,
    [userId],
  );
  return (result.rowCount ?? 0) > 0;
}
