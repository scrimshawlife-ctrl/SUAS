export {
  resolveAuthContext,
  rolesInOrganization,
  type AuthContext,
  type AuthResolution,
} from './context.js';
export {
  assertMfaElevated,
  assertOrganizationRole,
  assertSuasAdmin,
  assertTenant,
  authorize,
  ConsentEvaluationUnavailableError,
  ForbiddenError,
  requireConsentBasis,
  ResourceNotVisibleError,
  UnauthenticatedError,
  type AuthorizationRequirement,
} from './policy.js';
