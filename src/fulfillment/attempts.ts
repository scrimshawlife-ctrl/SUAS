/**
 * Fulfillment Attempts and Service Fulfillments.
 *
 * Spec citations:
 * - SUAS-specs FULFILLMENT.md §1 (a request is not fulfilled merely because it is
 *   assigned), §2 (fulfillment states), §3 (attempt fields), §3.2 (idempotency),
 *   §3.3 (unknown outcome), §5 (mapping to Service Request), §6 (confirmation),
 *   §7 (failure, partial, reroute), §9 (concurrency), §11 (events)
 * - SUAS-specs PROVIDER_INTEGRATIONS.md §9 (attempt identity), §10 (concurrency)
 * - SUAS-specs DATA_MODEL.md §7, §14 rules 7-8
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import type { ServiceCategory } from '../coordination/index.js';
import type { JsonObject } from '../jobs/index.js';
import type { AttemptStatus, FulfillmentMode, IntegrationMode } from './port.js';
import { TERMINAL_ATTEMPT_STATUSES } from './port.js';

export const FULFILLMENT_STATES = [
  'ACCEPTED',
  'STARTED',
  'COMPLETED',
  'CONFIRMED',
  'DISPUTED',
  'FAILED',
  'PARTIAL',
  'CANCELLED',
] as const;
export type FulfillmentState = (typeof FULFILLMENT_STATES)[number];

export interface FulfillmentAttempt {
  readonly fulfillmentAttemptId: string;
  readonly tenantId: string;
  readonly serviceRequestId: string;
  readonly capability: ServiceCategory;
  readonly adapterId: string;
  readonly integrationMode: IntegrationMode;
  readonly idempotencyKey: string;
  readonly status: AttemptStatus;
  readonly externalReference: string | undefined;
  readonly lastProviderStatus: string | undefined;
  readonly failureReason: string | undefined;
}

interface AttemptRow {
  fulfillment_attempt_id: string;
  tenant_id: string;
  service_request_id: string;
  capability: ServiceCategory;
  adapter_id: string;
  integration_mode: IntegrationMode;
  idempotency_key: string;
  status: AttemptStatus;
  external_reference: string | null;
  last_provider_status: string | null;
  failure_reason: string | null;
}

const ATTEMPT_COLUMNS = `
  fulfillment_attempt_id, tenant_id, service_request_id, capability, adapter_id,
  integration_mode, idempotency_key, status, external_reference,
  last_provider_status, failure_reason
`;

function toAttempt(row: AttemptRow): FulfillmentAttempt {
  return {
    fulfillmentAttemptId: row.fulfillment_attempt_id,
    tenantId: row.tenant_id,
    serviceRequestId: row.service_request_id,
    capability: row.capability,
    adapterId: row.adapter_id,
    integrationMode: row.integration_mode,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    externalReference: row.external_reference ?? undefined,
    lastProviderStatus: row.last_provider_status ?? undefined,
    failureReason: row.failure_reason ?? undefined,
  };
}

/**
 * FULFILLMENT.md §9: two workers or responders must not concurrently initiate the
 * same logical attempt. The partial unique index refuses the second insert.
 */
export class AttemptAlreadyInFlightError extends Error {
  readonly code = 'ALREADY_CLAIMED';
  readonly httpStatus = 409;

  constructor() {
    super(
      'This Service Request already has a Fulfillment Attempt in flight ' +
        '(SUAS-specs FULFILLMENT.md §9).',
    );
    this.name = 'AttemptAlreadyInFlightError';
  }
}

/** FULFILLMENT.md §3.3: reconcile before a retry that could duplicate fulfillment. */
export class ReconciliationRequiredError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super(
      'This attempt is PROVIDER_UNKNOWN: the external mutation may have succeeded. It must be ' +
        'reconciled before another attempt, or a duplicate ride, room, or dispatch could result ' +
        '(SUAS-specs FULFILLMENT.md §3.3).',
    );
    this.name = 'ReconciliationRequiredError';
  }
}

/**
 * Stable idempotency identity for one attempt.
 *
 * FULFILLMENT.md §3.2: a retry of the same logical action reuses this key, and a
 * deliberate provider switch produces a new attempt and therefore a new key.
 */
export function attemptIdempotencyKey(serviceRequestId: string, attemptId: string): string {
  return `sr:${serviceRequestId}:attempt:${attemptId}`;
}

export interface CreateAttemptInput {
  readonly tenantId: string;
  readonly serviceRequestId: string;
  readonly capability: ServiceCategory;
  readonly adapterId: string;
  readonly integrationMode: IntegrationMode;
  readonly serviceProviderId?: string;
  readonly initialStatus: AttemptStatus;
}

export async function createAttempt(
  tx: Queryable,
  input: CreateAttemptInput,
): Promise<FulfillmentAttempt> {
  const attemptId = randomUUID();
  const idempotencyKey = attemptIdempotencyKey(input.serviceRequestId, attemptId);

  try {
    const result = await tx.query<AttemptRow>(
      `INSERT INTO fulfillment_attempts
         (fulfillment_attempt_id, tenant_id, service_request_id, capability, adapter_id,
          service_provider_id, integration_mode, idempotency_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${ATTEMPT_COLUMNS}`,
      [
        attemptId,
        input.tenantId,
        input.serviceRequestId,
        input.capability,
        input.adapterId,
        input.serviceProviderId ?? null,
        input.integrationMode,
        idempotencyKey,
        input.initialStatus,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Fulfillment attempt insert returned no row.');
    return toAttempt(row);
  } catch (error) {
    // The one-in-flight partial index is the concurrency guard.
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === '23505'
    ) {
      throw new AttemptAlreadyInFlightError();
    }
    throw error;
  }
}

export interface RecordOutcomeInput {
  readonly status: AttemptStatus;
  readonly externalReference?: string;
  readonly lastProviderStatus?: string;
  readonly failureReason?: string;
  readonly metadata?: JsonObject;
}

export async function recordAttemptOutcome(
  tx: Queryable,
  tenantId: string,
  attemptId: string,
  outcome: RecordOutcomeInput,
): Promise<FulfillmentAttempt> {
  const result = await tx.query<AttemptRow>(
    `UPDATE fulfillment_attempts
       SET status = $3::suas_attempt_status,
           external_reference = COALESCE($4, external_reference),
           last_provider_status = COALESCE($5, last_provider_status),
           failure_reason = COALESCE($6, failure_reason),
           metadata = COALESCE($7::jsonb, metadata),
           last_checked_at = now(),
           updated_at = now()
     WHERE tenant_id = $1 AND fulfillment_attempt_id = $2
     RETURNING ${ATTEMPT_COLUMNS}`,
    [
      tenantId,
      attemptId,
      outcome.status,
      outcome.externalReference ?? null,
      outcome.lastProviderStatus ?? null,
      outcome.failureReason ?? null,
      outcome.metadata === undefined ? null : JSON.stringify(outcome.metadata),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`No fulfillment attempt ${attemptId} to update.`);
  return toAttempt(row);
}

export async function findAttempt(
  db: Queryable,
  tenantId: string,
  attemptId: string,
): Promise<FulfillmentAttempt | undefined> {
  const result = await db.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM fulfillment_attempts
     WHERE tenant_id = $1 AND fulfillment_attempt_id = $2`,
    [tenantId, attemptId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toAttempt(row);
}

/** Full attempt history for a request. FULFILLMENT.md §3: multiple sequential attempts. */
export async function listAttempts(
  db: Queryable,
  tenantId: string,
  serviceRequestId: string,
): Promise<FulfillmentAttempt[]> {
  const result = await db.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM fulfillment_attempts
     WHERE tenant_id = $1 AND service_request_id = $2
     ORDER BY created_at ASC`,
    [tenantId, serviceRequestId],
  );
  return result.rows.map(toAttempt);
}

export async function findInFlightAttempt(
  db: Queryable,
  tenantId: string,
  serviceRequestId: string,
): Promise<FulfillmentAttempt | undefined> {
  const result = await db.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM fulfillment_attempts
     WHERE tenant_id = $1 AND service_request_id = $2
       AND status <> ALL($3::suas_attempt_status[])`,
    [tenantId, serviceRequestId, TERMINAL_ATTEMPT_STATUSES],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toAttempt(row);
}

// ---------------------------------------------------------------------------
// Service Fulfillment
// ---------------------------------------------------------------------------

export interface ServiceFulfillment {
  readonly serviceFulfillmentId: string;
  readonly tenantId: string;
  readonly serviceRequestId: string;
  readonly fulfillmentAttemptId: string | undefined;
  readonly state: FulfillmentState;
  readonly fulfillmentMode: FulfillmentMode | undefined;
  readonly veteranConfirmedAt: Date | undefined;
  readonly responderConfirmedAt: Date | undefined;
}

interface FulfillmentRow {
  service_fulfillment_id: string;
  tenant_id: string;
  service_request_id: string;
  fulfillment_attempt_id: string | null;
  state: FulfillmentState;
  fulfillment_mode: FulfillmentMode | null;
  veteran_confirmed_at: Date | null;
  responder_confirmed_at: Date | null;
}

const FULFILLMENT_COLUMNS = `
  service_fulfillment_id, tenant_id, service_request_id, fulfillment_attempt_id,
  state, fulfillment_mode, veteran_confirmed_at, responder_confirmed_at
`;

function toFulfillment(row: FulfillmentRow): ServiceFulfillment {
  return {
    serviceFulfillmentId: row.service_fulfillment_id,
    tenantId: row.tenant_id,
    serviceRequestId: row.service_request_id,
    fulfillmentAttemptId: row.fulfillment_attempt_id ?? undefined,
    state: row.state,
    fulfillmentMode: row.fulfillment_mode ?? undefined,
    veteranConfirmedAt: row.veteran_confirmed_at ?? undefined,
    responderConfirmedAt: row.responder_confirmed_at ?? undefined,
  };
}

export class ConfirmationActorRequiredError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super(
      'CONFIRMED requires a veteran or responder confirmation timestamp; an external provider ' +
        'completion does not replace human confirmation (SUAS-specs FULFILLMENT.md §6).',
    );
    this.name = 'ConfirmationActorRequiredError';
  }
}

export class ConfirmationReasonRequiredError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super(
      'A responder-only confirmation requires a recorded reason the veteran could not confirm ' +
        '(SUAS-specs FULFILLMENT.md §6).',
    );
    this.name = 'ConfirmationReasonRequiredError';
  }
}

/**
 * Fulfillment states from which confirmation is refused.
 *
 * FULFILLMENT.md §6: "a dispute moves to DISPUTED and never to CONFIRMED." A
 * cancelled or failed fulfillment likewise never represents a delivered service,
 * so none of these may be flipped to CONFIRMED.
 */
export const NON_CONFIRMABLE_FULFILLMENT_STATES: readonly FulfillmentState[] = [
  'DISPUTED',
  'CANCELLED',
  'FAILED',
];

export class FulfillmentNotConfirmableError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(state: FulfillmentState) {
    super(
      `A fulfillment in state "${state}" cannot be confirmed: a disputed, cancelled, or failed ` +
        `fulfillment never becomes CONFIRMED (SUAS-specs FULFILLMENT.md §6).`,
    );
    this.name = 'FulfillmentNotConfirmableError';
  }
}

export async function upsertFulfillment(
  tx: Queryable,
  input: {
    tenantId: string;
    serviceRequestId: string;
    fulfillmentAttemptId?: string;
    state: FulfillmentState;
    fulfillmentMode?: FulfillmentMode;
    failureReason?: string;
  },
): Promise<ServiceFulfillment> {
  const result = await tx.query<FulfillmentRow>(
    `INSERT INTO service_fulfillments
       (service_fulfillment_id, tenant_id, service_request_id, fulfillment_attempt_id,
        state, fulfillment_mode, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (service_request_id) DO UPDATE
       SET state = EXCLUDED.state,
           fulfillment_attempt_id = COALESCE(EXCLUDED.fulfillment_attempt_id,
                                             service_fulfillments.fulfillment_attempt_id),
           fulfillment_mode = COALESCE(EXCLUDED.fulfillment_mode,
                                       service_fulfillments.fulfillment_mode),
           failure_reason = COALESCE(EXCLUDED.failure_reason, service_fulfillments.failure_reason),
           updated_at = now()
     RETURNING ${FULFILLMENT_COLUMNS}`,
    [
      randomUUID(),
      input.tenantId,
      input.serviceRequestId,
      input.fulfillmentAttemptId ?? null,
      input.state,
      input.fulfillmentMode ?? null,
      input.failureReason ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Service fulfillment upsert returned no row.');
  return toFulfillment(row);
}

/**
 * Confirm a fulfillment.
 *
 * FULFILLMENT.md §6: at least one of veteran or responder confirmation is
 * required, and a responder-only confirmation needs a reason. §13 forbids
 * auto-confirming on a timer without a recorded actor, which is why there is no
 * code path here that confirms without one.
 */
export async function confirmFulfillment(
  tx: Queryable,
  input: {
    tenantId: string;
    serviceRequestId: string;
    veteranConfirmed?: boolean;
    responderConfirmedBy?: string;
    reason?: string;
  },
): Promise<ServiceFulfillment> {
  const veteran = input.veteranConfirmed === true;
  const responder = input.responderConfirmedBy !== undefined;

  if (!veteran && !responder) throw new ConfirmationActorRequiredError();
  if (!veteran && responder && (input.reason === undefined || input.reason.trim() === '')) {
    throw new ConfirmationReasonRequiredError();
  }

  // FULFILLMENT.md §6: a disputed/cancelled/failed fulfillment never becomes
  // CONFIRMED. The state is locked and checked at mutation time — the UPDATE
  // below has no state predicate of its own, so without this guard a DISPUTED
  // fulfillment could be silently flipped to CONFIRMED.
  const current = await tx.query<{ state: FulfillmentState }>(
    `SELECT state FROM service_fulfillments
     WHERE tenant_id = $1 AND service_request_id = $2
     FOR UPDATE`,
    [input.tenantId, input.serviceRequestId],
  );
  const currentRow = current.rows[0];
  if (currentRow === undefined) {
    throw new Error('No service fulfillment to confirm for this Service Request.');
  }
  if (NON_CONFIRMABLE_FULFILLMENT_STATES.includes(currentRow.state)) {
    throw new FulfillmentNotConfirmableError(currentRow.state);
  }

  const result = await tx.query<FulfillmentRow>(
    `UPDATE service_fulfillments
       SET state = 'CONFIRMED',
           veteran_confirmed_at = CASE WHEN $3::boolean THEN now() ELSE veteran_confirmed_at END,
           responder_confirmed_at = CASE WHEN $4::uuid IS NOT NULL THEN now()
                                         ELSE responder_confirmed_at END,
           responder_confirmed_by = COALESCE($4::uuid, responder_confirmed_by),
           confirmation_reason = COALESCE($5, confirmation_reason),
           updated_at = now()
     WHERE tenant_id = $1 AND service_request_id = $2
     RETURNING ${FULFILLMENT_COLUMNS}`,
    [
      input.tenantId,
      input.serviceRequestId,
      veteran,
      input.responderConfirmedBy ?? null,
      input.reason ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('No service fulfillment to confirm for this Service Request.');
  }
  return toFulfillment(row);
}

/** FULFILLMENT.md §6: a dispute moves to DISPUTED and never to CONFIRMED. */
export async function disputeFulfillment(
  tx: Queryable,
  tenantId: string,
  serviceRequestId: string,
  reason: string,
): Promise<ServiceFulfillment> {
  const result = await tx.query<FulfillmentRow>(
    `UPDATE service_fulfillments
       SET state = 'DISPUTED', dispute_reason = $3, updated_at = now()
     WHERE tenant_id = $1 AND service_request_id = $2
     RETURNING ${FULFILLMENT_COLUMNS}`,
    [tenantId, serviceRequestId, reason],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('No service fulfillment to dispute.');
  return toFulfillment(row);
}

export async function findFulfillment(
  db: Queryable,
  tenantId: string,
  serviceRequestId: string,
): Promise<ServiceFulfillment | undefined> {
  const result = await db.query<FulfillmentRow>(
    `SELECT ${FULFILLMENT_COLUMNS} FROM service_fulfillments
     WHERE tenant_id = $1 AND service_request_id = $2`,
    [tenantId, serviceRequestId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toFulfillment(row);
}
