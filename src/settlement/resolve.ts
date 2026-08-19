/**
 * Case resolution with Settlement.
 *
 * Spec citations:
 * - SUAS-specs SETTLEMENT.md §1 (a Case cannot enter RESOLVED without a
 *   Settlement), §4 (blocking vs carried-forward Follow-Up; a Case cannot resolve
 *   with an unclassified open Follow-Up), §5 (validation and idempotency)
 * - SUAS-specs FOLLOWUP.md §8 (a Case cannot resolve while a blocking Follow-Up
 *   remains open; Case close never auto-completes a Follow-Up)
 * - SUAS-specs CASES.md §4, §7 (resolution prerequisites)
 * - SUAS-specs EVENT_MODEL.md §3 (`CASE_RESOLVED`)
 *
 * This replaces the fail-closed `resolveCase` seam Slice 5 installed: resolution
 * now creates the Settlement itself rather than asking an absent verifier whether
 * one exists.
 */

import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { appendDomainEvent } from '../events/index.js';
import { runIdempotentCommand, commandScope, fingerprintRequest } from '../idempotency/index.js';
import type { JsonObject } from '../jobs/index.js';
import {
  BlockingWorkError,
  CaseNotFoundError,
  findActiveAssignment,
  findCase,
  NoActiveAssignmentError,
  resolveCaseTransition,
  StaleCaseStateError,
  TERMINAL_REQUEST_STATUSES,
  type CaseStatus,
  type SupportCase,
} from '../coordination/index.js';
import { listOpenFollowUps, type FollowUp } from './follow-ups.js';
import {
  assertSettlementContent,
  createSettlement,
  findSettlement,
  nextResolutionCycle,
  type Settlement,
  type SettlementContent,
} from './settlements.js';

/** SETTLEMENT.md §4: a Case cannot resolve with an unclassified open Follow-Up. */
export class UnclassifiedFollowUpError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(count: number) {
    super(
      `${count} open Follow-Up(s) are not classified as BLOCKING or CARRIED_FORWARD, so this ` +
        `Case cannot be resolved (SUAS-specs SETTLEMENT.md §4).`,
    );
    this.name = 'UnclassifiedFollowUpError';
  }
}

export class BlockingFollowUpError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(count: number) {
    super(
      `${count} blocking Follow-Up(s) must be completed or cancelled before this Case can be ` +
        `resolved (SUAS-specs FOLLOWUP.md §8; SETTLEMENT.md §4).`,
    );
    this.name = 'BlockingFollowUpError';
  }
}

export interface ResolveCaseInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly actorId: string;
  readonly content: SettlementContent;
  readonly expectedStatus?: CaseStatus;
  /**
   * Makes the command replay-safe. SETTLEMENT.md §5.3: replaying the same logical
   * resolve must not create a duplicate Settlement or `CASE_RESOLVED` event.
   */
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
}

export interface ResolveCaseResult {
  readonly supportCase: SupportCase;
  readonly settlement: Settlement;
  /** True when a replay returned the original outcome. */
  readonly replayed: boolean;
}

/** Carried-forward Follow-Ups are recorded on the Settlement with owner and due date. */
function carriedForwardReference(followUp: FollowUp): JsonObject {
  return {
    follow_up_id: followUp.followUpId,
    due_at: followUp.dueAt.toISOString(),
    responsible_type: followUp.responsibleType,
    responsible_id: followUp.responsibleId,
    status: followUp.status,
  };
}

async function resolveInTransaction(
  tx: PoolClient,
  input: ResolveCaseInput,
): Promise<{ supportCase: SupportCase; settlement: Settlement }> {
  // Validate content before touching anything, so an incomplete Settlement never
  // leaves a partially resolved case behind.
  assertSettlementContent(input.content);

  const locked = await tx.query<{
    case_id: string;
    tenant_id: string;
    veteran_user_id: string;
    status: CaseStatus;
    priority_signal_level: string | null;
  }>(
    `SELECT case_id, tenant_id, veteran_user_id, status, priority_signal_level
     FROM support_cases
     WHERE tenant_id = $1 AND case_id = $2
     FOR UPDATE`,
    [input.tenantId, input.caseId],
  );
  const row = locked.rows[0];
  if (row === undefined) throw new CaseNotFoundError();

  // SETTLEMENT.md §5.4: a stale resolve cannot resolve a Case whose state moved
  // after the command's expected state.
  if (input.expectedStatus !== undefined && row.status !== input.expectedStatus) {
    throw new StaleCaseStateError(input.expectedStatus, row.status);
  }

  const transition = resolveCaseTransition('RESOLVE', row.status);

  const assignment = await findActiveAssignment(tx, input.caseId);
  if (assignment === undefined) throw new NoActiveAssignmentError('RESOLVE');

  // CASES.md §7: blocking Service Requests must be terminal.
  const blockingRequests = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM service_requests
     WHERE case_id = $1 AND status <> ALL($2::suas_service_request_status[])`,
    [input.caseId, TERMINAL_REQUEST_STATUSES],
  );
  const blockingCount = Number.parseInt(blockingRequests.rows[0]?.count ?? '0', 10);
  if (blockingCount > 0) throw new BlockingWorkError(blockingCount);

  // FOLLOWUP.md §8 and SETTLEMENT.md §4, evaluated in that order: an
  // unclassified Follow-Up is refused before a blocking one, because the
  // classification is what makes the blocking question answerable at all.
  const openFollowUps = await listOpenFollowUps(tx, input.tenantId, input.caseId);
  const unclassified = openFollowUps.filter(
    (followUp) => followUp.resolutionDisposition === undefined,
  );
  if (unclassified.length > 0) throw new UnclassifiedFollowUpError(unclassified.length);

  const blocking = openFollowUps.filter(
    (followUp) => followUp.resolutionDisposition === 'BLOCKING',
  );
  if (blocking.length > 0) throw new BlockingFollowUpError(blocking.length);

  const carriedForward = openFollowUps.filter(
    (followUp) => followUp.resolutionDisposition === 'CARRIED_FORWARD',
  );

  const cycle = await nextResolutionCycle(tx, input.caseId);
  const settlement = await createSettlement(tx, {
    tenantId: input.tenantId,
    caseId: input.caseId,
    resolutionCycle: cycle,
    content: input.content,
    remainingFollowUps: carriedForward.map(carriedForwardReference),
  });

  const updated = await tx.query<{
    case_id: string;
    tenant_id: string;
    veteran_user_id: string;
    status: CaseStatus;
    priority_signal_level: string | null;
  }>(
    `UPDATE support_cases
       SET status = $3::suas_case_status,
           current_settlement_id = $4,
           resolved_at = now(),
           updated_at = now()
     WHERE tenant_id = $1 AND case_id = $2
     RETURNING case_id, tenant_id, veteran_user_id, status, priority_signal_level`,
    [input.tenantId, input.caseId, transition.to, settlement.settlementId],
  );
  const updatedRow = updated.rows[0];
  if (updatedRow === undefined) throw new CaseNotFoundError();

  // SETTLEMENT.md §8: CASE_RESOLVED identifies the Case and its resolution cycle.
  await appendDomainEvent(tx, {
    eventType: 'CASE_RESOLVED',
    aggregateType: 'SupportCase',
    aggregateId: input.caseId,
    tenantId: input.tenantId,
    actorType: 'RESPONDER',
    actorId: input.actorId,
    payload: {
      settlement_id: settlement.settlementId,
      resolution_cycle: settlement.resolutionCycle,
      carried_forward_follow_ups: carriedForward.length,
    },
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  return {
    supportCase: {
      caseId: updatedRow.case_id,
      tenantId: updatedRow.tenant_id,
      veteranUserId: updatedRow.veteran_user_id,
      status: updatedRow.status,
      prioritySignalLevel: updatedRow.priority_signal_level ?? undefined,
    },
    settlement,
  };
}

/**
 * Resolve a Case, creating the Settlement for this resolution cycle.
 *
 * With an idempotency key the whole command replays through the Slice 2 kernel,
 * so a retried resolve returns the original Settlement rather than opening a
 * second cycle (SETTLEMENT.md §5.3).
 */
export async function resolveCaseWithSettlement(
  pool: Pool,
  input: ResolveCaseInput,
): Promise<ResolveCaseResult> {
  if (input.idempotencyKey === undefined) {
    const outcome = await withTransaction(pool, (tx) => resolveInTransaction(tx, input));
    return { ...outcome, replayed: false };
  }

  const scope = commandScope({
    command: 'POST /cases/{id}/commands/resolve',
    aggregateType: 'SupportCase',
    aggregateId: input.caseId,
  });

  const run = await runIdempotentCommand(
    pool,
    {
      tenantId: input.tenantId,
      commandScope: scope,
      idempotencyKey: input.idempotencyKey,
      // The fingerprint covers what makes this resolve distinct; a retry with a
      // different Settlement body is a conflicting reuse, not a replay.
      requestFingerprint: fingerprintRequest({
        case_id: input.caseId,
        authored_by: input.content.authoredBy,
        responder_confirmed_by: input.content.responderConfirmedBy,
        summaries: JSON.stringify([
          input.content.requested,
          input.content.occurred,
          input.content.fulfilled,
          input.content.unresolved,
        ]),
      }),
    },
    async (tx) => {
      const outcome = await resolveInTransaction(tx, input);
      return {
        result: {
          settlement_id: outcome.settlement.settlementId,
          resolution_cycle: outcome.settlement.resolutionCycle,
        },
        aggregateType: 'SupportCase',
        aggregateId: input.caseId,
      };
    },
  );

  const settlementId = run.result.settlement_id;
  if (typeof settlementId !== 'string') {
    throw new Error('Resolve command result did not carry a settlement id.');
  }

  const settlement = await findSettlement(pool, input.tenantId, settlementId);
  if (settlement === undefined) {
    throw new Error('Resolve command referenced a settlement that no longer exists.');
  }

  const supportCase = await findCase(pool, input.tenantId, input.caseId);
  if (supportCase === undefined) throw new CaseNotFoundError();

  return { supportCase, settlement, replayed: run.replayed };
}
