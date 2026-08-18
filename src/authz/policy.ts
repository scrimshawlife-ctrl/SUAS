/**
 * Authorization policy.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §1, §6 — authorization is role + tenant + row +
 *   consent/system basis; org-admin cannot cross tenant or self-elevate to
 *   SUAS-admin.
 * - SUAS-specs SECURITY.md §2 — RBAC, tenant isolation, row-level authorization,
 *   MFA for privileged roles.
 * - SUAS-specs SECURITY.md §5 — broken access control, cross-tenant leakage, and
 *   responder overreach are named threats; deny by default.
 * - SUAS-specs API.md §4 — cross-tenant hidden resources return 404 or a scoped
 *   denial without existence leakage; missing consent returns 403 CONSENT_DENIED.
 *
 * Consent is the fourth input and does not exist yet: Slice 4 owns it. Rather
 * than defaulting it to "allow", any disclosure-class decision routed through
 * here fails closed until that slice lands.
 */

import type { MembershipRole } from '../identity/organizations.js';
import { MfaRequiredError } from '../auth/mfa.js';
import { rolesInOrganization, type AuthContext } from './context.js';

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  readonly httpStatus = 401;

  constructor(message = 'Authentication is required.') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor(message = 'You do not have access to this action.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Cross-tenant and cross-row denials surface as 404 so a caller cannot learn that
 * a resource exists in another tenant (API.md §4).
 */
export class ResourceNotVisibleError extends Error {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Resource not found.');
    this.name = 'ResourceNotVisibleError';
  }
}

/**
 * Raised when code asks for a consent-based decision before the consent kernel
 * exists. Fails closed by construction: there is no permissive branch.
 */
export class ConsentEvaluationUnavailableError extends Error {
  readonly code = 'CONSENT_DENIED';
  readonly httpStatus = 403;

  constructor(purpose: string) {
    super(
      `Consent basis for "${purpose}" cannot be evaluated: the Consent kernel is not ` +
        `implemented until SPEC017_PLAN.md Slice 4. Disclosure is refused rather than ` +
        `assumed (SUAS-specs AUTH.md §1; CONSENT.md).`,
    );
    this.name = 'ConsentEvaluationUnavailableError';
  }
}

/**
 * The consent seam. Every share, notify, or provider-disclosure path must route
 * through use-time consent evaluation; until Slice 4 provides it, calling this
 * refuses the disclosure.
 */
export function requireConsentBasis(purpose: string): never {
  throw new ConsentEvaluationUnavailableError(purpose);
}

/** Deny unless the context is scoped to the tenant that owns the row. */
export function assertTenant(context: AuthContext, tenantId: string): void {
  if (context.tenantId !== tenantId) {
    throw new ResourceNotVisibleError();
  }
}

/**
 * Deny unless the actor holds one of `roles` in the organization.
 *
 * A SUAS-admin does not implicitly satisfy an org role: ADMIN.md §2 reserves
 * cross-org action for audited break-glass paths, not routine responder
 * ownership. Callers that intend an admin path ask for it explicitly.
 */
export function assertOrganizationRole(
  context: AuthContext,
  organizationId: string,
  roles: readonly MembershipRole[],
): void {
  const held = rolesInOrganization(context, organizationId);
  if (!held.some((role) => roles.includes(role))) {
    throw new ForbiddenError(
      `This action requires one of ${roles.join(', ')} in the organization.`,
    );
  }
}

/** Deny unless the actor holds the global SUAS-admin grant. */
export function assertSuasAdmin(context: AuthContext): void {
  if (!context.isSuasAdmin) {
    throw new ForbiddenError('This action requires the SUAS System Administrator role.');
  }
}

/** Deny unless the session is MFA-elevated. AUTH.md §4; SECURITY.md §2. */
export function assertMfaElevated(context: AuthContext, action: string): void {
  if (!context.mfaElevated) {
    throw new MfaRequiredError(action);
  }
}

export interface AuthorizationRequirement {
  /** Tenant that owns the row being acted on. */
  readonly tenantId?: string;
  /** Organization scope plus the roles that satisfy it. */
  readonly organizationId?: string;
  readonly roles?: readonly MembershipRole[];
  readonly requireSuasAdmin?: boolean;
  readonly requireMfaElevation?: boolean;
  /** Human-readable action name, used in denial messages. */
  readonly action?: string;
}

/**
 * Evaluate role + tenant + row in one place. Deny by default: a requirement that
 * names no authority at all is refused rather than treated as public.
 */
export function authorize(context: AuthContext, requirement: AuthorizationRequirement): void {
  const action = requirement.action ?? 'This action';

  if (requirement.tenantId !== undefined) {
    assertTenant(context, requirement.tenantId);
  }

  if (requirement.requireSuasAdmin === true) {
    assertSuasAdmin(context);
  }

  if (requirement.organizationId !== undefined) {
    if (requirement.roles === undefined || requirement.roles.length === 0) {
      throw new ForbiddenError(`${action} names an organization scope but no roles.`);
    }
    assertOrganizationRole(context, requirement.organizationId, requirement.roles);
  }

  if (requirement.requireSuasAdmin !== true && requirement.organizationId === undefined) {
    throw new ForbiddenError(
      `${action} did not specify an authority to check; access is denied by default ` +
        `(SUAS-specs SECURITY.md §5).`,
    );
  }

  if (requirement.requireMfaElevation === true) {
    assertMfaElevated(context, action);
  }
}
