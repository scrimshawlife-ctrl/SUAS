/**
 * Authorization policy evidence.
 *
 * SUAS-specs AUTH.md §1 (authentication is not authorization), §6 (role/tenant
 * inputs; org-admin cannot self-elevate); SECURITY.md §2, §5 (deny by default,
 * cross-tenant leakage, responder overreach); API.md §4 (no existence leakage).
 */

import { describe, expect, it } from 'vitest';
import { MfaRequiredError } from '../../src/auth/index.js';
import {
  assertMfaElevated,
  assertOrganizationRole,
  assertSuasAdmin,
  assertTenant,
  authorize,
  ConsentEvaluationUnavailableError,
  ForbiddenError,
  requireConsentBasis,
  ResourceNotVisibleError,
  rolesInOrganization,
  type AuthContext,
} from '../../src/authz/index.js';
import type { MembershipRole } from '../../src/identity/index.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ORG_A = '33333333-3333-4333-8333-333333333333';
const ORG_B = '44444444-4444-4444-8444-444444444444';

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    session: {
      sessionId: 'session-1',
      tenantId: TENANT_A,
      userId: 'user-1',
      organizationId: undefined,
      mfaElevatedAt: undefined,
      issuedAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: undefined,
    },
    tenantId: TENANT_A,
    userId: 'user-1',
    memberships: [],
    isSuasAdmin: false,
    mfaElevated: false,
    ...overrides,
  };
}

function membership(organizationId: string, role: MembershipRole) {
  return {
    membershipId: `m-${role}`,
    tenantId: TENANT_A,
    userId: 'user-1',
    organizationId,
    role,
    status: 'ACTIVE' as const,
  };
}

describe('SECURITY.md §2 — tenant isolation', () => {
  it('allows access within the actor tenant', () => {
    expect(() => assertTenant(context(), TENANT_A)).not.toThrow();
  });

  it('denies cross-tenant access as a not-found, so existence does not leak', () => {
    expect(() => assertTenant(context(), TENANT_B)).toThrow(ResourceNotVisibleError);
    try {
      assertTenant(context(), TENANT_B);
    } catch (error) {
      expect(error).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
      expect((error as Error).message).not.toContain(TENANT_B);
    }
  });
});

describe('AUTH.md §6 — role inputs', () => {
  it('grants an action to a held role', () => {
    const ctx = context({ memberships: [membership(ORG_A, 'RESPONDER')] });
    expect(() => assertOrganizationRole(ctx, ORG_A, ['RESPONDER'])).not.toThrow();
  });

  it('denies a role held in a different organization', () => {
    const ctx = context({ memberships: [membership(ORG_B, 'ORG_ADMIN')] });
    expect(() => assertOrganizationRole(ctx, ORG_A, ['ORG_ADMIN'])).toThrow(ForbiddenError);
  });

  it('denies a role the actor does not hold', () => {
    const ctx = context({ memberships: [membership(ORG_A, 'RESPONDER')] });
    expect(() => assertOrganizationRole(ctx, ORG_A, ['ORG_ADMIN'])).toThrow(ForbiddenError);
  });

  it('reports only the roles held in the named organization', () => {
    const ctx = context({
      memberships: [membership(ORG_A, 'RESPONDER'), membership(ORG_B, 'ORG_ADMIN')],
    });
    expect(rolesInOrganization(ctx, ORG_A)).toEqual(['RESPONDER']);
  });
});

describe('ADMIN.md §1 — Org Admin is not SUAS Admin', () => {
  it('denies the global role to an org admin', () => {
    const ctx = context({ memberships: [membership(ORG_A, 'ORG_ADMIN')] });
    expect(() => assertSuasAdmin(ctx)).toThrow(ForbiddenError);
  });

  it('does not let the global role stand in for an org role', () => {
    // ADMIN.md §2 reserves cross-org action for audited break-glass paths, not
    // routine responder ownership.
    const ctx = context({ isSuasAdmin: true });
    expect(() => assertOrganizationRole(ctx, ORG_A, ['RESPONDER'])).toThrow(ForbiddenError);
  });

  it('grants the global role to a holder of the grant', () => {
    expect(() => assertSuasAdmin(context({ isSuasAdmin: true }))).not.toThrow();
  });
});

describe('AUTH.md §4 — MFA elevation boundary', () => {
  it('denies a privileged action on an unelevated session', () => {
    expect(() => assertMfaElevated(context({ isSuasAdmin: true }), 'Publishing')).toThrow(
      MfaRequiredError,
    );
  });

  it('allows it once elevated', () => {
    expect(() =>
      assertMfaElevated(context({ isSuasAdmin: true, mfaElevated: true }), 'Publishing'),
    ).not.toThrow();
  });
});

describe('SECURITY.md §5 — deny by default', () => {
  it('refuses a requirement that names no authority at all', () => {
    expect(() => authorize(context({ isSuasAdmin: true }), {})).toThrow(ForbiddenError);
  });

  it('refuses an organization scope with no roles listed', () => {
    const ctx = context({ memberships: [membership(ORG_A, 'ORG_ADMIN')] });
    expect(() => authorize(ctx, { organizationId: ORG_A })).toThrow(ForbiddenError);
  });

  it('checks tenant, role, and elevation together', () => {
    const ctx = context({
      memberships: [membership(ORG_A, 'ORG_ADMIN')],
      mfaElevated: true,
    });
    expect(() =>
      authorize(ctx, {
        tenantId: TENANT_A,
        organizationId: ORG_A,
        roles: ['ORG_ADMIN'],
        requireMfaElevation: true,
        action: 'Inviting a member',
      }),
    ).not.toThrow();
  });

  it('fails the tenant check before the role check, so a foreign row stays hidden', () => {
    const ctx = context({ memberships: [membership(ORG_A, 'ORG_ADMIN')] });
    expect(() =>
      authorize(ctx, { tenantId: TENANT_B, organizationId: ORG_A, roles: ['ORG_ADMIN'] }),
    ).toThrow(ResourceNotVisibleError);
  });
});

describe('AUTH.md §1 — consent is the fourth input and is not yet available', () => {
  it('refuses a disclosure decision rather than defaulting it to allow', () => {
    expect(() => requireConsentBasis('PROVIDER_DISCLOSURE')).toThrow(
      ConsentEvaluationUnavailableError,
    );
  });

  it('reports the released denial code for a missing consent basis', () => {
    try {
      requireConsentBasis('NOTIFY_TRUSTED_CONTACT');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONSENT_DENIED', httpStatus: 403 });
    }
  });
});
