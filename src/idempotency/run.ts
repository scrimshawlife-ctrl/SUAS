/**
 * Idempotent command execution.
 *
 * Spec citations:
 * - SUAS-specs API.md §7 (persistent idempotency), §6 (409 conflict codes)
 * - SUAS-specs ARCHITECTURE.md §9 (a client command must not report success for
 *   canonical state that has not committed)
 * - SUAS-specs EVENT_MODEL.md §5.3 (domain state and required event commit
 *   atomically)
 *
 * The command body, its Domain Event, and the COMPLETED idempotency record all
 * commit in one transaction, so a duplicate request can never observe a completed
 * record whose domain write was rolled back.
 */

import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { JsonObject } from '../jobs/index.js';
import {
  completeCommand,
  failCommand,
  IdempotencyConflictError,
  reserveCommand,
  type CommandIdempotencyRecord,
} from './store.js';

/**
 * Raised when the same key is retried while the original request is still
 * executing on this or another instance.
 *
 * Carries the released `IDEMPOTENCY_CONFLICT` code because no other conflict code
 * is defined for it; see the Slice 2 conformance record, which returns the
 * concurrent-in-flight case to specs.
 */
export class CommandInProgressError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly httpStatus = 409;

  constructor(idempotencyKey: string, commandScope: string) {
    super(
      `Idempotency key "${idempotencyKey}" in scope "${commandScope}" is currently being ` +
        `processed. Retry once the original request settles.`,
    );
    this.name = 'CommandInProgressError';
  }
}

/** Raised when replaying a terminally failed command. */
export class CommandFailedFinalError extends Error {
  readonly httpStatus = 409;

  constructor(
    readonly record: CommandIdempotencyRecord,
    message: string,
  ) {
    super(message);
    this.name = 'CommandFailedFinalError';
  }
}

export interface CommandExecutionOutput {
  /** Bounded authoritative outcome replayed to duplicate requests. */
  readonly result: JsonObject;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  /** Domain Event produced, if any. Identity distinct from the key. */
  readonly eventId?: string;
}

export interface RunIdempotentCommandInput {
  readonly tenantId: string;
  readonly commandScope: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  /**
   * Classify a failure as terminal. Default is retryable, because caching a
   * transient failure as the authoritative outcome is worse than re-running a
   * deterministic one.
   */
  readonly isFinalFailure?: (error: unknown) => boolean;
}

export interface RunIdempotentCommandResult {
  readonly result: JsonObject;
  /** True when the outcome came from a previously completed identical request. */
  readonly replayed: boolean;
  readonly record: CommandIdempotencyRecord;
}

/**
 * Execute `execute` at most once per (tenant, scope, key).
 *
 * Throws {@link IdempotencyConflictError} when the key is reused with a different
 * request, and {@link CommandInProgressError} when the original is still running.
 */
export async function runIdempotentCommand(
  pool: Pool,
  input: RunIdempotentCommandInput,
  execute: (tx: PoolClient) => Promise<CommandExecutionOutput>,
): Promise<RunIdempotentCommandResult> {
  const reservation = await reserveCommand(pool, {
    tenantId: input.tenantId,
    commandScope: input.commandScope,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
  });

  switch (reservation.status) {
    case 'replay':
      return {
        result: reservation.record.result ?? {},
        replayed: true,
        record: reservation.record,
      };
    case 'failed_final':
      throw new CommandFailedFinalError(
        reservation.record,
        reservation.record.lastError ??
          `Command "${input.commandScope}" previously failed terminally for this key.`,
      );
    case 'in_progress':
      throw new CommandInProgressError(input.idempotencyKey, input.commandScope);
    case 'reserved':
      break;
  }

  const recordId = reservation.record.commandIdempotencyId;

  try {
    return await withTransaction(pool, async (tx) => {
      const output = await execute(tx);
      const record = await completeCommand(tx, recordId, {
        result: output.result,
        ...(output.aggregateType !== undefined ? { aggregateType: output.aggregateType } : {}),
        ...(output.aggregateId !== undefined ? { aggregateId: output.aggregateId } : {}),
        ...(output.eventId !== undefined ? { eventId: output.eventId } : {}),
      });
      return { result: output.result, replayed: false, record };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const final = input.isFinalFailure?.(error) ?? false;
    // Recorded on the pool, not the rolled-back transaction.
    await failCommand(pool, recordId, { retryable: !final, error: message });
    throw error;
  }
}

export { IdempotencyConflictError };
