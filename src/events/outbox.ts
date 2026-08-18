/**
 * Replay-safe event publication (outbox pattern).
 *
 * Spec citations:
 * - SUAS-specs EVENT_MODEL.md §5.3 (a required event cannot be permanently lost
 *   after domain commit), §5.4 (delivery is at-least-once), §6 (no global
 *   ordering requirement)
 * - SUAS-specs DATA_MODEL.md §11 (outbox is an allowed physical mechanism, not a
 *   business entity)
 * - SUAS-specs ARCHITECTURE.md §8 (durable; replay-safe; DLQ/visibility),
 *   §13 (bounded/backoff retry, failed-work visibility)
 *
 * Publication is at-least-once by design. The target is exactly-once observable
 * business effect, achieved with consumer-side dedupe, not broker guarantees
 * (EVENT_MODEL.md §5).
 */

import type { Pool } from 'pg';
import type { Queryable } from '../db/transaction.js';
import { withTransaction } from '../db/transaction.js';
import type { EventEnvelope } from './envelope.js';
import type { JsonObject } from '../jobs/index.js';

export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'DEAD_LETTER';

export interface OutboxEntry {
  readonly outboxId: string;
  readonly eventId: string;
  readonly tenantId: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: Date;
  readonly publishedAt: Date | undefined;
  readonly lastError: string | undefined;
}

/** Receives one event. Throwing marks the attempt failed and schedules a retry. */
export type EventDispatch = (event: EventEnvelope) => Promise<void>;

export interface PublishOptions {
  readonly batchSize?: number;
  /** Ceiling for exponential backoff between attempts. */
  readonly maxBackoffSeconds?: number;
}

export interface PublishResult {
  readonly published: number;
  readonly failed: number;
  readonly deadLettered: number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_BACKOFF_SECONDS = 300;

interface ClaimedRow {
  outbox_id: string;
  attempts: number;
  max_attempts: number;
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  tenant_id: string;
  actor_type: EventEnvelope['actorType'];
  actor_id: string;
  occurred_at: Date;
  schema_version: string;
  payload: JsonObject;
  idempotency_key: string | null;
  correlation_id: string | null;
  causation_event_id: string | null;
  request_id: string | null;
}

function toEnvelope(row: ClaimedRow): EventEnvelope {
  return {
    eventId: row.event_id,
    eventType: row.event_type as EventEnvelope['eventType'],
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    tenantId: row.tenant_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    schemaVersion: row.schema_version,
    payload: row.payload,
    idempotencyKey: row.idempotency_key ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    causationEventId: row.causation_event_id ?? undefined,
    requestId: row.request_id ?? undefined,
  };
}

/** Bounded exponential backoff. ARCHITECTURE.md §13. */
export function backoffSeconds(attempts: number, ceiling = DEFAULT_MAX_BACKOFF_SECONDS): number {
  return Math.min(2 ** Math.max(attempts, 0), ceiling);
}

/**
 * Publish one batch of pending events.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED` so concurrent publishers on
 * separate app instances do not contend for the same work (ARCHITECTURE.md §3
 * invariant 1). A crash between dispatch and commit leaves the row PENDING, so
 * the event is redelivered rather than lost — consumers absorb the duplicate.
 */
export async function publishPendingEvents(
  pool: Pool,
  dispatch: EventDispatch,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const ceiling = options.maxBackoffSeconds ?? DEFAULT_MAX_BACKOFF_SECONDS;

  return withTransaction(pool, async (tx) => {
    const claimed = await tx.query<ClaimedRow>(
      `SELECT o.outbox_id, o.attempts, o.max_attempts,
              e.event_id, e.event_type, e.aggregate_type, e.aggregate_id, e.tenant_id,
              e.actor_type, e.actor_id, e.occurred_at, e.schema_version, e.payload,
              e.idempotency_key, e.correlation_id, e.causation_event_id, e.request_id
       FROM event_outbox o
       JOIN domain_events e ON e.event_id = o.event_id
       WHERE o.status = 'PENDING' AND o.available_at <= now()
       ORDER BY o.available_at, o.outbox_id
       LIMIT $1
       FOR UPDATE OF o SKIP LOCKED`,
      [batchSize],
    );

    let published = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const row of claimed.rows) {
      try {
        await dispatch(toEnvelope(row));
        await tx.query(
          `UPDATE event_outbox
             SET status = 'PUBLISHED', attempts = attempts + 1,
                 published_at = now(), last_error = NULL, updated_at = now()
           WHERE outbox_id = $1`,
          [row.outbox_id],
        );
        published += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        // Failure detail is operational metadata, not domain meaning
        // (EVENT_MODEL.md §5.5), and is truncated so the column stays bounded.
        const lastError = message.slice(0, 1000);

        if (attempts >= row.max_attempts) {
          await tx.query(
            `UPDATE event_outbox
               SET status = 'DEAD_LETTER', attempts = $2, last_error = $3, updated_at = now()
             WHERE outbox_id = $1`,
            [row.outbox_id, attempts, lastError],
          );
          deadLettered += 1;
        } else {
          await tx.query(
            `UPDATE event_outbox
               SET attempts = $2, last_error = $3, updated_at = now(),
                   available_at = now() + make_interval(secs => $4)
             WHERE outbox_id = $1`,
            [row.outbox_id, attempts, lastError, backoffSeconds(attempts, ceiling)],
          );
          failed += 1;
        }
      }
    }

    return { published, failed, deadLettered };
  });
}

interface OutboxRow {
  outbox_id: string;
  event_id: string;
  tenant_id: string;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  published_at: Date | null;
  last_error: string | null;
}

function toEntry(row: OutboxRow): OutboxEntry {
  return {
    outboxId: row.outbox_id,
    eventId: row.event_id,
    tenantId: row.tenant_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    publishedAt: row.published_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

const OUTBOX_COLUMNS = `
  outbox_id, event_id, tenant_id, status, attempts, max_attempts,
  available_at, published_at, last_error
`;

export async function readOutboxEntry(
  db: Queryable,
  eventId: string,
): Promise<OutboxEntry | undefined> {
  const result = await db.query<OutboxRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM event_outbox WHERE event_id = $1`,
    [eventId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toEntry(row);
}

/** Failed-work visibility. ARCHITECTURE.md §8, §13. */
export async function listDeadLetters(db: Queryable, limit = 50): Promise<OutboxEntry[]> {
  const result = await db.query<OutboxRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM event_outbox
     WHERE status = 'DEAD_LETTER'
     ORDER BY updated_at DESC
     LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return result.rows.map(toEntry);
}

/**
 * Return a dead-lettered event to the pending queue.
 *
 * EVENT_MODEL.md §4 lists recovery/replay/dead-letter actions among the facts
 * that must be auditable; callers are responsible for appending that Audit Event
 * with the acting operator's identity.
 */
export async function requeueDeadLetter(db: Queryable, eventId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE event_outbox
       SET status = 'PENDING', available_at = now(), attempts = 0,
           last_error = NULL, updated_at = now()
     WHERE event_id = $1 AND status = 'DEAD_LETTER'`,
    [eventId],
  );
  return (result.rowCount ?? 0) > 0;
}
