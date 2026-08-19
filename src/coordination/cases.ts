/**
 * Support Case commands.
 *
 * Spec citations:
 * - SUAS-specs CASES.md §3 (creation and deduplication), §3.1 (atomic creation
 *   invariant), §4 (transitions), §5 (atomic assignment and claim), §7
 *   (resolution and closure)
 * - SUAS-specs RESPONDER_WORKFLOWS.md §2 (named actions), §3 (idempotency and
 *   stale-state protection)
 * - SUAS-specs EVENT_MODEL.md §3 (`CASE_CREATED`, `CASE_ASSIGNED`,
 *   `CASE_ESCALATED`, `CASE_RESOLVED`)
 * - SUAS-specs DATA_MODEL.md §14 rule 6 (one active assignment where required)
 *
 * Contested commands hold a row lock on the case for the whole check-and-write,
 * so the state check and the winning write are one atomic unit (CASES.md §5.2).
 * The partial unique indexes are a second line of defence, not the only one.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendDomainEvent } from '../events/index.js';
import {
  resolveCaseTransition,
  StaleCaseStateError,
  type CaseCommand,
  type CaseStatus,
} from './case-transitions.js';

export interface SupportCase {
  readonly caseId: string;
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly status: CaseStatus;
  readonly prioritySignalLevel: string | undefined;
}

export interface CaseAssignment {
  readonly caseAssignmentId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly responderUserId: string;
  readonly status: 'ACTIVE' | 'RELEASED' | 'REASSIGNED';
}

interface CaseRow {
  case_id: string;
  tenant_id: string;
  veteran_user_id: string;
  status: CaseStatus;
  priority_signal_level: string | null;
}

interface AssignmentRow {
  case_assignment_id: string;
  tenant_id: string;
  case_id: string;
  responder_user_id: string;
  status: 'ACTIVE' | 'RELEASED' | 'REASSIGNED';
}

const CASE_COLUMNS = 'case_id, tenant_id, veteran_user_id, status, priority_signal_level';
const ASSIGNMENT_COLUMNS = 'case_assignment_id, tenant_id, case_id, responder_user_id, status';

function toCase(row: CaseRow): SupportCase {
  return {
    caseId: row.case_id,
    tenantId: row.tenant_id,
    veteranUserId: row.veteran_user_id,
    status: row.status,
    prioritySignalLevel: row.priority_signal_level ?? undefined,
  };
}

function toAssignment(row: AssignmentRow): CaseAssignment {
  return {
    caseAssignmentId: row.case_assignment_id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    responderUserId: row.responder_user_id,
    status: row.status,
  };
}

export class CaseNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Resource not found.');
    this.name = 'CaseNotFoundError';
  }
}

/** CASES.md §5.4: a losing contender receives a conflict with no partial effect. */
export class CaseAlreadyClaimedError extends Error {
  readonly code = 'ALREADY_CLAIMED';
  readonly httpStatus = 409;

  constructor() {
    super('This case already has an active assignment.');
    this.name = 'CaseAlreadyClaimedError';
  }
}

export class BlockingWorkError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(count: number) {
    super(
      `This case cannot be resolved while ${count} non-terminal Service Request(s) remain ` +
        `(SUAS-specs CASES.md §4, §7).`,
    );
    this.name = 'BlockingWorkError';
  }
}

export async function findCase(
  db: Queryable,
  tenantId: string,
  caseId: string,
): Promise<SupportCase | undefined> {
  const result = await db.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM support_cases WHERE tenant_id = $1 AND case_id = $2`,
    [tenantId, caseId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toCase(row);
}

export async function findActiveAssignment(
  db: Queryable,
  caseId: string,
): Promise<CaseAssignment | undefined> {
  const result = await db.query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM case_assignments
     WHERE case_id = $1 AND status = 'ACTIVE'`,
    [caseId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toAssignment(row);
}

export interface OpenCaseInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly prioritySignalLevel?: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED';
  readonly actorType: 'VETERAN' | 'RESPONDER' | 'SYSTEM';
  readonly actorId: string;
  readonly correlationId?: string;
}

export interface OpenCaseResult {
  readonly supportCase: SupportCase;
  /** False when an existing non-closed case was returned instead. */
  readonly created: boolean;
}

/**
 * Open a Support Case under the MVP one-active-case default.
 *
 * CASES.md §3.1: signal, event, and job delivery may be duplicated or
 * concurrent, so creation must not rely on "read no case → insert". The insert
 * races against a partial unique index; a loser resolves to the existing case
 * rather than creating a duplicate, and only the winner emits `CASE_CREATED`.
 */
export async function openCase(tx: PoolClient, input: OpenCaseInput): Promise<OpenCaseResult> {
  const caseId = randomUUID();

  const inserted = await tx.query<CaseRow>(
    `INSERT INTO support_cases (case_id, tenant_id, veteran_user_id, priority_signal_level)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING ${CASE_COLUMNS}`,
    [caseId, input.tenantId, input.veteranUserId, input.prioritySignalLevel ?? null],
  );

  const row = inserted.rows[0];
  if (row === undefined) {
    const existing = await tx.query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM support_cases
       WHERE tenant_id = $1 AND veteran_user_id = $2 AND status <> 'CLOSED'`,
      [input.tenantId, input.veteranUserId],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new Error(
        'Case creation conflicted but no existing non-closed case was found; ' +
          'this indicates a corrupted one-active-case index.',
      );
    }
    return { supportCase: toCase(existingRow), created: false };
  }

  await appendDomainEvent(tx, {
    eventType: 'CASE_CREATED',
    aggregateType: 'SupportCase',
    aggregateId: row.case_id,
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.actorId,
    payload: { veteran_user_id: input.veteranUserId },
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  return { supportCase: toCase(row), created: true };
}

/** Lock the case row for a contested command, and confirm the expected state. */
async function lockCase(
  tx: PoolClient,
  tenantId: string,
  caseId: string,
  expectedStatus?: CaseStatus,
): Promise<SupportCase> {
  const result = await tx.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM support_cases
     WHERE tenant_id = $1 AND case_id = $2
     FOR UPDATE`,
    [tenantId, caseId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new CaseNotFoundError();

  const supportCase = toCase(row);
  // RESPONDER_WORKFLOWS.md §3.1: the queue may be stale; the mutation-time check
  // is authoritative.
  if (expectedStatus !== undefined && supportCase.status !== expectedStatus) {
    throw new StaleCaseStateError(expectedStatus, supportCase.status);
  }
  return supportCase;
}

export interface ClaimCaseInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly responderUserId: string;
  /** Status the caller believed the case was in, from a possibly stale queue. */
  readonly expectedStatus?: CaseStatus;
  readonly correlationId?: string;
}

export interface AssignmentResult {
  readonly supportCase: SupportCase;
  readonly assignment: CaseAssignment;
}

/**
 * `CLAIM_CASE`. RESPONDER_WORKFLOWS.md §2, §5; CASES.md §5.
 *
 * The row lock serializes contenders: the first commits an assignment and moves
 * the case to `ASSIGNED`, and the second then finds a status with no documented
 * `CLAIM_CASE` edge and conflicts. Exactly one wins, and the loser writes
 * nothing.
 */
export async function claimCase(pool: Pool, input: ClaimCaseInput): Promise<AssignmentResult> {
  return withTransaction(pool, async (tx) => {
    const supportCase = await lockCase(tx, input.tenantId, input.caseId, input.expectedStatus);
    const transition = resolveCaseTransition('CLAIM_CASE', supportCase.status);

    if (await findActiveAssignment(tx, input.caseId)) {
      throw new CaseAlreadyClaimedError();
    }

    const assignment = await insertAssignment(tx, {
      tenantId: input.tenantId,
      caseId: input.caseId,
      responderUserId: input.responderUserId,
      assignedBy: input.responderUserId,
    });

    const updated = await setCaseStatus(tx, input.tenantId, input.caseId, transition.to);

    await appendDomainEvent(tx, {
      eventType: 'CASE_ASSIGNED',
      aggregateType: 'SupportCase',
      aggregateId: input.caseId,
      tenantId: input.tenantId,
      actorType: 'RESPONDER',
      actorId: input.responderUserId,
      payload: {
        case_assignment_id: assignment.caseAssignmentId,
        responder_user_id: input.responderUserId,
        command: 'CLAIM_CASE',
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return { supportCase: updated, assignment };
  });
}

export interface AssignCaseInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly responderUserId: string;
  readonly assignedBy: string;
  readonly expectedStatus?: CaseStatus;
  readonly correlationId?: string;
}

/**
 * `ASSIGN_CASE`, covering both first assignment and reassignment.
 *
 * CASES.md §5.7: reassignment releases the prior active assignment and creates
 * the successor in one transaction, so the case is never briefly ownerless and
 * never briefly doubly owned.
 */
export async function assignCase(pool: Pool, input: AssignCaseInput): Promise<AssignmentResult> {
  return withTransaction(pool, async (tx) => {
    const supportCase = await lockCase(tx, input.tenantId, input.caseId, input.expectedStatus);
    const transition = resolveCaseTransition('ASSIGN_CASE', supportCase.status);

    const current = await findActiveAssignment(tx, input.caseId);
    if (current !== undefined) {
      await tx.query(
        `UPDATE case_assignments
           SET status = 'REASSIGNED', released_at = now(), release_reason = 'REASSIGNED'
         WHERE case_assignment_id = $1`,
        [current.caseAssignmentId],
      );
    }

    const assignment = await insertAssignment(tx, {
      tenantId: input.tenantId,
      caseId: input.caseId,
      responderUserId: input.responderUserId,
      assignedBy: input.assignedBy,
    });

    const updated = await setCaseStatus(tx, input.tenantId, input.caseId, transition.to);

    await appendDomainEvent(tx, {
      eventType: 'CASE_ASSIGNED',
      aggregateType: 'SupportCase',
      aggregateId: input.caseId,
      tenantId: input.tenantId,
      actorType: 'ORG_ADMIN',
      actorId: input.assignedBy,
      payload: {
        case_assignment_id: assignment.caseAssignmentId,
        responder_user_id: input.responderUserId,
        command: 'ASSIGN_CASE',
        ...(current !== undefined ? { released_assignment_id: current.caseAssignmentId } : {}),
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return { supportCase: updated, assignment };
  });
}

async function insertAssignment(
  tx: Queryable,
  input: {
    tenantId: string;
    caseId: string;
    responderUserId: string;
    assignedBy: string;
  },
): Promise<CaseAssignment> {
  const result = await tx.query<AssignmentRow>(
    `INSERT INTO case_assignments
       (case_assignment_id, tenant_id, case_id, responder_user_id, assigned_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ASSIGNMENT_COLUMNS}`,
    [randomUUID(), input.tenantId, input.caseId, input.responderUserId, input.assignedBy],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Assignment insert returned no row.');
  return toAssignment(row);
}

async function setCaseStatus(
  tx: Queryable,
  tenantId: string,
  caseId: string,
  status: CaseStatus,
): Promise<SupportCase> {
  const result = await tx.query<CaseRow>(
    `UPDATE support_cases
       SET status = $3::suas_case_status,
           updated_at = now(),
           triaged_at = CASE WHEN $3::text = 'TRIAGED' THEN now() ELSE triaged_at END,
           resolved_at = CASE WHEN $3::text = 'RESOLVED' THEN now() ELSE resolved_at END,
           closed_at = CASE WHEN $3::text = 'CLOSED' THEN now() ELSE closed_at END
     WHERE tenant_id = $1 AND case_id = $2
     RETURNING ${CASE_COLUMNS}`,
    [tenantId, caseId, status],
  );
  const row = result.rows[0];
  if (row === undefined) throw new CaseNotFoundError();
  return toCase(row);
}

export interface CaseCommandInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly command: Exclude<CaseCommand, 'CLAIM_CASE' | 'ASSIGN_CASE' | 'RESOLVE'>;
  readonly actorId: string;
  readonly actorType: 'RESPONDER' | 'ORG_ADMIN' | 'SYSTEM';
  readonly reason?: string;
  readonly expectedStatus?: CaseStatus;
  readonly correlationId?: string;
}

/**
 * Execute a documented non-contested case transition.
 *
 * Commands that require an active assignment are refused when none exists,
 * which is what stops the CASES.md §4.1 mistake: an unassigned `OPEN` or
 * `TRIAGED` case has no assigned responder, so it cannot be escalated.
 */
export async function executeCaseCommand(
  pool: Pool,
  input: CaseCommandInput,
): Promise<SupportCase> {
  return withTransaction(pool, async (tx) => {
    const supportCase = await lockCase(tx, input.tenantId, input.caseId, input.expectedStatus);
    const transition = resolveCaseTransition(input.command, supportCase.status, {
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    if (transition.requiresActiveAssignment) {
      const assignment = await findActiveAssignment(tx, input.caseId);
      if (assignment === undefined) {
        throw new NoActiveAssignmentError(input.command);
      }
      if (
        transition.actors.includes('ASSIGNED_RESPONDER') &&
        input.actorType === 'RESPONDER' &&
        assignment.responderUserId !== input.actorId
      ) {
        throw new NotAssignedResponderError();
      }
    }

    // Closing ends the case cycle, so ownership ends with it. Otherwise a
    // reopened case would return to OPEN still owned by the previous responder,
    // and could never be claimed for the new cycle — CASES.md §4 has no
    // OPEN-with-active-assignment state. The assignment row is retained as
    // history (§7: closure retains all history). The released text does not say
    // this outright; see the Slice 6 conformance record.
    if (input.command === 'CLOSE') {
      const active = await findActiveAssignment(tx, input.caseId);
      if (active !== undefined) {
        await tx.query(
          `UPDATE case_assignments
             SET status = 'RELEASED', released_at = now(), release_reason = 'CASE_CLOSED'
           WHERE case_assignment_id = $1`,
          [active.caseAssignmentId],
        );
      }
    }

    const updated = await setCaseStatus(tx, input.tenantId, input.caseId, transition.to);

    if (input.command === 'ESCALATE') {
      await appendDomainEvent(tx, {
        eventType: 'CASE_ESCALATED',
        aggregateType: 'SupportCase',
        aggregateId: input.caseId,
        tenantId: input.tenantId,
        actorType: input.actorType,
        actorId: input.actorId,
        payload: { reason: input.reason ?? '', from_status: supportCase.status },
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      });
    }

    return updated;
  });
}

export class NoActiveAssignmentError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(command: string) {
    super(
      `"${command}" requires an active case assignment. An unassigned case has no assigned ` +
        `responder to perform it (SUAS-specs CASES.md §4.1; RESPONDER_WORKFLOWS.md §8).`,
    );
    this.name = 'NoActiveAssignmentError';
  }
}

export class NotAssignedResponderError extends Error {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('This action is reserved for the responder currently assigned to the case.');
    this.name = 'NotAssignedResponderError';
  }
}

/**
 * Whether a responder currently holds an active assignment for a veteran's case.
 *
 * This is the verifier CONSENT.md §3.6 needs: an assigned Responder's
 * least-privilege access is a documented basis, and Slice 4 denies it until
 * something can confirm the assignment. This is that something.
 */
export function createAssignmentVerifier(pool: Pool) {
  return async (params: {
    tenantId: string;
    responderUserId: string;
    veteranUserId: string;
  }): Promise<boolean> => {
    const result = await pool.query(
      `SELECT 1
       FROM case_assignments a
       JOIN support_cases c ON c.case_id = a.case_id
       WHERE a.tenant_id = $1
         AND a.responder_user_id = $2
         AND a.status = 'ACTIVE'
         AND c.veteran_user_id = $3
         AND c.status <> 'CLOSED'`,
      [params.tenantId, params.responderUserId, params.veteranUserId],
    );
    return (result.rowCount ?? 0) > 0;
  };
}
