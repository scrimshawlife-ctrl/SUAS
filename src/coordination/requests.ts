/**
 * Service Request commands.
 *
 * Spec citations:
 * - SUAS-specs DISPATCH.md §1 (a Service Request is not a Case), §3 (command
 *   concurrency invariant), §4 (transitions), §5 (provider relationship),
 *   §6 (assignment concurrency), §7 (categories), §8 (consent/privacy)
 * - SUAS-specs EVENT_MODEL.md §3 (`SERVICE_REQUEST_CREATED`,
 *   `SERVICE_REQUEST_ASSIGNED`)
 * - SUAS-specs CONSENT.md §3.8, §3.10-§3.11 (consent is evaluated before each
 *   external mutation that newly discloses data; reroute re-evaluates)
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendDomainEvent } from '../events/index.js';
import type { JsonObject } from '../jobs/index.js';
import { findCase, CaseNotFoundError } from './cases.js';
import {
  assertServiceCategory,
  resolveRequestTransition,
  StaleRequestStateError,
  type ServiceCategory,
  type ServiceRequestCommand,
  type ServiceRequestStatus,
} from './request-transitions.js';

export interface ServiceRequest {
  readonly serviceRequestId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly category: ServiceCategory;
  readonly status: ServiceRequestStatus;
  readonly details: JsonObject;
}

interface RequestRow {
  service_request_id: string;
  tenant_id: string;
  case_id: string;
  category: ServiceCategory;
  status: ServiceRequestStatus;
  details: JsonObject;
}

const REQUEST_COLUMNS = 'service_request_id, tenant_id, case_id, category, status, details';

function toRequest(row: RequestRow): ServiceRequest {
  return {
    serviceRequestId: row.service_request_id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    category: row.category,
    status: row.status,
    details: row.details,
  };
}

export class ServiceRequestNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Resource not found.');
    this.name = 'ServiceRequestNotFoundError';
  }
}

export class ClosedCaseError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super('A Service Request cannot be created on a closed Case (SUAS-specs DISPATCH.md §4).');
    this.name = 'ClosedCaseError';
  }
}

export interface CreateServiceRequestInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly category: string;
  readonly createdBy: string;
  readonly actorType: 'VETERAN' | 'RESPONDER';
  readonly details?: JsonObject;
  readonly correlationId?: string;
}

/**
 * Create a Service Request under an open Case.
 *
 * DISPATCH.md §4 requires the parent Case to exist and not be `CLOSED`, and
 * §7 rejects unknown category codes — including the reserved future ones.
 */
export async function createServiceRequest(
  tx: PoolClient,
  input: CreateServiceRequestInput,
): Promise<ServiceRequest> {
  assertServiceCategory(input.category);

  const parent = await findCase(tx, input.tenantId, input.caseId);
  if (parent === undefined) throw new CaseNotFoundError();
  if (parent.status === 'CLOSED') throw new ClosedCaseError();

  const serviceRequestId = randomUUID();
  const result = await tx.query<RequestRow>(
    `INSERT INTO service_requests
       (service_request_id, tenant_id, case_id, category, details, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${REQUEST_COLUMNS}`,
    [
      serviceRequestId,
      input.tenantId,
      input.caseId,
      input.category,
      JSON.stringify(input.details ?? {}),
      input.createdBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Service request insert returned no row.');

  await appendDomainEvent(tx, {
    eventType: 'SERVICE_REQUEST_CREATED',
    aggregateType: 'ServiceRequest',
    aggregateId: serviceRequestId,
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.createdBy,
    payload: { case_id: input.caseId, category: input.category },
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  return toRequest(row);
}

export async function findServiceRequest(
  db: Queryable,
  tenantId: string,
  serviceRequestId: string,
): Promise<ServiceRequest | undefined> {
  const result = await db.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM service_requests
     WHERE tenant_id = $1 AND service_request_id = $2`,
    [tenantId, serviceRequestId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toRequest(row);
}

/**
 * Evaluated before an `ASSIGN` that puts veteran data in front of a third party.
 *
 * DISPATCH.md §8 and CONSENT.md §3.8: the basis is evaluated at call time, and
 * §3.10-§3.11 make a reroute a fresh disclosure decision rather than a reuse of
 * the previous one.
 */
export type DisclosureGuard = (params: {
  tenantId: string;
  serviceRequestId: string;
  caseId: string;
  granteeId: string;
}) => Promise<void>;

export interface ServiceRequestCommandInput {
  readonly tenantId: string;
  readonly serviceRequestId: string;
  readonly command: ServiceRequestCommand;
  readonly actorId: string;
  readonly actorType: 'VETERAN' | 'RESPONDER' | 'SERVICE_PROVIDER' | 'SYSTEM';
  readonly reason?: string;
  /** Required when the command has more than one documented target. */
  readonly to?: ServiceRequestStatus;
  readonly expectedStatus?: ServiceRequestStatus;
  /** Grantee receiving the disclosure, for an externally disclosing edge. */
  readonly granteeId?: string;
  readonly correlationId?: string;
}

export class DisclosureGuardRequiredError extends Error {
  readonly code = 'CONSENT_DENIED';
  readonly httpStatus = 403;

  constructor() {
    super(
      'This transition discloses veteran data outside SUAS and no consent evaluation was ' +
        'supplied, so it is refused (SUAS-specs DISPATCH.md §8; CONSENT.md §3.8).',
    );
    this.name = 'DisclosureGuardRequiredError';
  }
}

/**
 * Execute a documented Service Request transition.
 *
 * DISPATCH.md §3.1: the expected current state is validated inside the same
 * atomic write that performs the transition, so concurrent incompatible commands
 * yield one winner and the loser writes nothing.
 */
export async function executeServiceRequestCommand(
  pool: Pool,
  input: ServiceRequestCommandInput,
  deps: { disclosureGuard?: DisclosureGuard } = {},
): Promise<ServiceRequest> {
  return withTransaction(pool, async (tx) => {
    const locked = await tx.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM service_requests
       WHERE tenant_id = $1 AND service_request_id = $2
       FOR UPDATE`,
      [input.tenantId, input.serviceRequestId],
    );
    const row = locked.rows[0];
    if (row === undefined) throw new ServiceRequestNotFoundError();
    const request = toRequest(row);

    if (input.expectedStatus !== undefined && request.status !== input.expectedStatus) {
      throw new StaleRequestStateError(input.expectedStatus, request.status);
    }

    const transition = resolveRequestTransition(input.command, request.status, {
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    // CONSENT.md §3.10: evaluated before the mutation commits, every time — a
    // previous assignment never carries authority forward to a new one.
    if (transition.mayDiscloseExternally) {
      if (deps.disclosureGuard === undefined) {
        throw new DisclosureGuardRequiredError();
      }
      await deps.disclosureGuard({
        tenantId: input.tenantId,
        serviceRequestId: input.serviceRequestId,
        caseId: request.caseId,
        granteeId: input.granteeId ?? 'unspecified',
      });
    }

    const terminal = ['CLOSED', 'CANCELLED', 'EXPIRED', 'UNFULFILLABLE'].includes(transition.to);
    const updated = await tx.query<RequestRow>(
      `UPDATE service_requests
         SET status = $3::suas_service_request_status,
             updated_at = now(),
             status_reason = COALESCE($4, status_reason),
             submitted_at = CASE WHEN $3::text = 'SUBMITTED' THEN now() ELSE submitted_at END,
             terminal_at = CASE WHEN $5::boolean THEN now() ELSE terminal_at END
       WHERE tenant_id = $1 AND service_request_id = $2
       RETURNING ${REQUEST_COLUMNS}`,
      [input.tenantId, input.serviceRequestId, transition.to, input.reason ?? null, terminal],
    );
    const updatedRow = updated.rows[0];
    if (updatedRow === undefined) throw new ServiceRequestNotFoundError();

    if (input.command === 'ASSIGN') {
      await appendDomainEvent(tx, {
        eventType: 'SERVICE_REQUEST_ASSIGNED',
        aggregateType: 'ServiceRequest',
        aggregateId: input.serviceRequestId,
        tenantId: input.tenantId,
        actorType: input.actorType,
        actorId: input.actorId,
        payload: {
          case_id: request.caseId,
          category: request.category,
          ...(input.granteeId !== undefined ? { grantee_id: input.granteeId } : {}),
        },
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      });
    }

    return toRequest(updatedRow);
  });
}

export async function listCaseServiceRequests(
  db: Queryable,
  tenantId: string,
  caseId: string,
  limit = 50,
): Promise<ServiceRequest[]> {
  const result = await db.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM service_requests
     WHERE tenant_id = $1 AND case_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [tenantId, caseId, Math.min(limit, 100)],
  );
  return result.rows.map(toRequest);
}
