/**
 * Contact log and Case Notes.
 *
 * Spec citations:
 * - SUAS-specs RESPONDER_WORKFLOWS.md §2 (`CONTACT_ATTEMPT`, `CONTACT_COMPLETE`,
 *   `ADD_NOTE`), §7 (contact log commands; a Case Note is not a substitute)
 * - SUAS-specs EVENT_MODEL.md §3.3 (`RESPONDER_CONTACT_LOGGED` required payload,
 *   and "A Case Note create must not emit this event")
 * - SUAS-specs CASES.md §6 (a Case Note is not a transition, Follow-Up, or
 *   Contact Attempt)
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendDomainEvent } from '../events/index.js';
import { findActiveAssignment, NoActiveAssignmentError } from './cases.js';

/** EVENT_MODEL.md §3.3 `channel`. */
export const CONTACT_CHANNELS = ['EMAIL', 'SMS', 'IN_APP', 'PHONE'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** EVENT_MODEL.md §3.3 `outcome`. */
export const CONTACT_OUTCOMES = [
  'PENDING',
  'REACHED',
  'NO_ANSWER',
  'LEFT_MESSAGE',
  'DECLINED',
  'UNABLE',
] as const;
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

/** The two commands that produce a contact fact. RESPONDER_WORKFLOWS.md §7. */
export type ContactCommand = 'log-contact-attempt' | 'complete-contact';

export interface ContactAttempt {
  readonly contactAttemptId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly responderUserId: string;
  readonly attemptedAt: Date;
  readonly channel: ContactChannel;
  readonly outcome: ContactOutcome;
}

interface ContactRow {
  contact_attempt_id: string;
  tenant_id: string;
  case_id: string;
  responder_user_id: string;
  attempted_at: Date;
  channel: ContactChannel;
  outcome: ContactOutcome;
}

const CONTACT_COLUMNS = `
  contact_attempt_id, tenant_id, case_id, responder_user_id, attempted_at, channel, outcome
`;

function toContactAttempt(row: ContactRow): ContactAttempt {
  return {
    contactAttemptId: row.contact_attempt_id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    responderUserId: row.responder_user_id,
    attemptedAt: row.attempted_at,
    channel: row.channel,
    outcome: row.outcome,
  };
}

/** RESPONDER_WORKFLOWS.md §2: `CONTACT_COMPLETE` requires `outcome != PENDING`. */
export class ContactOutcomeRequiredError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor() {
    super(
      '"complete-contact" requires a settled outcome; PENDING is only valid for ' +
        '"log-contact-attempt" (SUAS-specs RESPONDER_WORKFLOWS.md §2).',
    );
    this.name = 'ContactOutcomeRequiredError';
  }
}

export interface RecordContactInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly responderUserId: string;
  readonly command: ContactCommand;
  readonly channel: ContactChannel;
  readonly outcome: ContactOutcome;
  readonly attemptedAt?: Date;
  readonly note?: string;
  /**
   * Stable logical identity for the contact fact. RESPONDER_WORKFLOWS.md §7:
   * duplicate command replay must not create duplicate logical contact facts
   * when the same key is reused.
   */
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
}

export interface RecordContactResult {
  readonly contactAttempt: ContactAttempt;
  /** True when a replay resolved to the already-recorded fact. */
  readonly deduplicated: boolean;
}

/**
 * Record a contact attempt and emit `RESPONDER_CONTACT_LOGGED`.
 *
 * Requires an active assignment (RESPONDER_WORKFLOWS.md §2). The Domain Event
 * carries the payload EVENT_MODEL.md §3.3 requires, including which of the two
 * commands produced it.
 */
export async function recordContact(
  pool: Pool,
  input: RecordContactInput,
): Promise<RecordContactResult> {
  if (input.command === 'complete-contact' && input.outcome === 'PENDING') {
    throw new ContactOutcomeRequiredError();
  }

  return withTransaction(pool, async (tx) => {
    const assignment = await findActiveAssignment(tx, input.caseId);
    if (assignment === undefined) {
      throw new NoActiveAssignmentError(input.command);
    }

    const attemptedAt = input.attemptedAt ?? new Date();
    const contactAttemptId = randomUUID();

    // The event carries the idempotency key, so a replayed command resolves to
    // the persisted event instead of emitting a second logical contact fact
    // (EVENT_MODEL.md §2.1).
    const eventResult = await appendDomainEvent(tx, {
      eventType: 'RESPONDER_CONTACT_LOGGED',
      aggregateType: 'SupportCase',
      aggregateId: input.caseId,
      tenantId: input.tenantId,
      actorType: 'RESPONDER',
      actorId: input.responderUserId,
      payload: {
        contact_attempt_id: contactAttemptId,
        at: attemptedAt.toISOString(),
        channel: input.channel,
        outcome: input.outcome,
        actor_id: input.responderUserId,
        command: input.command,
      },
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    if (eventResult.deduplicated) {
      // A replay: return the contact fact the original command created rather
      // than inserting a second row.
      const originalId = eventResult.event.payload.contact_attempt_id;
      const existing = await tx.query<ContactRow>(
        `SELECT ${CONTACT_COLUMNS} FROM contact_attempts WHERE contact_attempt_id = $1`,
        [originalId],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error('Contact event was deduplicated but its contact attempt is missing.');
      }
      return { contactAttempt: toContactAttempt(row), deduplicated: true };
    }

    const inserted = await tx.query<ContactRow>(
      `INSERT INTO contact_attempts
         (contact_attempt_id, tenant_id, case_id, responder_user_id, attempted_at,
          channel, outcome, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${CONTACT_COLUMNS}`,
      [
        contactAttemptId,
        input.tenantId,
        input.caseId,
        input.responderUserId,
        attemptedAt,
        input.channel,
        input.outcome,
        input.note ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('Contact attempt insert returned no row.');

    return { contactAttempt: toContactAttempt(row), deduplicated: false };
  });
}

export async function listContactAttempts(
  db: Queryable,
  tenantId: string,
  caseId: string,
  limit = 50,
): Promise<ContactAttempt[]> {
  const result = await db.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM contact_attempts
     WHERE tenant_id = $1 AND case_id = $2
     ORDER BY attempted_at DESC
     LIMIT $3`,
    [tenantId, caseId, Math.min(limit, 100)],
  );
  return result.rows.map(toContactAttempt);
}

export interface CaseNote {
  readonly caseNoteId: string;
  readonly caseId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * `ADD_NOTE`.
 *
 * Deliberately emits no Domain Event. EVENT_MODEL.md §3.3 states that a Case
 * Note create must not emit `RESPONDER_CONTACT_LOGGED`, and CASES.md §6 keeps a
 * note distinct from a transition, a Follow-Up, and a Contact Attempt.
 */
export async function addCaseNote(
  pool: Pool,
  input: {
    tenantId: string;
    caseId: string;
    authorUserId: string;
    body: string;
  },
): Promise<CaseNote> {
  return withTransaction(pool, async (tx) => {
    const assignment = await findActiveAssignment(tx, input.caseId);
    if (assignment === undefined) {
      throw new NoActiveAssignmentError('ADD_NOTE');
    }

    const result = await tx.query<{
      case_note_id: string;
      case_id: string;
      author_user_id: string;
      body: string;
      created_at: Date;
    }>(
      `INSERT INTO case_notes (case_note_id, tenant_id, case_id, author_user_id, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING case_note_id, case_id, author_user_id, body, created_at`,
      [randomUUID(), input.tenantId, input.caseId, input.authorUserId, input.body],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Case note insert returned no row.');

    return {
      caseNoteId: row.case_note_id,
      caseId: row.case_id,
      authorUserId: row.author_user_id,
      body: row.body,
      createdAt: row.created_at,
    };
  });
}
