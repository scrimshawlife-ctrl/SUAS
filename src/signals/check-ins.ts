/**
 * Questionnaires and Check-Ins.
 *
 * Spec citations:
 * - SUAS-specs CHECKINS.md §1 (a Check-In is an input artifact, not a Signal,
 *   Case, or Service Request), §4 (states), §4.1 (incomplete), §4.2 (abandoned),
 *   §4.3 (corrections), §4.4 (server-authoritative timing), §4.5 (questionnaire
 *   migration), §5 (publication), §6 (completion and signal trigger), §7 (events
 *   and audit)
 * - SUAS-specs EVENT_MODEL.md §3.1 (`CHECKIN_COMPLETED` is emitted only on the
 *   first successful logical transition to COMPLETED; the event requests durable
 *   signal computation and does not mean the signal has settled)
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendAuditEvent, appendDomainEvent } from '../events/index.js';
import type { DurableJobQueuePort } from '../jobs/index.js';

export const CHECK_IN_STATUSES = [
  'STARTED',
  'IN_PROGRESS',
  'COMPLETED',
  'ABANDONED',
  'INCOMPLETE',
] as const;
export type CheckInStatus = (typeof CHECK_IN_STATUSES)[number];

/** CHECKINS.md §3. */
export const QUESTION_DIMENSIONS = [
  'sleep',
  'connection',
  'stress',
  'basic_needs',
  'coping',
  'safety',
] as const;
export type QuestionDimension = (typeof QUESTION_DIMENSIONS)[number];

export type QuestionnaireStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';

export interface QuestionnaireVersion {
  readonly questionnaireVersion: string;
  readonly status: QuestionnaireStatus;
  readonly title: string;
}

export interface Question {
  readonly questionId: string;
  readonly questionKey: string;
  readonly prompt: string;
  readonly dimension: QuestionDimension | undefined;
  readonly required: boolean;
}

export interface CheckIn {
  readonly checkInId: string;
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly questionnaireVersion: string;
  readonly status: CheckInStatus;
  readonly completedAt: Date | undefined;
}

interface CheckInRow {
  check_in_id: string;
  tenant_id: string;
  veteran_user_id: string;
  questionnaire_version: string;
  status: CheckInStatus;
  completed_at: Date | null;
}

const CHECK_IN_COLUMNS =
  'check_in_id, tenant_id, veteran_user_id, questionnaire_version, status, completed_at';

function toCheckIn(row: CheckInRow): CheckIn {
  return {
    checkInId: row.check_in_id,
    tenantId: row.tenant_id,
    veteranUserId: row.veteran_user_id,
    questionnaireVersion: row.questionnaire_version,
    status: row.status,
    completedAt: row.completed_at ?? undefined,
  };
}

export class QuestionnaireError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(message: string) {
    super(message);
    this.name = 'QuestionnaireError';
  }
}

export class CheckInStateError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly httpStatus = 409;

  constructor(message: string) {
    super(message);
    this.name = 'CheckInStateError';
  }
}

// ---------------------------------------------------------------------------
// Questionnaire publication
// ---------------------------------------------------------------------------

export async function createQuestionnaireVersion(
  db: Queryable,
  input: {
    questionnaireVersion: string;
    title: string;
    tenantId?: string;
    questions?: readonly {
      questionKey: string;
      prompt: string;
      dimension?: QuestionDimension;
      required?: boolean;
      options?: readonly { optionKey: string; label: string }[];
    }[];
  },
): Promise<QuestionnaireVersion> {
  await db.query(
    `INSERT INTO questionnaire_versions (questionnaire_version, tenant_id, title)
     VALUES ($1, $2, $3)`,
    [input.questionnaireVersion, input.tenantId ?? null, input.title],
  );

  for (const [index, question] of (input.questions ?? []).entries()) {
    const questionId = randomUUID();
    await db.query(
      `INSERT INTO questions
         (question_id, questionnaire_version, question_key, prompt, dimension, required, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        questionId,
        input.questionnaireVersion,
        question.questionKey,
        question.prompt,
        question.dimension ?? null,
        question.required ?? false,
        index,
      ],
    );
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      await db.query(
        `INSERT INTO answer_options (answer_option_id, question_id, option_key, label, display_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), questionId, option.optionKey, option.label, optionIndex],
      );
    }
  }

  return { questionnaireVersion: input.questionnaireVersion, status: 'DRAFT', title: input.title };
}

/**
 * Publish a version.
 *
 * CHECKINS.md §5: publication is atomic from the reader's perspective — a new
 * Check-In resolves to one complete published version, never a partial set. The
 * supersede and publish happen in one transaction, and the partial unique index
 * permits only one published version at a time.
 */
export async function publishQuestionnaireVersion(
  pool: Pool,
  input: { questionnaireVersion: string; tenantId?: string; publishedBy: string },
): Promise<QuestionnaireVersion> {
  return withTransaction(pool, async (tx) => {
    await tx.query(
      `UPDATE questionnaire_versions
         SET status = 'SUPERSEDED', superseded_at = now()
       WHERE status = 'PUBLISHED'
         AND COALESCE(tenant_id::text, 'global') = COALESCE($1::text, 'global')`,
      [input.tenantId ?? null],
    );

    const result = await tx.query<{
      questionnaire_version: string;
      status: QuestionnaireStatus;
      title: string;
    }>(
      `UPDATE questionnaire_versions
         SET status = 'PUBLISHED', published_at = now(), published_by = $2
       WHERE questionnaire_version = $1 AND status = 'DRAFT'
       RETURNING questionnaire_version, status, title`,
      [input.questionnaireVersion, input.publishedBy],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new QuestionnaireError(
        'Only a DRAFT questionnaire version can be published; published versions are immutable ' +
          '(SUAS-specs CHECKINS.md §5).',
      );
    }

    await appendAuditEvent(tx, {
      eventType: 'QUESTIONNAIRE_PUBLISHED',
      action: 'PUBLISH_QUESTIONNAIRE_VERSION',
      targetType: 'QuestionnaireVersion',
      targetId: input.questionnaireVersion,
      aggregateType: 'QuestionnaireVersion',
      aggregateId: randomUUID(),
      tenantId: input.tenantId ?? '00000000-0000-0000-0000-000000000000',
      actorType: 'SUAS_ADMIN',
      actorId: input.publishedBy,
      payload: { questionnaire_version: input.questionnaireVersion },
    });

    return {
      questionnaireVersion: row.questionnaire_version,
      status: row.status,
      title: row.title,
    };
  });
}

/** The version a new Check-In resolves to. CHECKINS.md §4.5. */
export async function currentPublishedVersion(
  db: Queryable,
  tenantId?: string,
): Promise<QuestionnaireVersion | undefined> {
  const result = await db.query<{
    questionnaire_version: string;
    status: QuestionnaireStatus;
    title: string;
  }>(
    `SELECT questionnaire_version, status, title FROM questionnaire_versions
     WHERE status = 'PUBLISHED'
       AND COALESCE(tenant_id::text, 'global') = COALESCE($1::text, 'global')`,
    [tenantId ?? null],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        questionnaireVersion: row.questionnaire_version,
        status: row.status,
        title: row.title,
      };
}

export async function listQuestions(
  db: Queryable,
  questionnaireVersion: string,
): Promise<Question[]> {
  const result = await db.query<{
    question_id: string;
    question_key: string;
    prompt: string;
    dimension: QuestionDimension | null;
    required: boolean;
  }>(
    `SELECT question_id, question_key, prompt, dimension, required
     FROM questions WHERE questionnaire_version = $1
     ORDER BY display_order, question_key`,
    [questionnaireVersion],
  );
  return result.rows.map((row) => ({
    questionId: row.question_id,
    questionKey: row.question_key,
    prompt: row.prompt,
    dimension: row.dimension ?? undefined,
    required: row.required,
  }));
}

// ---------------------------------------------------------------------------
// Check-Ins
// ---------------------------------------------------------------------------

/**
 * Start a Check-In on the current published version.
 *
 * CHECKINS.md §4.5: the version is bound at creation, so a publish during an
 * in-flight Check-In does not move it.
 */
export async function startCheckIn(
  pool: Pool,
  input: { tenantId: string; veteranUserId: string },
): Promise<CheckIn> {
  const published = await currentPublishedVersion(pool, input.tenantId);
  const global = published ?? (await currentPublishedVersion(pool));
  if (global === undefined) {
    throw new QuestionnaireError(
      'No published questionnaire version exists, so a Check-In cannot be started ' +
        '(SUAS-specs CHECKINS.md §5).',
    );
  }

  const result = await pool.query<CheckInRow>(
    `INSERT INTO check_ins (check_in_id, tenant_id, veteran_user_id, questionnaire_version)
     VALUES ($1, $2, $3, $4)
     RETURNING ${CHECK_IN_COLUMNS}`,
    [randomUUID(), input.tenantId, input.veteranUserId, global.questionnaireVersion],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Check-in insert returned no row.');
  return toCheckIn(row);
}

export async function saveResponse(
  pool: Pool,
  input: {
    tenantId: string;
    checkInId: string;
    questionId: string;
    answerOptionId?: string;
    freeText?: string;
  },
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const current = await findCheckIn(tx, input.tenantId, input.checkInId);
    if (current === undefined) throw new CheckInStateError('No such Check-In.');
    if (current.status !== 'STARTED' && current.status !== 'IN_PROGRESS') {
      throw new CheckInStateError(
        'A settled Check-In cannot be edited; a correction creates a new Check-In ' +
          '(SUAS-specs CHECKINS.md §4.3).',
      );
    }

    await tx.query(
      `INSERT INTO check_in_responses
         (check_in_response_id, check_in_id, question_id, answer_option_id, free_text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (check_in_id, question_id) DO UPDATE
         SET answer_option_id = EXCLUDED.answer_option_id,
             free_text = EXCLUDED.free_text,
             answered_at = now()`,
      [
        randomUUID(),
        input.checkInId,
        input.questionId,
        input.answerOptionId ?? null,
        input.freeText ?? null,
      ],
    );

    await tx.query(
      `UPDATE check_ins SET status = 'IN_PROGRESS', updated_at = now()
       WHERE tenant_id = $1 AND check_in_id = $2 AND status = 'STARTED'`,
      [input.tenantId, input.checkInId],
    );
  });
}

export interface CompleteCheckInResult {
  readonly checkIn: CheckIn;
  /** True when a replay resolved to the already-completed Check-In. */
  readonly alreadyCompleted: boolean;
  /** True when required answers were missing, so the result is INCOMPLETE. */
  readonly incomplete: boolean;
}

/**
 * Complete a Check-In.
 *
 * CHECKINS.md §6: the transaction commits before success is returned, exactly one
 * logical `CHECKIN_COMPLETED` is emitted, and that fact *requests* durable signal
 * computation — it does not mean a signal has settled (EVENT_MODEL.md §3.1).
 *
 * A submission missing required answers becomes `INCOMPLETE` and emits no
 * completion fact, because §4.1 forbids computing a production signal from it.
 */
export async function completeCheckIn(
  pool: Pool,
  input: { tenantId: string; checkInId: string; actorId: string; correlationId?: string },
  deps: { jobQueue?: DurableJobQueuePort } = {},
): Promise<CompleteCheckInResult> {
  const outcome = await withTransaction(pool, async (tx) => {
    const locked = await tx.query<CheckInRow>(
      `SELECT ${CHECK_IN_COLUMNS} FROM check_ins
       WHERE tenant_id = $1 AND check_in_id = $2
       FOR UPDATE`,
      [input.tenantId, input.checkInId],
    );
    const row = locked.rows[0];
    if (row === undefined) throw new CheckInStateError('No such Check-In.');
    const current = toCheckIn(row);

    if (current.status === 'COMPLETED') {
      return { checkIn: current, alreadyCompleted: true, incomplete: false };
    }
    if (current.status === 'ABANDONED' || current.status === 'INCOMPLETE') {
      throw new CheckInStateError(
        `A ${current.status} Check-In cannot be completed (SUAS-specs CHECKINS.md §4).`,
      );
    }

    const missing = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM questions q
       WHERE q.questionnaire_version = $1
         AND q.required = true
         AND NOT EXISTS (
           SELECT 1 FROM check_in_responses r
           WHERE r.check_in_id = $2 AND r.question_id = q.question_id
         )`,
      [current.questionnaireVersion, input.checkInId],
    );
    const missingCount = Number.parseInt(missing.rows[0]?.count ?? '0', 10);

    if (missingCount > 0) {
      // CHECKINS.md §4.1: explicitly marked INCOMPLETE, and §7: no
      // CHECKIN_COMPLETED fact.
      const updated = await tx.query<CheckInRow>(
        `UPDATE check_ins SET status = 'INCOMPLETE', updated_at = now()
         WHERE tenant_id = $1 AND check_in_id = $2
         RETURNING ${CHECK_IN_COLUMNS}`,
        [input.tenantId, input.checkInId],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) throw new Error('Check-in update returned no row.');
      return { checkIn: toCheckIn(updatedRow), alreadyCompleted: false, incomplete: true };
    }

    const updated = await tx.query<CheckInRow>(
      `UPDATE check_ins SET status = 'COMPLETED', completed_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND check_in_id = $2
       RETURNING ${CHECK_IN_COLUMNS}`,
      [input.tenantId, input.checkInId],
    );
    const updatedRow = updated.rows[0];
    if (updatedRow === undefined) throw new Error('Check-in update returned no row.');

    await appendDomainEvent(tx, {
      eventType: 'CHECKIN_COMPLETED',
      aggregateType: 'CheckIn',
      aggregateId: input.checkInId,
      tenantId: input.tenantId,
      actorType: 'VETERAN',
      actorId: input.actorId,
      payload: {
        check_in_id: input.checkInId,
        veteran_profile_id: current.veteranUserId,
        questionnaire_version: current.questionnaireVersion,
      },
      // §7: retries of the same completion command emit one logical fact.
      idempotencyKey: `checkin-completed:${input.checkInId}`,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return { checkIn: toCheckIn(updatedRow), alreadyCompleted: false, incomplete: false };
  });

  // §6.3: the completion fact requests signal computation through durable async
  // work. The Slice 1 job seam still fails closed outside LOCAL and TEST while
  // D-022 is open.
  if (!outcome.alreadyCompleted && !outcome.incomplete && deps.jobQueue !== undefined) {
    await deps.jobQueue.enqueue({
      jobType: 'support-signal.compute',
      payload: { check_in_id: input.checkInId },
      idempotencyKey: `support-signal:${input.checkInId}`,
      tenantId: input.tenantId,
    });
  }

  return outcome;
}

/** CHECKINS.md §4.2: abandoned Check-Ins remain stored and emit no completion. */
export async function abandonCheckIn(
  pool: Pool,
  input: { tenantId: string; checkInId: string },
): Promise<CheckIn> {
  const result = await pool.query<CheckInRow>(
    `UPDATE check_ins SET status = 'ABANDONED', abandoned_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND check_in_id = $2 AND status IN ('STARTED', 'IN_PROGRESS')
     RETURNING ${CHECK_IN_COLUMNS}`,
    [input.tenantId, input.checkInId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new CheckInStateError('Only an in-flight Check-In can be abandoned.');
  }
  return toCheckIn(row);
}

export async function findCheckIn(
  db: Queryable,
  tenantId: string,
  checkInId: string,
): Promise<CheckIn | undefined> {
  const result = await db.query<CheckInRow>(
    `SELECT ${CHECK_IN_COLUMNS} FROM check_ins WHERE tenant_id = $1 AND check_in_id = $2`,
    [tenantId, checkInId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toCheckIn(row);
}

/**
 * Canonical inputs for signal computation.
 *
 * Free text is deliberately excluded: SUPPORT_SIGNALS.md §10 forbids generative
 * interpretation of free text as a primary signal, and the safest way to
 * guarantee that is never to hand it to an engine.
 */
export async function canonicalInputFor(
  db: Queryable,
  tenantId: string,
  checkInId: string,
): Promise<{
  checkInId: string;
  sourceReference: undefined;
  questionnaireVersion: string;
  answers: { questionKey: string; dimension: string | undefined; optionKey: string | undefined }[];
  incomplete: boolean;
}> {
  const checkIn = await findCheckIn(db, tenantId, checkInId);
  if (checkIn === undefined) throw new CheckInStateError('No such Check-In.');

  const result = await db.query<{
    question_key: string;
    dimension: string | null;
    option_key: string | null;
  }>(
    `SELECT q.question_key, q.dimension, o.option_key
     FROM questions q
     LEFT JOIN check_in_responses r ON r.question_id = q.question_id AND r.check_in_id = $2
     LEFT JOIN answer_options o ON o.answer_option_id = r.answer_option_id
     WHERE q.questionnaire_version = $1
     ORDER BY q.display_order, q.question_key`,
    [checkIn.questionnaireVersion, checkInId],
  );

  return {
    checkInId,
    sourceReference: undefined,
    questionnaireVersion: checkIn.questionnaireVersion,
    answers: result.rows.map((row) => ({
      questionKey: row.question_key,
      dimension: row.dimension ?? undefined,
      optionKey: row.option_key ?? undefined,
    })),
    incomplete: checkIn.status === 'INCOMPLETE',
  };
}
