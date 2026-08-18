/**
 * Persistent command idempotency.
 *
 * Spec citations:
 * - SUAS-specs API.md §7 (persistent idempotency rules 1-7)
 * - SUAS-specs DATA_MODEL.md §10, §14 rule 15
 * - SUAS-specs ARCHITECTURE.md §5.17 (persistence survives app restart and
 *   horizontal instances; supplements domain uniqueness and FulfillmentAttempt
 *   idempotency rather than replacing them), §10
 * - SUAS-specs EVENT_MODEL.md §2.1 (idempotency key is not an event id)
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Queryable } from '../db/transaction.js';
import { withTransaction } from '../db/transaction.js';
import type { JsonObject } from '../jobs/index.js';

export type CommandIdempotencyState =
  'RESERVED' | 'COMPLETED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL';

/**
 * API.md §6/§7.4: the same key with a conflicting request is a 409 with the
 * canonical code IDEMPOTENCY_CONFLICT.
 */
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly httpStatus = 409;

  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/** Bound on the stored authoritative outcome. DATA_MODEL.md §10 ("bounded result"). */
export const MAX_IDEMPOTENCY_RESULT_BYTES = 8_192;

export class IdempotencyResultTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `Idempotency result is ${bytes} bytes, over the ${MAX_IDEMPOTENCY_RESULT_BYTES}-byte bound ` +
        `(SUAS-specs DATA_MODEL.md §10). Store a reference rather than a whole payload.`,
    );
    this.name = 'IdempotencyResultTooLargeError';
  }
}

export interface CommandIdempotencyRecord {
  readonly commandIdempotencyId: string;
  readonly tenantId: string;
  readonly commandScope: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly state: CommandIdempotencyState;
  readonly result: JsonObject | undefined;
  readonly aggregateType: string | undefined;
  readonly aggregateId: string | undefined;
  readonly eventId: string | undefined;
  readonly attempts: number;
  readonly lastError: string | undefined;
}

interface RecordRow {
  command_idempotency_id: string;
  tenant_id: string;
  command_scope: string;
  idempotency_key: string;
  request_fingerprint: string;
  state: CommandIdempotencyState;
  result: JsonObject | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  event_id: string | null;
  attempts: number;
  last_error: string | null;
}

const RECORD_COLUMNS = `
  command_idempotency_id, tenant_id, command_scope, idempotency_key,
  request_fingerprint, state, result, aggregate_type, aggregate_id, event_id,
  attempts, last_error
`;

function toRecord(row: RecordRow): CommandIdempotencyRecord {
  return {
    commandIdempotencyId: row.command_idempotency_id,
    tenantId: row.tenant_id,
    commandScope: row.command_scope,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    state: row.state,
    result: row.result ?? undefined,
    aggregateType: row.aggregate_type ?? undefined,
    aggregateId: row.aggregate_id ?? undefined,
    eventId: row.event_id ?? undefined,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
  };
}

export interface ReserveCommandInput {
  readonly tenantId: string;
  readonly commandScope: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export type ReserveOutcome =
  /** Caller owns the command and should execute it. */
  | { readonly status: 'reserved'; readonly record: CommandIdempotencyRecord }
  /** A previous identical request already completed; replay its outcome. */
  | { readonly status: 'replay'; readonly record: CommandIdempotencyRecord }
  /** A previous identical request failed terminally; replay that failure. */
  | { readonly status: 'failed_final'; readonly record: CommandIdempotencyRecord }
  /** Another instance holds the reservation and has not finished. */
  | { readonly status: 'in_progress'; readonly record: CommandIdempotencyRecord };

/**
 * Reserve a command key, or resolve what a duplicate should see.
 *
 * The reservation commits on its own so concurrent instances observe it
 * immediately (ARCHITECTURE.md §5.17: persistence survives restart and
 * horizontal instances).
 */
export async function reserveCommand(
  pool: Pool,
  input: ReserveCommandInput,
): Promise<ReserveOutcome> {
  return withTransaction(pool, async (tx) => {
    const inserted = await tx.query<RecordRow>(
      `INSERT INTO command_idempotency_records (
         command_idempotency_id, tenant_id, command_scope, idempotency_key,
         request_fingerprint, state
       )
       VALUES ($1, $2, $3, $4, $5, 'RESERVED')
       ON CONFLICT (tenant_id, command_scope, idempotency_key) DO NOTHING
       RETURNING ${RECORD_COLUMNS}`,
      [
        randomUUID(),
        input.tenantId,
        input.commandScope,
        input.idempotencyKey,
        input.requestFingerprint,
      ],
    );

    const fresh = inserted.rows[0];
    if (fresh !== undefined) {
      return { status: 'reserved' as const, record: toRecord(fresh) };
    }

    // Lock the existing record so two concurrent duplicates cannot both decide
    // to re-run a retryable failure.
    const existingResult = await tx.query<RecordRow>(
      `SELECT ${RECORD_COLUMNS} FROM command_idempotency_records
       WHERE tenant_id = $1 AND command_scope = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [input.tenantId, input.commandScope, input.idempotencyKey],
    );
    const existing = existingResult.rows[0];
    if (existing === undefined) {
      throw new Error(
        'Idempotency insert conflicted but no existing record was found; ' +
          'this indicates a corrupted logical-key index.',
      );
    }

    // API.md §7.4: same key, conflicting request.
    if (existing.request_fingerprint !== input.requestFingerprint) {
      throw new IdempotencyConflictError(
        `Idempotency key "${input.idempotencyKey}" was already used in scope ` +
          `"${input.commandScope}" with a different request. A key identifies one logical ` +
          `request (SUAS-specs API.md §7.4).`,
      );
    }

    switch (existing.state) {
      case 'COMPLETED':
        return { status: 'replay' as const, record: toRecord(existing) };
      case 'FAILED_FINAL':
        return { status: 'failed_final' as const, record: toRecord(existing) };
      case 'RESERVED':
        return { status: 'in_progress' as const, record: toRecord(existing) };
      case 'FAILED_RETRYABLE': {
        // API.md §7.5: a request that lost its response may safely retry.
        const retried = await tx.query<RecordRow>(
          `UPDATE command_idempotency_records
             SET state = 'RESERVED', attempts = attempts + 1, last_error = NULL,
                 updated_at = now()
           WHERE command_idempotency_id = $1
           RETURNING ${RECORD_COLUMNS}`,
          [existing.command_idempotency_id],
        );
        const row = retried.rows[0];
        if (row === undefined) {
          throw new Error('Failed to re-reserve a retryable idempotency record.');
        }
        return { status: 'reserved' as const, record: toRecord(row) };
      }
    }
  });
}

export interface CompleteCommandInput {
  readonly result: JsonObject;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  /** Domain Event produced by the command. Distinct identity (EVENT_MODEL.md §2.1). */
  readonly eventId?: string;
}

/**
 * Record the authoritative outcome. Accepts a transaction client so the outcome
 * can commit together with the domain write it describes.
 */
export async function completeCommand(
  db: Queryable,
  commandIdempotencyId: string,
  input: CompleteCommandInput,
): Promise<CommandIdempotencyRecord> {
  const serialized = JSON.stringify(input.result);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_IDEMPOTENCY_RESULT_BYTES) {
    throw new IdempotencyResultTooLargeError(bytes);
  }

  const result = await db.query<RecordRow>(
    `UPDATE command_idempotency_records
       SET state = 'COMPLETED', result = $2, aggregate_type = $3, aggregate_id = $4,
           event_id = $5, completed_at = now(), updated_at = now(), last_error = NULL
     WHERE command_idempotency_id = $1
     RETURNING ${RECORD_COLUMNS}`,
    [
      commandIdempotencyId,
      serialized,
      input.aggregateType ?? null,
      input.aggregateId ?? null,
      input.eventId ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`No idempotency record ${commandIdempotencyId} to complete.`);
  }
  return toRecord(row);
}

/**
 * Record a failure.
 *
 * `retryable: true` allows a later identical request to re-run the command;
 * `false` makes the failure the authoritative replayed outcome.
 */
export async function failCommand(
  db: Queryable,
  commandIdempotencyId: string,
  options: { retryable: boolean; error: string },
): Promise<CommandIdempotencyRecord> {
  const result = await db.query<RecordRow>(
    `UPDATE command_idempotency_records
       SET state = $2, last_error = $3, updated_at = now()
     WHERE command_idempotency_id = $1
     RETURNING ${RECORD_COLUMNS}`,
    [
      commandIdempotencyId,
      options.retryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL',
      options.error.slice(0, 1000),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`No idempotency record ${commandIdempotencyId} to fail.`);
  }
  return toRecord(row);
}

export async function readCommandRecord(
  db: Queryable,
  params: { tenantId: string; commandScope: string; idempotencyKey: string },
): Promise<CommandIdempotencyRecord | undefined> {
  const result = await db.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM command_idempotency_records
     WHERE tenant_id = $1 AND command_scope = $2 AND idempotency_key = $3`,
    [params.tenantId, params.commandScope, params.idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}
