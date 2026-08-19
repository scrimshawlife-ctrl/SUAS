/**
 * Follow-Ups.
 *
 * Spec citations:
 * - SUAS-specs FOLLOWUP.md §1 (a Follow-Up is not a note, notification, contact
 *   attempt, or Settlement), §2 (states), §3 (required fields), §4 (coordination
 *   retry semantics), §5 (durable due/overdue jobs), §6 (completion, reschedule,
 *   cancellation), §7 (escalation), §8 (Case interaction), §9 (events), §10
 *   (non-goals)
 * - SUAS-specs SETTLEMENT.md §4 (blocking vs carried-forward)
 * - SUAS-specs DATA_MODEL.md §6; EVENT_MODEL.md §3
 *
 * Only three Domain Events exist for Follow-Ups: `FOLLOWUP_CREATED`,
 * `FOLLOWUP_DUE`, `FOLLOWUP_COMPLETED`. FOLLOWUP.md §9 states that OVERDUE,
 * RESCHEDULED, ESCALATED, and CANCELLED are audited, and that additional Domain
 * Event names require explicit catalog reconciliation — so this module writes
 * Audit Events for those and invents nothing.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendAuditEvent, appendDomainEvent } from '../events/index.js';

export const FOLLOW_UP_STATUSES = [
  'SCHEDULED',
  'DUE',
  'COMPLETED',
  'RESCHEDULED',
  'OVERDUE',
  'ESCALATED',
  'CANCELLED',
] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const RESPONSIBLE_TYPES = ['RESPONDER', 'VETERAN', 'ORG_ADMIN', 'SYSTEM'] as const;
export type ResponsibleType = (typeof RESPONSIBLE_TYPES)[number];

/** SETTLEMENT.md §4. `undefined` means unclassified, which blocks resolution. */
export const RESOLUTION_DISPOSITIONS = ['BLOCKING', 'CARRIED_FORWARD'] as const;
export type ResolutionDisposition = (typeof RESOLUTION_DISPOSITIONS)[number];

/** Statuses in which work remains open. FOLLOWUP.md §8. */
export const OPEN_FOLLOW_UP_STATUSES: readonly FollowUpStatus[] = [
  'SCHEDULED',
  'DUE',
  'OVERDUE',
  'ESCALATED',
  'RESCHEDULED',
];

export interface FollowUp {
  readonly followUpId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly serviceRequestId: string | undefined;
  readonly dueAt: Date;
  readonly scheduleVersion: number;
  readonly responsibleType: ResponsibleType;
  readonly responsibleId: string;
  readonly status: FollowUpStatus;
  /** Coordination attempts, never notification or job retries. FOLLOWUP.md §4. */
  readonly coordinationAttemptCount: number;
  readonly resolutionDisposition: ResolutionDisposition | undefined;
}

interface FollowUpRow {
  follow_up_id: string;
  tenant_id: string;
  case_id: string;
  service_request_id: string | null;
  due_at: Date;
  schedule_version: number;
  responsible_type: ResponsibleType;
  responsible_id: string;
  status: FollowUpStatus;
  coordination_attempt_count: number;
  resolution_disposition: ResolutionDisposition | null;
}

const FOLLOW_UP_COLUMNS = `
  follow_up_id, tenant_id, case_id, service_request_id, due_at, schedule_version,
  responsible_type, responsible_id, status, coordination_attempt_count,
  resolution_disposition
`;

function toFollowUp(row: FollowUpRow): FollowUp {
  return {
    followUpId: row.follow_up_id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    serviceRequestId: row.service_request_id ?? undefined,
    dueAt: row.due_at,
    scheduleVersion: row.schedule_version,
    responsibleType: row.responsible_type,
    responsibleId: row.responsible_id,
    status: row.status,
    coordinationAttemptCount: row.coordination_attempt_count,
    resolutionDisposition: row.resolution_disposition ?? undefined,
  };
}

export class FollowUpValidationError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor(message: string) {
    super(message);
    this.name = 'FollowUpValidationError';
  }
}

export class FollowUpNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Resource not found.');
    this.name = 'FollowUpNotFoundError';
  }
}

export interface CreateFollowUpInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly dueAt: Date;
  readonly responsibleType: ResponsibleType;
  readonly responsibleId: string;
  readonly serviceRequestId?: string;
  readonly resolutionDisposition?: ResolutionDisposition;
  readonly actorId: string;
  readonly actorType: 'RESPONDER' | 'ORG_ADMIN' | 'SYSTEM';
  readonly correlationId?: string;
}

/**
 * Create a Follow-Up and emit `FOLLOWUP_CREATED`.
 *
 * FOLLOWUP.md §3 and §11: creation without `due_at` or a responsible party
 * fails. The disposition may be left unset here — SETTLEMENT.md §4 then refuses
 * to resolve the Case until someone classifies it.
 */
export async function createFollowUp(pool: Pool, input: CreateFollowUpInput): Promise<FollowUp> {
  if (!(input.dueAt instanceof Date) || Number.isNaN(input.dueAt.getTime())) {
    throw new FollowUpValidationError('A Follow-Up requires a valid due_at (FOLLOWUP.md §3).');
  }
  if (input.responsibleId.trim() === '') {
    throw new FollowUpValidationError('A Follow-Up requires a responsible party (FOLLOWUP.md §3).');
  }

  return withTransaction(pool, async (tx) => {
    const followUpId = randomUUID();
    const result = await tx.query<FollowUpRow>(
      `INSERT INTO follow_ups
         (follow_up_id, tenant_id, case_id, service_request_id, due_at,
          responsible_type, responsible_id, resolution_disposition)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${FOLLOW_UP_COLUMNS}`,
      [
        followUpId,
        input.tenantId,
        input.caseId,
        input.serviceRequestId ?? null,
        input.dueAt,
        input.responsibleType,
        input.responsibleId,
        input.resolutionDisposition ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Follow-up insert returned no row.');

    await appendDomainEvent(tx, {
      eventType: 'FOLLOWUP_CREATED',
      aggregateType: 'FollowUp',
      aggregateId: followUpId,
      tenantId: input.tenantId,
      actorType: input.actorType,
      actorId: input.actorId,
      payload: {
        case_id: input.caseId,
        due_at: input.dueAt.toISOString(),
        responsible_type: input.responsibleType,
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return toFollowUp(row);
  });
}

export async function findFollowUp(
  db: Queryable,
  tenantId: string,
  followUpId: string,
): Promise<FollowUp | undefined> {
  const result = await db.query<FollowUpRow>(
    `SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups
     WHERE tenant_id = $1 AND follow_up_id = $2`,
    [tenantId, followUpId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toFollowUp(row);
}

export async function listOpenFollowUps(
  db: Queryable,
  tenantId: string,
  caseId: string,
): Promise<FollowUp[]> {
  const result = await db.query<FollowUpRow>(
    `SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups
     WHERE tenant_id = $1 AND case_id = $2
       AND status = ANY($3::suas_follow_up_status[])
     ORDER BY due_at`,
    [tenantId, caseId, OPEN_FOLLOW_UP_STATUSES],
  );
  return result.rows.map(toFollowUp);
}

export interface DueWorkItem {
  readonly followUpId: string;
  /** The version the job expects. A reschedule makes this stale. */
  readonly scheduleVersion: number;
}

export interface DueSweepResult {
  readonly marked: readonly string[];
  readonly stale: readonly string[];
}

/**
 * Mark a Follow-Up due.
 *
 * FOLLOWUP.md §5: the state and current `due_at` are re-checked atomically at
 * mutation time, and only the first logical transition emits `FOLLOWUP_DUE`. The
 * `schedule_version` predicate is what makes a stale job harmless — a reschedule
 * bumped the version, so the old job's update matches nothing.
 */
export async function markFollowUpDue(
  pool: Pool,
  tenantId: string,
  item: DueWorkItem,
): Promise<{ transitioned: boolean; reason?: string }> {
  return withTransaction(pool, async (tx) => {
    const result = await tx.query<FollowUpRow>(
      `UPDATE follow_ups
         SET status = 'DUE', due_marked_at = now(), updated_at = now()
       WHERE tenant_id = $1
         AND follow_up_id = $2
         AND schedule_version = $3
         AND status = 'SCHEDULED'
         AND due_at <= now()
       RETURNING ${FOLLOW_UP_COLUMNS}`,
      [tenantId, item.followUpId, item.scheduleVersion],
    );

    const row = result.rows[0];
    if (row === undefined) {
      // Stale, already transitioned, or not yet due. All are no-ops, and the
      // suppression is recorded so a delayed scan is observable (§5.6).
      await recordFollowUpAudit(tx, {
        tenantId,
        followUpId: item.followUpId,
        action: 'FOLLOWUP_DUE_JOB_SUPPRESSED',
        payload: { expected_schedule_version: item.scheduleVersion },
      });
      return { transitioned: false, reason: 'STALE_OR_NOT_APPLICABLE' };
    }

    await appendDomainEvent(tx, {
      eventType: 'FOLLOWUP_DUE',
      aggregateType: 'FollowUp',
      aggregateId: item.followUpId,
      tenantId,
      actorType: 'SYSTEM',
      actorId: 'follow-up-scheduler',
      payload: { case_id: row.case_id, schedule_version: row.schedule_version },
      // Duplicate job delivery resolves to the persisted event rather than
      // emitting a second logical due fact (FOLLOWUP.md §5.1, §5.4).
      idempotencyKey: `follow-up-due:${item.followUpId}:${item.scheduleVersion}`,
    });

    return { transitioned: true };
  });
}

/**
 * Mark a Follow-Up overdue.
 *
 * FOLLOWUP.md §9: `OVERDUE` has no Domain Event in the released catalog, so this
 * writes an Audit Event only. Inventing `FOLLOWUP_OVERDUE` would be an
 * unreconciled catalog addition.
 */
export async function markFollowUpOverdue(
  pool: Pool,
  tenantId: string,
  item: DueWorkItem,
): Promise<{ transitioned: boolean }> {
  return withTransaction(pool, async (tx) => {
    const result = await tx.query<FollowUpRow>(
      `UPDATE follow_ups
         SET status = 'OVERDUE', overdue_marked_at = now(), updated_at = now()
       WHERE tenant_id = $1
         AND follow_up_id = $2
         AND schedule_version = $3
         AND status IN ('SCHEDULED', 'DUE')
         AND due_at <= now()
       RETURNING ${FOLLOW_UP_COLUMNS}`,
      [tenantId, item.followUpId, item.scheduleVersion],
    );

    const row = result.rows[0];
    if (row === undefined) {
      await recordFollowUpAudit(tx, {
        tenantId,
        followUpId: item.followUpId,
        action: 'FOLLOWUP_OVERDUE_JOB_SUPPRESSED',
        payload: { expected_schedule_version: item.scheduleVersion },
      });
      return { transitioned: false };
    }

    await recordFollowUpAudit(tx, {
      tenantId,
      followUpId: item.followUpId,
      action: 'FOLLOWUP_OVERDUE',
      payload: { case_id: row.case_id, schedule_version: row.schedule_version },
    });
    return { transitioned: true };
  });
}

/** Durable work due now, for a scheduler to hand to the mark functions. */
export async function claimDueWork(
  db: Queryable,
  limit = 50,
): Promise<{ tenantId: string; item: DueWorkItem }[]> {
  const result = await db.query<{
    tenant_id: string;
    follow_up_id: string;
    schedule_version: number;
  }>(
    `SELECT tenant_id, follow_up_id, schedule_version
     FROM follow_ups
     WHERE status = 'SCHEDULED' AND due_at <= now()
     ORDER BY due_at, follow_up_id
     LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return result.rows.map((row) => ({
    tenantId: row.tenant_id,
    item: { followUpId: row.follow_up_id, scheduleVersion: row.schedule_version },
  }));
}

export interface CompleteFollowUpInput {
  readonly tenantId: string;
  readonly followUpId: string;
  readonly actorId: string;
  readonly actorType: 'RESPONDER' | 'VETERAN' | 'ORG_ADMIN' | 'SYSTEM';
  readonly correlationId?: string;
}

/**
 * Complete a Follow-Up.
 * FOLLOWUP.md §6: actor and `completed_at` are required, duplicate completion is
 * idempotent, and exactly one logical `FOLLOWUP_COMPLETED` is emitted.
 */
export async function completeFollowUp(
  pool: Pool,
  input: CompleteFollowUpInput,
): Promise<{ followUp: FollowUp; alreadyCompleted: boolean }> {
  return withTransaction(pool, async (tx) => {
    const current = await tx.query<FollowUpRow>(
      `SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups
       WHERE tenant_id = $1 AND follow_up_id = $2
       FOR UPDATE`,
      [input.tenantId, input.followUpId],
    );
    const existing = current.rows[0];
    if (existing === undefined) throw new FollowUpNotFoundError();

    if (existing.status === 'COMPLETED') {
      return { followUp: toFollowUp(existing), alreadyCompleted: true };
    }
    if (existing.status === 'CANCELLED') {
      throw new FollowUpValidationError('A cancelled Follow-Up cannot be completed.');
    }

    const updated = await tx.query<FollowUpRow>(
      `UPDATE follow_ups
         SET status = 'COMPLETED', completed_at = now(), completed_by = $3, updated_at = now()
       WHERE tenant_id = $1 AND follow_up_id = $2
       RETURNING ${FOLLOW_UP_COLUMNS}`,
      [input.tenantId, input.followUpId, input.actorId],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new FollowUpNotFoundError();

    await appendDomainEvent(tx, {
      eventType: 'FOLLOWUP_COMPLETED',
      aggregateType: 'FollowUp',
      aggregateId: input.followUpId,
      tenantId: input.tenantId,
      actorType: input.actorType,
      actorId: input.actorId,
      payload: { case_id: row.case_id },
      idempotencyKey: `follow-up-completed:${input.followUpId}`,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return { followUp: toFollowUp(row), alreadyCompleted: false };
  });
}

/**
 * Reschedule a Follow-Up.
 *
 * FOLLOWUP.md §6: reason and a new `due_at` are required, and the new schedule
 * gets a new durable due-work identity so old queued work becomes stale — which
 * is the `schedule_version` bump.
 *
 * The status returns to `SCHEDULED` rather than resting in the released
 * `RESCHEDULED` value: a Follow-Up parked in `RESCHEDULED` would never be picked
 * up by the due sweep, which selects `SCHEDULED`. The reschedule itself is
 * recorded as an audited fact. See the Slice 6 conformance record, which returns
 * this to specs.
 */
export async function rescheduleFollowUp(
  pool: Pool,
  input: {
    tenantId: string;
    followUpId: string;
    newDueAt: Date;
    reason: string;
    actorId: string;
    actorType: 'RESPONDER' | 'ORG_ADMIN' | 'SYSTEM';
  },
): Promise<FollowUp> {
  if (input.reason.trim() === '') {
    throw new FollowUpValidationError(
      'Rescheduling a Follow-Up requires a reason (FOLLOWUP.md §6).',
    );
  }

  return withTransaction(pool, async (tx) => {
    const result = await tx.query<FollowUpRow>(
      `UPDATE follow_ups
         SET due_at = $3,
             schedule_version = schedule_version + 1,
             status = 'SCHEDULED',
             last_reschedule_reason = $4,
             due_marked_at = NULL,
             overdue_marked_at = NULL,
             updated_at = now()
       WHERE tenant_id = $1 AND follow_up_id = $2
         AND status <> ALL(ARRAY['COMPLETED', 'CANCELLED']::suas_follow_up_status[])
       RETURNING ${FOLLOW_UP_COLUMNS}`,
      [input.tenantId, input.followUpId, input.newDueAt, input.reason],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new FollowUpValidationError(
        'Only an open Follow-Up can be rescheduled (FOLLOWUP.md §6).',
      );
    }

    await recordFollowUpAudit(tx, {
      tenantId: input.tenantId,
      followUpId: input.followUpId,
      action: 'FOLLOWUP_RESCHEDULED',
      actorId: input.actorId,
      payload: {
        new_due_at: input.newDueAt.toISOString(),
        schedule_version: row.schedule_version,
        reason: input.reason,
      },
    });

    return toFollowUp(row);
  });
}

/**
 * Cancel a Follow-Up.
 * FOLLOWUP.md §6: reason and actor required, explicit rather than inferred from
 * Case close, and duplicate cancellation is idempotent.
 */
export async function cancelFollowUp(
  pool: Pool,
  input: {
    tenantId: string;
    followUpId: string;
    reason: string;
    actorId: string;
  },
): Promise<{ followUp: FollowUp; alreadyCancelled: boolean }> {
  if (input.reason.trim() === '') {
    throw new FollowUpValidationError('Cancelling a Follow-Up requires a reason (FOLLOWUP.md §6).');
  }

  return withTransaction(pool, async (tx) => {
    const current = await tx.query<FollowUpRow>(
      `SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups
       WHERE tenant_id = $1 AND follow_up_id = $2
       FOR UPDATE`,
      [input.tenantId, input.followUpId],
    );
    const existing = current.rows[0];
    if (existing === undefined) throw new FollowUpNotFoundError();
    if (existing.status === 'CANCELLED') {
      return { followUp: toFollowUp(existing), alreadyCancelled: true };
    }

    const updated = await tx.query<FollowUpRow>(
      `UPDATE follow_ups
         SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $3, updated_at = now()
       WHERE tenant_id = $1 AND follow_up_id = $2
       RETURNING ${FOLLOW_UP_COLUMNS}`,
      [input.tenantId, input.followUpId, input.reason],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new FollowUpNotFoundError();

    await recordFollowUpAudit(tx, {
      tenantId: input.tenantId,
      followUpId: input.followUpId,
      action: 'FOLLOWUP_CANCELLED',
      actorId: input.actorId,
      payload: { reason: input.reason },
    });

    return { followUp: toFollowUp(row), alreadyCancelled: false };
  });
}

/** Classify an open Follow-Up. SETTLEMENT.md §4 requires this before resolution. */
export async function setResolutionDisposition(
  pool: Pool,
  input: {
    tenantId: string;
    followUpId: string;
    disposition: ResolutionDisposition;
  },
): Promise<FollowUp | undefined> {
  const result = await pool.query<FollowUpRow>(
    `UPDATE follow_ups
       SET resolution_disposition = $3::suas_resolution_disposition, updated_at = now()
     WHERE tenant_id = $1 AND follow_up_id = $2
     RETURNING ${FOLLOW_UP_COLUMNS}`,
    [input.tenantId, input.followUpId, input.disposition],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toFollowUp(row);
}

/**
 * Record a coordination attempt.
 *
 * FOLLOWUP.md §4: this counter means a responder tried the required check-back
 * and could not complete it. Notification send retries, webhook retries, queue
 * redelivery, and worker replay must never reach this function.
 */
export async function recordCoordinationAttempt(
  pool: Pool,
  tenantId: string,
  followUpId: string,
): Promise<number> {
  const result = await pool.query<{ coordination_attempt_count: number }>(
    `UPDATE follow_ups
       SET coordination_attempt_count = coordination_attempt_count + 1, updated_at = now()
     WHERE tenant_id = $1 AND follow_up_id = $2
     RETURNING coordination_attempt_count`,
    [tenantId, followUpId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FollowUpNotFoundError();
  return row.coordination_attempt_count;
}

async function recordFollowUpAudit(
  tx: Queryable,
  input: {
    tenantId: string;
    followUpId: string;
    action: string;
    actorId?: string;
    payload: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await appendAuditEvent(tx, {
    eventType: input.action,
    action: input.action,
    targetType: 'FollowUp',
    targetId: input.followUpId,
    aggregateType: 'FollowUp',
    aggregateId: input.followUpId,
    tenantId: input.tenantId,
    actorType: input.actorId === undefined ? 'SYSTEM' : 'RESPONDER',
    actorId: input.actorId ?? 'follow-up-scheduler',
    payload: input.payload,
  });
}
