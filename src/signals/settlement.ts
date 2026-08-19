/**
 * Support Signal settlement and the effective-signal projection.
 *
 * Spec citations:
 * - SUAS-specs SUPPORT_SIGNALS.md §3 (computation identity), §4 (recorded
 *   fields), §5 (settlement and event semantics), §6 (historical integrity),
 *   §7 (override policy)
 * - SUAS-specs EVENT_MODEL.md §3.2 (`SUPPORT_SIGNAL_CHANGED` represents a settled
 *   domain change, not a worker-attempt record; a duplicate replay of an already
 *   settled computation must not emit a second logical fact)
 * - SUAS-specs DATA_MODEL.md §4 (effective projection is deterministic and never
 *   insertion-order-only)
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendDomainEvent } from '../events/index.js';
import type { JsonObject } from '../jobs/index.js';
import type { SignalLevel } from './engine.js';

export type ComputationKind = 'PRIMARY' | 'OVERRIDE';
export type SignalSourceType = 'CHECK_IN' | 'EXPLICIT_NEED';

export interface SupportSignal {
  readonly supportSignalId: string;
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly computationKind: ComputationKind;
  readonly sourceType: SignalSourceType;
  readonly checkInId: string | undefined;
  readonly level: SignalLevel;
  readonly signalVersion: string;
  readonly inputQuestionnaireVersion: string | undefined;
  readonly basis: JsonObject;
  readonly computedAt: Date;
  readonly computationKey: string | undefined;
  readonly overrideOfSignalId: string | undefined;
}

interface SignalRow {
  support_signal_id: string;
  tenant_id: string;
  veteran_user_id: string;
  computation_kind: ComputationKind;
  source_type: SignalSourceType;
  check_in_id: string | null;
  level: SignalLevel;
  signal_version: string;
  input_questionnaire_version: string | null;
  basis: JsonObject;
  computed_at: Date;
  computation_key: string | null;
  override_of_signal_id: string | null;
}

const SIGNAL_COLUMNS = `
  support_signal_id, tenant_id, veteran_user_id, computation_kind, source_type,
  check_in_id, level, signal_version, input_questionnaire_version, basis,
  computed_at, computation_key, override_of_signal_id
`;

function toSignal(row: SignalRow): SupportSignal {
  return {
    supportSignalId: row.support_signal_id,
    tenantId: row.tenant_id,
    veteranUserId: row.veteran_user_id,
    computationKind: row.computation_kind,
    sourceType: row.source_type,
    checkInId: row.check_in_id ?? undefined,
    level: row.level,
    signalVersion: row.signal_version,
    inputQuestionnaireVersion: row.input_questionnaire_version ?? undefined,
    basis: row.basis,
    computedAt: row.computed_at,
    computationKey: row.computation_key ?? undefined,
    overrideOfSignalId: row.override_of_signal_id ?? undefined,
  };
}

/**
 * The computation identity of SUPPORT_SIGNALS.md §3.
 *
 * For a Check-In-derived primary calculation the tuple is check-in, signal
 * version, input questionnaire version, and kind. For an explicit need §3 says a
 * null check-in id alone is insufficient, so a stable source reference takes its
 * place.
 */
export function computationKey(input: {
  sourceType: SignalSourceType;
  checkInId?: string;
  sourceReference?: string;
  signalVersion: string;
  inputQuestionnaireVersion?: string;
}): string {
  const source =
    input.sourceType === 'CHECK_IN'
      ? `check_in:${input.checkInId ?? ''}`
      : `explicit_need:${input.sourceReference ?? ''}`;
  if (source.endsWith(':')) {
    throw new Error(
      'A primary computation identity requires a check-in id or a stable source reference ' +
        '(SUAS-specs SUPPORT_SIGNALS.md §3).',
    );
  }
  const canonical = [
    source,
    `signal_version:${input.signalVersion}`,
    `questionnaire_version:${input.inputQuestionnaireVersion ?? 'none'}`,
    'kind:PRIMARY',
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface SettlePrimaryInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly sourceType: SignalSourceType;
  readonly checkInId?: string;
  readonly sourceReference?: string;
  readonly level: SignalLevel;
  readonly signalVersion: string;
  readonly inputQuestionnaireVersion?: string;
  readonly basis: JsonObject;
  readonly correlationId?: string;
}

export interface SettlePrimaryResult {
  readonly signal: SupportSignal;
  /** True when a duplicate delivery resolved to the already-settled row. */
  readonly deduplicated: boolean;
}

/**
 * Settle a primary calculation.
 *
 * SUPPORT_SIGNALS.md §5: the job may be delivered more than once, persistence
 * resolves duplicates atomically by computation identity, and a replay that
 * resolves to an already-settled row emits no second change event. The unique
 * index on the computation key is what makes that true under concurrency.
 */
export async function settlePrimarySignal(
  pool: Pool,
  input: SettlePrimaryInput,
): Promise<SettlePrimaryResult> {
  const key = computationKey({
    sourceType: input.sourceType,
    ...(input.checkInId !== undefined ? { checkInId: input.checkInId } : {}),
    ...(input.sourceReference !== undefined ? { sourceReference: input.sourceReference } : {}),
    signalVersion: input.signalVersion,
    ...(input.inputQuestionnaireVersion !== undefined
      ? { inputQuestionnaireVersion: input.inputQuestionnaireVersion }
      : {}),
  });

  return withTransaction(pool, async (tx) => {
    const inserted = await tx.query<SignalRow>(
      `INSERT INTO support_signals
         (support_signal_id, tenant_id, veteran_user_id, computation_kind, source_type,
          check_in_id, source_reference, level, signal_version, input_questionnaire_version,
          basis, computation_key)
       VALUES ($1, $2, $3, 'PRIMARY', $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, computation_key) WHERE computation_kind = 'PRIMARY'
         DO NOTHING
       RETURNING ${SIGNAL_COLUMNS}`,
      [
        randomUUID(),
        input.tenantId,
        input.veteranUserId,
        input.sourceType,
        input.checkInId ?? null,
        input.sourceReference ?? null,
        input.level,
        input.signalVersion,
        input.inputQuestionnaireVersion ?? null,
        JSON.stringify(input.basis),
        key,
      ],
    );

    const row = inserted.rows[0];
    if (row === undefined) {
      const existing = await tx.query<SignalRow>(
        `SELECT ${SIGNAL_COLUMNS} FROM support_signals
         WHERE tenant_id = $1 AND computation_key = $2 AND computation_kind = 'PRIMARY'`,
        [input.tenantId, key],
      );
      const existingRow = existing.rows[0];
      if (existingRow === undefined) {
        throw new Error('Signal settlement conflicted but no settled row was found.');
      }
      // §5.4: no second logical change event for a replay.
      return { signal: toSignal(existingRow), deduplicated: true };
    }

    await appendDomainEvent(tx, {
      eventType: 'SUPPORT_SIGNAL_CHANGED',
      aggregateType: 'SupportSignal',
      aggregateId: row.support_signal_id,
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      actorId: 'support-signal',
      payload: {
        support_signal_id: row.support_signal_id,
        veteran_profile_id: input.veteranUserId,
        level: input.level,
        signal_version: input.signalVersion,
        input_questionnaire_version: input.inputQuestionnaireVersion ?? null,
        computation_key: key,
      },
      // EVENT_MODEL.md §3.2: one logical fact per settled computation.
      idempotencyKey: `support-signal:${key}`,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return { signal: toSignal(row), deduplicated: false };
  });
}

/**
 * Record an override.
 *
 * SUPPORT_SIGNALS.md §7: an override is a new immutable row linked to the
 * original, with actor and reason. It is not a recomputation and does not erase
 * the computed signal (§6).
 */
export async function overrideSignal(
  pool: Pool,
  input: {
    tenantId: string;
    overrideOfSignalId: string;
    level: SignalLevel;
    actorId: string;
    reason: string;
    correlationId?: string;
  },
): Promise<SupportSignal> {
  if (input.reason.trim() === '') {
    throw new Error('An override requires a reason (SUAS-specs SUPPORT_SIGNALS.md §7).');
  }

  return withTransaction(pool, async (tx) => {
    const original = await tx.query<SignalRow>(
      `SELECT ${SIGNAL_COLUMNS} FROM support_signals
       WHERE tenant_id = $1 AND support_signal_id = $2`,
      [input.tenantId, input.overrideOfSignalId],
    );
    const originalRow = original.rows[0];
    if (originalRow === undefined) throw new Error('No such Support Signal to override.');

    const result = await tx.query<SignalRow>(
      `INSERT INTO support_signals
         (support_signal_id, tenant_id, veteran_user_id, computation_kind, source_type,
          check_in_id, source_reference, level, signal_version, input_questionnaire_version,
          basis, override_of_signal_id, override_actor_id, override_reason)
       VALUES ($1, $2, $3, 'OVERRIDE', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${SIGNAL_COLUMNS}`,
      [
        randomUUID(),
        input.tenantId,
        originalRow.veteran_user_id,
        originalRow.source_type,
        originalRow.check_in_id,
        originalRow.check_in_id === null ? 'override' : null,
        input.level,
        originalRow.signal_version,
        originalRow.input_questionnaire_version,
        JSON.stringify({ override_of: input.overrideOfSignalId }),
        input.overrideOfSignalId,
        input.actorId,
        input.reason,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Override insert returned no row.');

    await appendDomainEvent(tx, {
      eventType: 'SUPPORT_SIGNAL_CHANGED',
      aggregateType: 'SupportSignal',
      aggregateId: row.support_signal_id,
      tenantId: input.tenantId,
      actorType: 'RESPONDER',
      actorId: input.actorId,
      payload: {
        support_signal_id: row.support_signal_id,
        veteran_profile_id: originalRow.veteran_user_id,
        level: input.level,
        signal_version: originalRow.signal_version,
        override_of_signal_id: input.overrideOfSignalId,
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    return toSignal(row);
  });
}

/**
 * The effective signal for a veteran.
 *
 * SUPPORT_SIGNALS.md §7 states the exact selection rule "must be deterministic
 * and reconciled in DATA_MODEL.md / CASES.md before release" and forbids
 * inferring it from insertion order. No such rule is released, so the rule used
 * here is stated explicitly rather than implied:
 *
 *   most recent `computed_at`, ties broken by `support_signal_id` descending,
 *   with an override superseding the signal it overrides.
 *
 * It is deterministic and total, and it is returned to specs for confirmation.
 */
export async function effectiveSignal(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
): Promise<SupportSignal | undefined> {
  const result = await db.query<SignalRow>(
    `SELECT ${SIGNAL_COLUMNS} FROM support_signals s
     WHERE s.tenant_id = $1
       AND s.veteran_user_id = $2
       -- A signal that has been overridden is superseded by its override.
       AND NOT EXISTS (
         SELECT 1 FROM support_signals o
         WHERE o.override_of_signal_id = s.support_signal_id
       )
     ORDER BY s.computed_at DESC, s.support_signal_id DESC
     LIMIT 1`,
    [tenantId, veteranUserId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toSignal(row);
}

export async function listSignals(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
  limit = 50,
): Promise<SupportSignal[]> {
  const result = await db.query<SignalRow>(
    `SELECT ${SIGNAL_COLUMNS} FROM support_signals
     WHERE tenant_id = $1 AND veteran_user_id = $2
     ORDER BY computed_at DESC, support_signal_id DESC
     LIMIT $3`,
    [tenantId, veteranUserId, Math.min(limit, 100)],
  );
  return result.rows.map(toSignal);
}

/**
 * Completed Check-Ins whose signal has not settled.
 * SUPPORT_SIGNALS.md §5.6 and CHECKINS.md §6.6 both require this to be
 * detectable by operations.
 */
export async function listUnsettledCheckIns(
  db: Queryable,
  tenantId: string,
  limit = 50,
): Promise<{ checkInId: string; completedAt: Date }[]> {
  const result = await db.query<{ check_in_id: string; completed_at: Date }>(
    `SELECT c.check_in_id, c.completed_at
     FROM check_ins c
     WHERE c.tenant_id = $1
       AND c.status = 'COMPLETED'
       AND NOT EXISTS (
         SELECT 1 FROM support_signals s
         WHERE s.check_in_id = c.check_in_id AND s.computation_kind = 'PRIMARY'
       )
     ORDER BY c.completed_at
     LIMIT $2`,
    [tenantId, Math.min(limit, 200)],
  );
  return result.rows.map((row) => ({ checkInId: row.check_in_id, completedAt: row.completed_at }));
}
