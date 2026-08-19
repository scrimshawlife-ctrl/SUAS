/**
 * Referrals.
 *
 * Spec citations:
 * - SUAS-specs REFERRALS.md §1 (a Referral is not a Service Request, and sending
 *   one is not Fulfillment), §2 (required content), §3 (states), §4 (consent and
 *   minimum disclosure at send), §5 (send idempotency), §6 (Follow-Up
 *   relationship), §7 (events), §8 (non-goals)
 * - SUAS-specs CONSENT.md §3.7 (a Referral send requires an ACTIVE grant covering
 *   the destination and the data included)
 * - SUAS-specs EVENT_MODEL.md §3 (`REFERRAL_CREATED`, `REFERRAL_UPDATED`)
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendDomainEvent } from '../events/index.js';
import { requireDisclosure } from '../consent/index.js';

export const REFERRAL_STATUSES = [
  'DRAFTED',
  'SENT',
  'ACKNOWLEDGED',
  'ACCEPTED',
  'DECLINED',
  'COMPLETED',
  'UNABLE_TO_SERVE',
  'CANCELLED',
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const REFERRAL_METHODS = ['IN_APP', 'PHONE', 'EMAIL'] as const;
export type ReferralMethod = (typeof REFERRAL_METHODS)[number];

/**
 * REFERRALS.md §3, transcribed. The cancellation row is enumerated rather than
 * treated as "any non-terminal", matching the same discipline DISPATCH.md
 * demands of Service Requests.
 */
const REFERRAL_TRANSITIONS: readonly { from: ReferralStatus; to: ReferralStatus }[] = [
  { from: 'DRAFTED', to: 'SENT' },
  { from: 'SENT', to: 'ACKNOWLEDGED' },
  { from: 'ACKNOWLEDGED', to: 'ACCEPTED' },
  { from: 'ACKNOWLEDGED', to: 'DECLINED' },
  { from: 'ACCEPTED', to: 'COMPLETED' },
  { from: 'ACCEPTED', to: 'UNABLE_TO_SERVE' },
  { from: 'DRAFTED', to: 'CANCELLED' },
  { from: 'SENT', to: 'CANCELLED' },
  { from: 'ACKNOWLEDGED', to: 'CANCELLED' },
  { from: 'ACCEPTED', to: 'CANCELLED' },
];

export class IllegalReferralTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly httpStatus = 409;

  constructor(from: ReferralStatus, to: ReferralStatus) {
    super(
      `"${from}" → "${to}" is not a documented Referral transition ` +
        `(SUAS-specs REFERRALS.md §3).`,
    );
    this.name = 'IllegalReferralTransitionError';
  }
}

export interface Referral {
  readonly referralId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly serviceRequestId: string | undefined;
  readonly destinationType: string;
  readonly destinationId: string;
  readonly reason: string;
  readonly method: ReferralMethod;
  readonly status: ReferralStatus;
  readonly consentGrantId: string | undefined;
  readonly consentBasis: string | undefined;
  readonly followUpId: string | undefined;
  readonly sentAt: Date | undefined;
}

interface ReferralRow {
  referral_id: string;
  tenant_id: string;
  case_id: string;
  service_request_id: string | null;
  destination_type: string;
  destination_id: string;
  reason: string;
  method: ReferralMethod;
  status: ReferralStatus;
  consent_grant_id: string | null;
  consent_basis: string | null;
  follow_up_id: string | null;
  sent_at: Date | null;
}

const REFERRAL_COLUMNS = `
  referral_id, tenant_id, case_id, service_request_id, destination_type, destination_id,
  reason, method, status, consent_grant_id, consent_basis, follow_up_id, sent_at
`;

function toReferral(row: ReferralRow): Referral {
  return {
    referralId: row.referral_id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    serviceRequestId: row.service_request_id ?? undefined,
    destinationType: row.destination_type,
    destinationId: row.destination_id,
    reason: row.reason,
    method: row.method,
    status: row.status,
    consentGrantId: row.consent_grant_id ?? undefined,
    consentBasis: row.consent_basis ?? undefined,
    followUpId: row.follow_up_id ?? undefined,
    sentAt: row.sent_at ?? undefined,
  };
}

export interface DraftReferralInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly serviceRequestId?: string;
  readonly destinationType: string;
  readonly destinationId: string;
  readonly reason: string;
  readonly method: ReferralMethod;
  readonly actorId: string;
  readonly correlationId?: string;
}

/**
 * Draft a Referral.
 *
 * REFERRALS.md §3 and §4: a draft may exist without disclosure, and drafting does
 * not authorize a later send — so no consent is evaluated here, and none is
 * carried forward.
 */
export async function draftReferral(pool: Pool, input: DraftReferralInput): Promise<Referral> {
  return withTransaction(pool, async (tx) => {
    const referralId = randomUUID();
    const result = await tx.query<ReferralRow>(
      `INSERT INTO referrals
         (referral_id, tenant_id, case_id, service_request_id, destination_type,
          destination_id, reason, method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${REFERRAL_COLUMNS}`,
      [
        referralId,
        input.tenantId,
        input.caseId,
        input.serviceRequestId ?? null,
        input.destinationType,
        input.destinationId,
        input.reason,
        input.method,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Referral insert returned no row.');

    await appendDomainEvent(tx, {
      eventType: 'REFERRAL_CREATED',
      aggregateType: 'Referral',
      aggregateId: referralId,
      tenantId: input.tenantId,
      actorType: 'RESPONDER',
      actorId: input.actorId,
      payload: {
        case_id: input.caseId,
        destination_type: input.destinationType,
        method: input.method,
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return toReferral(row);
  });
}

export interface SendReferralInput {
  readonly tenantId: string;
  readonly referralId: string;
  readonly veteranUserId: string;
  readonly actorId: string;
  /** Stable logical send identity. REFERRALS.md §5.1. */
  readonly idempotencyKey: string;
  /** Field names being disclosed, for the consent audit trail. */
  readonly disclosedFields?: readonly string[];
  readonly correlationId?: string;
}

export interface SendReferralResult {
  readonly referral: Referral;
  /** True when a replayed send resolved to the original, disclosing nothing new. */
  readonly deduplicated: boolean;
}

/**
 * Send a Referral.
 *
 * REFERRALS.md §4: consent is evaluated at the moment of send, never inherited
 * from the draft. §5.1: replaying the same send must not disclose twice, which
 * the unique send identity enforces — and the replay path returns before any
 * consent evaluation, so a retry cannot even re-read the veteran's grants.
 */
export async function sendReferral(
  pool: Pool,
  input: SendReferralInput,
): Promise<SendReferralResult> {
  const existing = await pool.query<ReferralRow>(
    `SELECT ${REFERRAL_COLUMNS} FROM referrals
     WHERE tenant_id = $1 AND send_idempotency_key = $2`,
    [input.tenantId, input.idempotencyKey],
  );
  const alreadySent = existing.rows[0];
  if (alreadySent !== undefined) {
    return { referral: toReferral(alreadySent), deduplicated: true };
  }

  const current = await findReferral(pool, input.tenantId, input.referralId);
  if (current === undefined) throw new Error('No such Referral.');
  assertReferralTransition(current.status, 'SENT');

  // CONSENT.md §3.7 and REFERRALS.md §4: an ACTIVE grant must cover this
  // destination and payload, evaluated now.
  const basis = await requireDisclosure(pool, {
    tenantId: input.tenantId,
    veteranUserId: input.veteranUserId,
    permission: 'can_share',
    scope: 'service_request_fulfillment',
    granteeType: 'ORGANIZATION',
    granteeId: current.destinationId,
    purpose: `Refer to ${current.destinationType} for ${current.reason}`,
    ...(input.disclosedFields !== undefined ? { disclosedFields: input.disclosedFields } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  return withTransaction(pool, async (tx) => {
    const result = await tx.query<ReferralRow>(
      `UPDATE referrals
         SET status = 'SENT', sent_at = now(), send_idempotency_key = $3,
             consent_basis = $4, updated_at = now()
       WHERE tenant_id = $1 AND referral_id = $2 AND status = 'DRAFTED'
       RETURNING ${REFERRAL_COLUMNS}`,
      [input.tenantId, input.referralId, input.idempotencyKey, basis],
    );
    const row = result.rows[0];
    if (row === undefined) throw new IllegalReferralTransitionError(current.status, 'SENT');

    await appendDomainEvent(tx, {
      eventType: 'REFERRAL_UPDATED',
      aggregateType: 'Referral',
      aggregateId: input.referralId,
      tenantId: input.tenantId,
      actorType: 'RESPONDER',
      actorId: input.actorId,
      payload: { status: 'SENT', consent_basis: basis },
      idempotencyKey: `referral-send:${input.idempotencyKey}`,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return { referral: toReferral(row), deduplicated: false };
  });
}

export function assertReferralTransition(from: ReferralStatus, to: ReferralStatus): void {
  const allowed = REFERRAL_TRANSITIONS.some(
    (transition) => transition.from === from && transition.to === to,
  );
  if (!allowed) throw new IllegalReferralTransitionError(from, to);
}

/**
 * Advance a Referral's status.
 *
 * REFERRALS.md §5.6: a transport or delivery callback may update delivery
 * evidence but cannot mark ACKNOWLEDGED, ACCEPTED, or COMPLETED — so this
 * requires an actor and is never called from a delivery receipt path.
 */
export async function updateReferralStatus(
  pool: Pool,
  input: {
    tenantId: string;
    referralId: string;
    to: ReferralStatus;
    actorId: string;
    result?: string;
    reason?: string;
    correlationId?: string;
  },
): Promise<Referral> {
  return withTransaction(pool, async (tx) => {
    const current = await findReferral(tx, input.tenantId, input.referralId);
    if (current === undefined) throw new Error('No such Referral.');
    assertReferralTransition(current.status, input.to);

    const updated = await tx.query<ReferralRow>(
      `UPDATE referrals
         SET status = $3::suas_referral_status,
             result = COALESCE($4, result),
             status_reason = COALESCE($5, status_reason),
             updated_at = now()
       WHERE tenant_id = $1 AND referral_id = $2
       RETURNING ${REFERRAL_COLUMNS}`,
      [input.tenantId, input.referralId, input.to, input.result ?? null, input.reason ?? null],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new Error('No such Referral.');

    await appendDomainEvent(tx, {
      eventType: 'REFERRAL_UPDATED',
      aggregateType: 'Referral',
      aggregateId: input.referralId,
      tenantId: input.tenantId,
      actorType: 'RESPONDER',
      actorId: input.actorId,
      payload: { status: input.to },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return toReferral(row);
  });
}

/** REFERRALS.md §6: a Referral requiring check-back links a first-class Follow-Up. */
export async function linkFollowUp(
  db: Queryable,
  tenantId: string,
  referralId: string,
  followUpId: string,
): Promise<Referral | undefined> {
  const result = await db.query<ReferralRow>(
    `UPDATE referrals SET follow_up_id = $3, updated_at = now()
     WHERE tenant_id = $1 AND referral_id = $2
     RETURNING ${REFERRAL_COLUMNS}`,
    [tenantId, referralId, followUpId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toReferral(row);
}

export async function findReferral(
  db: Queryable,
  tenantId: string,
  referralId: string,
): Promise<Referral | undefined> {
  const result = await db.query<ReferralRow>(
    `SELECT ${REFERRAL_COLUMNS} FROM referrals WHERE tenant_id = $1 AND referral_id = $2`,
    [tenantId, referralId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toReferral(row);
}
