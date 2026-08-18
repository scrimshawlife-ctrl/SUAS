/**
 * Identity and tenancy integration evidence (requires PostgreSQL).
 *
 * SUAS-specs DOMAIN_MODEL.md §2; DATA_MODEL.md §2, §14 rule 1;
 * AUTH.md §6; ADMIN.md §1-§2; SECURITY.md §2 (tenant isolation, soft-delete).
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMembership,
  createOrganization,
  createUser,
  findUserByDestination,
  findUserById,
  grantSuasAdmin,
  isSuasAdmin,
  listActiveMemberships,
  NoEnrolledChannelError,
  revokeSuasAdmin,
  setMembershipStatus,
  setOrganizationStatus,
  setUserStatus,
  softDeleteUser,
} from '../../src/identity/index.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';
import { syntheticEmail, syntheticPhone } from '../../src/testing/fixture-boundary.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function activeUser(tenantId: string, local = 'veteran') {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`${local}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

describe('DOMAIN_MODEL.md §2 — users', () => {
  it('creates a user with an enrolled channel', async () => {
    const tenantId = syntheticTenantId();
    const user = await createUser(pool, {
      tenantId,
      email: syntheticEmail('veteran-01'),
      phone: syntheticPhone(1),
    });
    expect(user.status).toBe('INVITED');
    expect(user.tenantId).toBe(tenantId);
  });

  it('refuses a user with no enrolled channel', async () => {
    await expect(createUser(pool, { tenantId: syntheticTenantId() })).rejects.toThrow(
      NoEnrolledChannelError,
    );
  });

  it('treats contact identifiers as unique within a tenant', async () => {
    const tenantId = syntheticTenantId();
    const email = syntheticEmail('shared');
    await createUser(pool, { tenantId, email });
    await expect(createUser(pool, { tenantId, email })).rejects.toThrow();
  });

  it('allows the same address in a different tenant', async () => {
    const email = syntheticEmail('same-person');
    await createUser(pool, { tenantId: syntheticTenantId(), email });
    const other = await createUser(pool, { tenantId: syntheticTenantId(), email });
    expect(other.email).toBe(email.toLowerCase());
  });

  it('does not match a lookup across tenants', async () => {
    const email = syntheticEmail('scoped');
    const tenantA = syntheticTenantId();
    await createUser(pool, { tenantId: tenantA, email });

    expect(await findUserByDestination(pool, tenantA, email)).toBeDefined();
    expect(await findUserByDestination(pool, syntheticTenantId(), email)).toBeUndefined();
  });

  it('matches a destination regardless of casing', async () => {
    const tenantId = syntheticTenantId();
    await createUser(pool, { tenantId, email: syntheticEmail('CaseTest') });
    expect(await findUserByDestination(pool, tenantId, 'CASETEST@EXAMPLE.INVALID')).toBeDefined();
  });

  it('soft-deletes rather than removing the row, so historical actor ids resolve', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);

    expect(await softDeleteUser(pool, tenantId, user.userId)).toBe(true);
    expect(await findUserById(pool, tenantId, user.userId)).toBeUndefined();

    const raw = await pool.query('SELECT status, deleted_at FROM users WHERE user_id = $1', [
      user.userId,
    ]);
    expect(raw.rows[0]).toMatchObject({ status: 'REVOKED' });
    expect(raw.rows[0]?.deleted_at).not.toBeNull();
  });

  it('moves through the released lifecycle', async () => {
    const tenantId = syntheticTenantId();
    const user = await createUser(pool, { tenantId, email: syntheticEmail('lifecycle') });
    expect((await setUserStatus(pool, tenantId, user.userId, 'ACTIVE'))?.status).toBe('ACTIVE');
    expect((await setUserStatus(pool, tenantId, user.userId, 'SUSPENDED'))?.status).toBe(
      'SUSPENDED',
    );
    expect((await setUserStatus(pool, tenantId, user.userId, 'REVOKED'))?.status).toBe('REVOKED');
  });

  it('will not change a user in another tenant', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    expect(await setUserStatus(pool, syntheticTenantId(), user.userId, 'REVOKED')).toBeUndefined();
  });
});

describe('DATA_MODEL.md §14 rule 1 — tenant consistency is enforced by the database', () => {
  it('refuses a membership linking a user and an organization from different tenants', async () => {
    const tenantA = syntheticTenantId();
    const tenantB = syntheticTenantId();
    const user = await activeUser(tenantA);
    const org = await createOrganization(pool, { tenantId: tenantB, name: 'Other Tenant Org' });

    await expect(
      createMembership(pool, {
        tenantId: tenantA,
        userId: user.userId,
        organizationId: org.organizationId,
        role: 'RESPONDER',
      }),
    ).rejects.toThrow();
  });

  it('accepts a membership inside one tenant', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    const org = await createOrganization(pool, { tenantId, name: 'In Tenant Org' });

    const membership = await createMembership(pool, {
      tenantId,
      userId: user.userId,
      organizationId: org.organizationId,
      role: 'RESPONDER',
      status: 'ACTIVE',
    });
    expect(membership.role).toBe('RESPONDER');
  });
});

describe('AUTH.md §6 — active membership confers authority', () => {
  async function activeMembership(role: 'RESPONDER' | 'ORG_ADMIN' = 'RESPONDER') {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    const org = await createOrganization(pool, {
      tenantId,
      name: 'Active Org',
      status: 'ACTIVE',
    });
    const membership = await createMembership(pool, {
      tenantId,
      userId: user.userId,
      organizationId: org.organizationId,
      role,
      status: 'ACTIVE',
    });
    return { tenantId, user, org, membership };
  }

  it('lists an active membership in an active organization', async () => {
    const { user } = await activeMembership();
    expect(await listActiveMemberships(pool, user.userId)).toHaveLength(1);
  });

  it('drops a revoked membership immediately', async () => {
    const { tenantId, user, membership } = await activeMembership();
    await setMembershipStatus(pool, tenantId, membership.membershipId, 'REVOKED');
    expect(await listActiveMemberships(pool, user.userId)).toEqual([]);
  });

  it('drops authority when the organization itself is suspended', async () => {
    const { tenantId, user, org } = await activeMembership();
    await setOrganizationStatus(pool, tenantId, org.organizationId, 'SUSPENDED');
    expect(await listActiveMemberships(pool, user.userId)).toEqual([]);
  });

  it('does not treat an invited membership as active', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    const org = await createOrganization(pool, { tenantId, name: 'Org', status: 'ACTIVE' });
    await createMembership(pool, {
      tenantId,
      userId: user.userId,
      organizationId: org.organizationId,
      role: 'RESPONDER',
    });
    expect(await listActiveMemberships(pool, user.userId)).toEqual([]);
  });

  it('keeps one membership per user per organization', async () => {
    const { tenantId, user, org } = await activeMembership();
    await expect(
      createMembership(pool, {
        tenantId,
        userId: user.userId,
        organizationId: org.organizationId,
        role: 'ORG_ADMIN',
      }),
    ).rejects.toThrow();
  });
});

describe('AUTH.md §6, ADMIN.md §1 — the global SUAS-admin role', () => {
  it('grants and revokes explicitly, with the granting actor recorded', async () => {
    const tenantId = syntheticTenantId();
    const admin = await activeUser(tenantId, 'admin');
    const grantee = await activeUser(tenantId, 'grantee');

    const grant = await grantSuasAdmin(pool, grantee.userId, admin.userId);
    expect(grant.grantedBy).toBe(admin.userId);
    expect(await isSuasAdmin(pool, grantee.userId)).toBe(true);

    expect(await revokeSuasAdmin(pool, grantee.userId, admin.userId)).toBe(true);
    expect(await isSuasAdmin(pool, grantee.userId)).toBe(false);
  });

  it('allows at most one active grant per user', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    await grantSuasAdmin(pool, user.userId, undefined);
    await expect(grantSuasAdmin(pool, user.userId, undefined)).rejects.toThrow();
  });

  it('stops conferring the role when the user is no longer active', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    await grantSuasAdmin(pool, user.userId, undefined);

    await setUserStatus(pool, tenantId, user.userId, 'SUSPENDED');
    expect(await isSuasAdmin(pool, user.userId)).toBe(false);
  });

  it('is not conferred by any organization role', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    const org = await createOrganization(pool, { tenantId, name: 'Org', status: 'ACTIVE' });
    await createMembership(pool, {
      tenantId,
      userId: user.userId,
      organizationId: org.organizationId,
      role: 'ORG_ADMIN',
      status: 'ACTIVE',
    });
    expect(await isSuasAdmin(pool, user.userId)).toBe(false);
  });
});
