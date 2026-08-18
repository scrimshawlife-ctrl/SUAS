/**
 * Use-time consent evaluation.
 *
 * Spec citations:
 * - SUAS-specs CONSENT.md §1 (every disclosure requires a matching grant or a
 *   documented system basis, evaluated at use time), §3 (evaluation rules 1-11),
 *   §4 (revocation stops future use), §5 (what a disclosure Audit Event records),
 *   §7 (a refused action still writes a `DENIED` ConsentEvent), §8 (events)
 * - SUAS-specs TRUSTED_CIRCLE.md §6 (membership is evaluated before grants)
 * - SUAS-specs PRIVACY.md §2 (purpose limitation; access logging)
 * - SUAS-specs API.md §4 (missing consent returns 403 `CONSENT_DENIED`)
 *
 * Nothing here caches. CONSENT.md §3.1 says plainly: evaluate at the moment of
 * use, and do not cache "visible forever". Every call re-reads the grant, the
 * membership, and the veteran's status.
 */

import type { Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import type { JsonObject } from '../jobs/index.js';
import { findActiveGrant } from './grants.js';
import { recordConsentEvent } from './grants.js';
import { findTrustedContact, membershipPermitsUse } from './trusted-circle.js';
import {
  assertPermissionScope,
  type ConsentBasis,
  type ConsentPermission,
  type ConsentScope,
  type GranteeType,
  type SystemBasis,
} from './vocabulary.js';

/** API.md §4: a non-sensitive denial code. */
export class ConsentDeniedError extends Error {
  readonly code = 'CONSENT_DENIED';
  readonly httpStatus = 403;
  readonly reason: DenialReason;

  constructor(reason: DenialReason) {
    // Deliberately non-specific: a denial must not describe the veteran's
    // consent posture to the party being refused.
    super('This action is not authorized by an active consent grant.');
    this.name = 'ConsentDeniedError';
    this.reason = reason;
  }
}

export type DenialReason =
  /** The grantee's Trusted Circle membership does not permit any use. */
  | 'MEMBERSHIP_NOT_USABLE'
  /** No ACTIVE grant matches this exact permission, scope, and grantee. */
  | 'NO_MATCHING_GRANT'
  /** A system basis was claimed but does not apply to this disclosure. */
  | 'SYSTEM_BASIS_NOT_APPLICABLE'
  /** Responder case-assignment basis could not be verified. */
  | 'ASSIGNMENT_NOT_VERIFIABLE'
  /** The veteran is not enrolled and active. */
  | 'VETERAN_NOT_ENROLLED';

export interface DisclosureRequest {
  readonly tenantId: string;
  /** The veteran whose data would be disclosed. */
  readonly veteranUserId: string;
  readonly permission: ConsentPermission;
  readonly scope: ConsentScope;
  readonly granteeType: GranteeType;
  readonly granteeId: string;
  /** Why this disclosure is being attempted. CONSENT.md §3.4: purpose must match. */
  readonly purpose: string;
  /**
   * A documented system basis the caller claims instead of a grant. Claiming one
   * does not make it apply; it is validated below.
   */
  readonly systemBasis?: SystemBasis;
  /**
   * Field names or categories that would be disclosed. Recorded on the Audit
   * Event (CONSENT.md §5). Names only — never values.
   */
  readonly disclosedFields?: readonly string[];
  readonly correlationId?: string;
  readonly requestId?: string;
}

export type ConsentDecision =
  | { readonly allowed: true; readonly basis: ConsentBasis; readonly consentGrantId?: string }
  | { readonly allowed: false; readonly reason: DenialReason };

export interface ConsentEvaluationDeps {
  /**
   * Confirms an active case assignment, for `RESPONDER_CASE_ASSIGNMENT`.
   *
   * CaseAssignment arrives in SPEC017_PLAN.md Slice 5. Until a verifier is
   * supplied, that basis cannot be established and evaluation denies rather than
   * assuming an assignment exists.
   */
  readonly verifyActiveAssignment?: (params: {
    tenantId: string;
    responderUserId: string;
    veteranUserId: string;
  }) => Promise<boolean>;
}

async function veteranIsEnrolled(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM users
     WHERE tenant_id = $1 AND user_id = $2 AND status = 'ACTIVE' AND deleted_at IS NULL`,
    [tenantId, veteranUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Validate a claimed system basis.
 *
 * CONSENT.md §3.5 permits internal system action that discloses to no third
 * party. §3.6 permits an assigned Responder's least-privilege case access. Both
 * still require the veteran to be enrolled and the action to be in product scope.
 */
async function evaluateSystemBasis(
  deps: ConsentEvaluationDeps,
  request: DisclosureRequest,
  basis: SystemBasis,
): Promise<ConsentDecision> {
  if (basis === 'SYSTEM_INTERNAL_PROCESSING') {
    // Only valid when nothing leaves SUAS. A disclosure aimed at any external
    // grantee is a third-party disclosure and needs a grant.
    if (request.granteeType !== 'SYSTEM') {
      return { allowed: false, reason: 'SYSTEM_BASIS_NOT_APPLICABLE' };
    }
    return { allowed: true, basis };
  }

  // RESPONDER_CASE_ASSIGNMENT
  if (request.granteeType !== 'RESPONDER') {
    return { allowed: false, reason: 'SYSTEM_BASIS_NOT_APPLICABLE' };
  }
  if (deps.verifyActiveAssignment === undefined) {
    return { allowed: false, reason: 'ASSIGNMENT_NOT_VERIFIABLE' };
  }
  const assigned = await deps.verifyActiveAssignment({
    tenantId: request.tenantId,
    responderUserId: request.granteeId,
    veteranUserId: request.veteranUserId,
  });
  return assigned
    ? { allowed: true, basis }
    : { allowed: false, reason: 'ASSIGNMENT_NOT_VERIFIABLE' };
}

/**
 * Evaluate a disclosure and record the outcome.
 *
 * Writes an Audit Event for every third-party evaluation, allow or deny
 * (CONSENT.md §8), and a `DENIED` ConsentEvent whenever the action is refused
 * (CONSENT.md §7).
 */
export async function evaluateDisclosure(
  db: Queryable,
  request: DisclosureRequest,
  deps: ConsentEvaluationDeps = {},
): Promise<ConsentDecision> {
  assertPermissionScope(request.permission, request.scope);

  const decision = await decide(db, request, deps);
  await recordOutcome(db, request, decision);
  return decision;
}

async function decide(
  db: Queryable,
  request: DisclosureRequest,
  deps: ConsentEvaluationDeps,
): Promise<ConsentDecision> {
  // CONSENT.md §3.5: any action still requires the veteran to be enrolled.
  if (!(await veteranIsEnrolled(db, request.tenantId, request.veteranUserId))) {
    return { allowed: false, reason: 'VETERAN_NOT_ENROLLED' };
  }

  // TRUSTED_CIRCLE.md §6: membership is evaluated first, so a removed or
  // suspended contact is denied regardless of any grant left behind.
  if (request.granteeType === 'TRUSTED_CONTACT') {
    const contact = await findTrustedContact(db, request.tenantId, request.granteeId);
    if (!membershipPermitsUse(contact)) {
      return { allowed: false, reason: 'MEMBERSHIP_NOT_USABLE' };
    }
  }

  const grant = await findActiveGrant(db, {
    tenantId: request.tenantId,
    veteranUserId: request.veteranUserId,
    permission: request.permission,
    scope: request.scope,
    granteeType: request.granteeType,
    granteeId: request.granteeId,
  });

  if (grant !== undefined) {
    return { allowed: true, basis: 'CONSENT_GRANT', consentGrantId: grant.consentGrantId };
  }

  if (request.systemBasis !== undefined) {
    return evaluateSystemBasis(deps, request, request.systemBasis);
  }

  // CONSENT.md §3.2: missing grant denies.
  return { allowed: false, reason: 'NO_MATCHING_GRANT' };
}

async function recordOutcome(
  db: Queryable,
  request: DisclosureRequest,
  decision: ConsentDecision,
): Promise<void> {
  const isThirdParty = request.granteeType !== 'SYSTEM';

  // CONSENT.md §8: audit every evaluate-for-disclosure on third-party data.
  // Purely internal processing is not audited per evaluation, which would
  // otherwise flood the audit store without recording a disclosure.
  if (isThirdParty) {
    const payload: JsonObject = {
      decision: decision.allowed ? 'ALLOW' : 'DENY',
      consent_basis: decision.allowed ? decision.basis : 'NONE',
      permission: request.permission,
      scope: request.scope,
      purpose: request.purpose,
      ...(decision.allowed ? {} : { denial_reason: (decision as { reason: DenialReason }).reason }),
      // CONSENT.md §5: field names and categories, never values or body dumps.
      ...(request.disclosedFields !== undefined
        ? { disclosed_fields: [...request.disclosedFields] }
        : {}),
    };

    await appendAuditEvent(db, {
      eventType: 'CONSENT_EVALUATED',
      action: decision.allowed ? 'DISCLOSURE_ALLOWED' : 'DISCLOSURE_DENIED',
      targetType: request.granteeType,
      targetId: request.granteeId,
      aggregateType: 'ConsentGrant',
      aggregateId: request.veteranUserId,
      tenantId: request.tenantId,
      actorType: 'SYSTEM',
      actorId: 'consent',
      payload,
      ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
      ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
    });
  }

  // CONSENT.md §7: a refused action writes a DENIED ConsentEvent even when no
  // grant was ever created.
  if (!decision.allowed) {
    await recordConsentEvent(db, {
      tenantId: request.tenantId,
      veteranUserId: request.veteranUserId,
      eventType: 'DENIED',
      permission: request.permission,
      scope: request.scope,
      granteeType: request.granteeType,
      granteeId: request.granteeId,
      purpose: request.purpose,
      payload: { denial_reason: decision.reason },
    });
  }
}

/**
 * Evaluate and throw on denial.
 *
 * This is the call site every share, notify, referral, and provider-disclosure
 * path uses. It replaces the fail-closed placeholder that Slice 3 installed.
 */
export async function requireDisclosure(
  db: Queryable,
  request: DisclosureRequest,
  deps: ConsentEvaluationDeps = {},
): Promise<ConsentBasis> {
  const decision = await evaluateDisclosure(db, request, deps);
  if (!decision.allowed) {
    throw new ConsentDeniedError(decision.reason);
  }
  return decision.basis;
}
