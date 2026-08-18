/**
 * Consent vocabulary.
 *
 * Spec citations:
 * - SUAS-specs CONSENT.md §1 (consent is a first-class object, not a boolean),
 *   §2 (grant shape), §2.1 (required MVP grants and the non-implication rule),
 *   §3.5-§3.6 (system basis), §7 (states), §9 (non-goals)
 * - SUAS-specs TRUSTED_CIRCLE.md §5 (permissions live on grants)
 *
 * The permission and the scope are separate values with no ordering and no
 * implication between them. CONSENT.md §2.1 is explicit: a grant for YELLOW does
 * not imply ORANGE or RED, and a grant for support_signal does not imply
 * checkin_answers. There is deliberately no widening or hierarchy helper in this
 * module for anything to accidentally call.
 */

/** CONSENT.md §2 `permission`. */
export const CONSENT_PERMISSIONS = ['can_receive', 'can_view', 'can_share'] as const;
export type ConsentPermission = (typeof CONSENT_PERMISSIONS)[number];

/** CONSENT.md §2 `scope`. */
export const CONSENT_SCOPES = [
  'YELLOW',
  'ORANGE',
  'RED',
  'support_signal',
  'checkin_answers',
  'current_requests',
  'location',
  'service_request_fulfillment',
] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

/** CONSENT.md §1 actors that may hold a grant. */
export const GRANTEE_TYPES = [
  'TRUSTED_CONTACT',
  'RESPONDER',
  'ORGANIZATION',
  'SERVICE_PROVIDER',
  'SYSTEM',
] as const;
export type GranteeType = (typeof GRANTEE_TYPES)[number];

export const CONSENT_GRANT_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export type ConsentGrantStatus = (typeof CONSENT_GRANT_STATUSES)[number];

export const CONSENT_EVENT_TYPES = [
  'GRANTED',
  'REVOKED',
  'EXPIRED',
  'DENIED',
  'TEMPLATE_ACCEPTED',
] as const;
export type ConsentEventType = (typeof CONSENT_EVENT_TYPES)[number];

/**
 * Scope/permission pairings that the released examples describe.
 *
 * CONSENT.md §2.1 lists `can_receive` against signal levels, `can_view` against
 * viewable objects, and `can_share` against `service_request_fulfillment`.
 * Pairing outside these is rejected rather than stored, so a nonsensical grant
 * such as `can_receive` + `checkin_answers` cannot sit in the table waiting to be
 * matched by an evaluation.
 */
export const PERMITTED_SCOPES: Readonly<Record<ConsentPermission, readonly ConsentScope[]>> = {
  can_receive: ['YELLOW', 'ORANGE', 'RED'],
  can_view: ['support_signal', 'checkin_answers', 'current_requests', 'location'],
  can_share: ['service_request_fulfillment'],
};

export class InvalidConsentScopeError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor(permission: ConsentPermission, scope: ConsentScope) {
    super(
      `"${permission}" does not apply to scope "${scope}". Permitted scopes: ` +
        `${PERMITTED_SCOPES[permission].join(', ')} (SUAS-specs CONSENT.md §2.1).`,
    );
    this.name = 'InvalidConsentScopeError';
  }
}

export function assertPermissionScope(permission: ConsentPermission, scope: ConsentScope): void {
  if (!PERMITTED_SCOPES[permission].includes(scope)) {
    throw new InvalidConsentScopeError(permission, scope);
  }
}

/**
 * Documented system bases that authorize an action without a Consent Grant.
 *
 * CONSENT.md §3.5: system actions that do not disclose to a third party do not
 * require a third-party grant.
 * CONSENT.md §3.6: an assigned Responder's least-privilege case access is a
 * separate documented policy, still recorded as `consent_basis` on each access
 * Audit Event.
 *
 * This list is closed. Anything not here is a missing grant, which denies.
 */
export const SYSTEM_BASES = ['SYSTEM_INTERNAL_PROCESSING', 'RESPONDER_CASE_ASSIGNMENT'] as const;
export type SystemBasis = (typeof SYSTEM_BASES)[number];

/** What authorized a disclosure, recorded on the Audit Event. CONSENT.md §5, §8. */
export type ConsentBasis = 'CONSENT_GRANT' | SystemBasis;
