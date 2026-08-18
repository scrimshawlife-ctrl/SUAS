/**
 * Idempotent event consumers.
 *
 * Spec citations:
 * - SUAS-specs EVENT_MODEL.md §5.4 (at-least-once delivery; consumers must be
 *   idempotent), §5.5 (retry count is operational metadata, not domain meaning),
 *   §8 (unsupported schema versions are rejected or safely ignored, never
 *   silently misinterpreted), §10 (duplicate delivery does not duplicate a
 *   downstream state transition)
 * - SUAS-specs ARCHITECTURE.md §3 invariant 4 (correctness-critical state is not
 *   process-local)
 *
 * Dedupe state lives in `processed_events`, so it survives restart and is shared
 * across horizontally scaled instances.
 */

import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { Queryable } from '../db/transaction.js';
import {
  isSupportedEventSchemaVersion,
  UnsupportedEventSchemaVersionError,
  type EventEnvelope,
} from './envelope.js';

export interface EventConsumer {
  /** Stable name; the dedupe key is (consumer name, event id). */
  readonly name: string;
  /** Event types this consumer reacts to. */
  readonly handles: readonly EventEnvelope['eventType'][];
  /**
   * Apply the event. Runs inside the same transaction that records the dedupe
   * row, so the downstream effect and the "already processed" marker commit
   * together or not at all.
   */
  handle(event: EventEnvelope, tx: PoolClient): Promise<void>;
}

export type ConsumerOutcome = 'applied' | 'duplicate' | 'not_subscribed';

export interface ConsumerResult {
  readonly consumer: string;
  readonly outcome: ConsumerOutcome;
}

/**
 * Deliver one event to one consumer exactly once in observable effect.
 *
 * The dedupe row is inserted first; if the insert finds an existing row the
 * event was already applied and the handler is skipped.
 */
export async function deliverToConsumer(
  pool: Pool,
  consumer: EventConsumer,
  event: EventEnvelope,
): Promise<ConsumerResult> {
  if (!consumer.handles.includes(event.eventType)) {
    return { consumer: consumer.name, outcome: 'not_subscribed' };
  }

  // EVENT_MODEL.md §8: fail loudly rather than misinterpret an unknown version.
  if (!isSupportedEventSchemaVersion(event.schemaVersion)) {
    throw new UnsupportedEventSchemaVersionError(event.eventId, event.schemaVersion);
  }

  return withTransaction(pool, async (tx) => {
    const claim = await tx.query(
      `INSERT INTO processed_events (consumer_name, event_id, tenant_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (consumer_name, event_id) DO NOTHING`,
      [consumer.name, event.eventId, event.tenantId],
    );

    if ((claim.rowCount ?? 0) === 0) {
      return { consumer: consumer.name, outcome: 'duplicate' as const };
    }

    await consumer.handle(event, tx);
    return { consumer: consumer.name, outcome: 'applied' as const };
  });
}

/**
 * Build a dispatch function for the outbox publisher that fans one event out to
 * every registered consumer. A consumer failure propagates, so the outbox retries
 * the event; consumers that already applied it absorb the redelivery.
 */
export function createConsumerDispatch(
  pool: Pool,
  consumers: readonly EventConsumer[],
): (event: EventEnvelope) => Promise<void> {
  return async (event: EventEnvelope) => {
    for (const consumer of consumers) {
      await deliverToConsumer(pool, consumer, event);
    }
  };
}

export async function hasProcessed(
  db: Queryable,
  consumerName: string,
  eventId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM processed_events WHERE consumer_name = $1 AND event_id = $2`,
    [consumerName, eventId],
  );
  return (result.rowCount ?? 0) > 0;
}
