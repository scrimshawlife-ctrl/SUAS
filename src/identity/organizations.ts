/**
 * Organizations and memberships.
 *
 * Spec citations:
 * - SUAS-specs DOMAIN_MODEL.md §2 "Organization", "OrganizationMembership"
 * - SUAS-specs AUTH.md §6 (org actions require an active membership with the
 *   needed role; org-admin cannot become SUAS-admin by self-service mutation)
 * - SUAS-specs ADMIN.md §1, §4 (Org Admin ≠ SUAS Admin; org admin is scoped to
 *   one Organization)
 * - SUAS-specs DATA_MODEL.md §2, §14 rule 1 (tenant consistency)
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';

export const ORGANIZATION_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/** AUTH.md §6. Org-scoped roles only; global SUAS_ADMIN is deliberately absent. */
export const MEMBERSHIP_ROLES = ['RESPONDER', 'ORG_ADMIN', 'SERVICE_PROVIDER_USER'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export interface Organization {
  readonly organizationId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly status: OrganizationStatus;
}

export interface OrganizationMembership {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
}

interface OrganizationRow {
  organization_id: string;
  tenant_id: string;
  name: string;
  status: OrganizationStatus;
}

interface MembershipRow {
  membership_id: string;
  tenant_id: string;
  user_id: string;
  organization_id: string;
  role: MembershipRole;
  status: MembershipStatus;
}

const ORG_COLUMNS = 'organization_id, tenant_id, name, status';
const MEMBERSHIP_COLUMNS = 'membership_id, tenant_id, user_id, organization_id, role, status';

function toOrganization(row: OrganizationRow): Organization {
  return {
    organizationId: row.organization_id,
    tenantId: row.tenant_id,
    name: row.name,
    status: row.status,
  };
}

function toMembership(row: MembershipRow): OrganizationMembership {
  return {
    membershipId: row.membership_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    organizationId: row.organization_id,
    role: row.role,
    status: row.status,
  };
}

export async function createOrganization(
  db: Queryable,
  input: { tenantId: string; name: string; status?: OrganizationStatus },
): Promise<Organization> {
  const result = await db.query<OrganizationRow>(
    `INSERT INTO organizations (organization_id, tenant_id, name, status)
     VALUES ($1, $2, $3, $4)
     RETURNING ${ORG_COLUMNS}`,
    [randomUUID(), input.tenantId, input.name, input.status ?? 'PENDING'],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Organization insert returned no row.');
  return toOrganization(row);
}

export async function findOrganization(
  db: Queryable,
  tenantId: string,
  organizationId: string,
): Promise<Organization | undefined> {
  const result = await db.query<OrganizationRow>(
    `SELECT ${ORG_COLUMNS} FROM organizations WHERE tenant_id = $1 AND organization_id = $2`,
    [tenantId, organizationId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toOrganization(row);
}

export async function setOrganizationStatus(
  db: Queryable,
  tenantId: string,
  organizationId: string,
  status: OrganizationStatus,
): Promise<Organization | undefined> {
  const result = await db.query<OrganizationRow>(
    `UPDATE organizations SET status = $3, updated_at = now()
     WHERE tenant_id = $1 AND organization_id = $2
     RETURNING ${ORG_COLUMNS}`,
    [tenantId, organizationId, status],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toOrganization(row);
}

/**
 * Create a membership. The composite foreign keys in the schema reject a user
 * and organization from different tenants, so cross-tenant membership is not
 * merely discouraged — it cannot be written.
 */
export async function createMembership(
  db: Queryable,
  input: {
    tenantId: string;
    userId: string;
    organizationId: string;
    role: MembershipRole;
    status?: MembershipStatus;
  },
): Promise<OrganizationMembership> {
  const result = await db.query<MembershipRow>(
    `INSERT INTO organization_memberships
       (membership_id, tenant_id, user_id, organization_id, role, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${MEMBERSHIP_COLUMNS}`,
    [
      randomUUID(),
      input.tenantId,
      input.userId,
      input.organizationId,
      input.role,
      input.status ?? 'INVITED',
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Membership insert returned no row.');
  return toMembership(row);
}

export async function setMembershipStatus(
  db: Queryable,
  tenantId: string,
  membershipId: string,
  status: MembershipStatus,
): Promise<OrganizationMembership | undefined> {
  const result = await db.query<MembershipRow>(
    // The parameter is cast explicitly: it is used both as the enum column value
    // and in a text comparison, which PostgreSQL cannot type-infer on its own.
    `UPDATE organization_memberships
       SET status = $3::suas_membership_status,
           revoked_at = CASE WHEN $3::text = 'REVOKED' THEN now() ELSE revoked_at END,
           updated_at = now()
     WHERE tenant_id = $1 AND membership_id = $2
     RETURNING ${MEMBERSHIP_COLUMNS}`,
    [tenantId, membershipId, status],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toMembership(row);
}

export async function setMembershipRole(
  db: Queryable,
  tenantId: string,
  membershipId: string,
  role: MembershipRole,
): Promise<OrganizationMembership | undefined> {
  const result = await db.query<MembershipRow>(
    `UPDATE organization_memberships SET role = $3, updated_at = now()
     WHERE tenant_id = $1 AND membership_id = $2
     RETURNING ${MEMBERSHIP_COLUMNS}`,
    [tenantId, membershipId, role],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toMembership(row);
}

/**
 * Active memberships for a user, restricted to organizations that are themselves
 * active. AUTH.md §6 requires an active membership for org actions; a suspended
 * or archived organization cannot confer authority through a stale membership.
 */
export async function listActiveMemberships(
  db: Queryable,
  userId: string,
): Promise<OrganizationMembership[]> {
  const result = await db.query<MembershipRow>(
    `SELECT m.membership_id, m.tenant_id, m.user_id, m.organization_id, m.role, m.status
     FROM organization_memberships m
     JOIN organizations o ON o.organization_id = m.organization_id
     WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND o.status = 'ACTIVE'
     ORDER BY m.created_at`,
    [userId],
  );
  return result.rows.map(toMembership);
}
