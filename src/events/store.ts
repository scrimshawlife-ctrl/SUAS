/**
 * Domain and Audit Event stores.
 *
 * Spec citations:
 * - SUAS-specs EVENT_MODEL.md §1 (append-only), §2 (envelope), §2.1 (identity
 *   separation and producer replay), §4 (Audit Events), §5 (transactionality,
 *   replay, idempotency)
 * - SUAS-specs DATA_MODEL.md §11, §14 rule 14
 * - SUAS-specs ARCHITECTURE.md §5.18
 */

import { randomUUID } from 'node:crypto';
import type { JsonObject } from '../jobs/index.js';
import type { Queryable } from '../db/transaction.js';
import { EVENT_SCHEMA_VERSION } from '../release/pins.js';
import {
  appendAuditEventInputSchema,
  appendDomainEventInputSchema,
  assertBoundedPayload,
  type ActorType,
  type AppendAuditEventInput,
  type AppendDomainEventInput,
  type AuditEventEnvelope,
  type DomainEventType,
  type EventEnvelope,
} from './envelope.js';

/** Bounded publication attempts before an outbox row is dead-lettered. */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;

interface DomainEventRow {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  tenant_id: string;
  actor_type: ActorType;
  actor_id: string;
  occurred_at: Date;
  schema_version: string;
  payload: JsonObject;
  idempotency_key: string | null;
  correlation_id: string | null;
  causation_event_id: string | null;
  request_id: string | null;
}

function toEnvelope(row: DomainEventRow): EventEnvelope {
  return {
    eventId: row.event_id,
    eventType: row.event_type as DomainEventType,
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

const DOMAIN_EVENT_COLUMNS = `
  event_id, event_type, aggregate_type, aggregate_id, tenant_id, actor_type,
  actor_id, occurred_at, schema_version, payload, idempotency_key,
  correlation_id, causation_event_id, request_id
`;

export interface AppendDomainEventResult {
  readonly event: EventEnvelope;
  /**
   * True when a producer replay resolved to the already-persisted fact rather
   * than creating a second one (EVENT_MODEL.md §2.1, §5.2).
   */
  readonly deduplicated: boolean;
}

export interface AppendDomainEventOptions {
  /** Bounded publication attempts for this event's outbox row. */
  readonly maxAttempts?: number;
  /**
   * Skip the outbox row. Only for events with no required async publication;
   * the default writes one so a committed event cannot be lost.
   */
  readonly publish?: boolean;
}

/**
 * Append one Domain Event and, in the same transaction, its outbox row.
 *
 * `tx` must be a transaction client that also carries the domain state write.
 * EVENT_MODEL.md §5.3: domain state and its required Domain Event commit
 * atomically, and the outbox makes publication replay-safe afterwards.
 *
 * A repeated append carrying the same `idempotencyKey` for the same tenant and
 * event type returns the already-persisted event instead of inventing a second
 * fact (EVENT_MODEL.md §2.1).
 */
export async function appendDomainEvent(
  tx: Queryable,
  input: AppendDomainEventInput,
  options: AppendDomainEventOptions = {},
): Promise<AppendDomainEventResult> {
  const parsed = appendDomainEventInputSchema.parse(input);
  assertBoundedPayload(parsed.payload);

  const eventId = randomUUID();
  // Server-authoritative event time (EVENT_MODEL.md §2).
  const occurredAt = parsed.occurredAt ?? new Date();

  const inserted = await tx.query<DomainEventRow>(
    `INSERT INTO domain_events (
       event_id, event_type, aggregate_type, aggregate_id, tenant_id, actor_type,
       actor_id, occurred_at, schema_version, payload, idempotency_key,
       correlation_id, causation_event_id, request_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (tenant_id, event_type, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING
     RETURNING ${DOMAIN_EVENT_COLUMNS}`,
    [
      eventId,
      parsed.eventType,
      parsed.aggregateType,
      parsed.aggregateId,
      parsed.tenantId,
      parsed.actorType,
      parsed.actorId,
      occurredAt,
      EVENT_SCHEMA_VERSION,
      JSON.stringify(parsed.payload),
      parsed.idempotencyKey ?? null,
      parsed.correlationId ?? null,
      parsed.causationEventId ?? null,
      parsed.requestId ?? null,
    ],
  );

  const row = inserted.rows[0];
  if (row === undefined) {
    // The logical fact already exists; return it rather than a second event.
    const existing = await tx.query<DomainEventRow>(
      `SELECT ${DOMAIN_EVENT_COLUMNS} FROM domain_events
       WHERE tenant_id = $1 AND event_type = $2 AND idempotency_key = $3`,
      [parsed.tenantId, parsed.eventType, parsed.idempotencyKey],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new Error(
        'Domain event insert conflicted but no existing event was found; ' +
          'this indicates a corrupted logical-identity index.',
      );
    }
    return { event: toEnvelope(existingRow), deduplicated: true };
  }

  if (options.publish !== false) {
    await tx.query(
      `INSERT INTO event_outbox (event_id, tenant_id, max_attempts) VALUES ($1, $2, $3)`,
      [row.event_id, row.tenant_id, options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS],
    );
  }

  return { event: toEnvelope(row), deduplicated: false };
}

/**
 * Append one Audit Event. Audit Events record who/what/when for security and
 * operations (EVENT_MODEL.md §4) and are not published through the outbox.
 */
export async function appendAuditEvent(
  tx: Queryable,
  input: AppendAuditEventInput,
): Promise<AuditEventEnvelope> {
  const parsed = appendAuditEventInputSchema.parse(input);
  assertBoundedPayload(parsed.payload);

  const auditEventId = randomUUID();
  const occurredAt = parsed.occurredAt ?? new Date();

  await tx.query(
    `INSERT INTO audit_events (
       audit_event_id, event_type, action, target_type, target_id, aggregate_type,
       aggregate_id, tenant_id, actor_type, actor_id, occurred_at, schema_version,
       payload, correlation_id, request_id, ip, user_agent
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      auditEventId,
      parsed.eventType,
      parsed.action,
      parsed.targetType,
      parsed.targetId,
      parsed.aggregateType,
      parsed.aggregateId,
      parsed.tenantId,
      parsed.actorType,
      parsed.actorId,
      occurredAt,
      EVENT_SCHEMA_VERSION,
      JSON.stringify(parsed.payload),
      parsed.correlationId ?? null,
      parsed.requestId ?? null,
      parsed.ip ?? null,
      parsed.userAgent ?? null,
    ],
  );

  return {
    auditEventId,
    eventType: parsed.eventType,
    action: parsed.action,
    targetType: parsed.targetType,
    targetId: parsed.targetId,
    aggregateType: parsed.aggregateType,
    aggregateId: parsed.aggregateId,
    tenantId: parsed.tenantId,
    actorType: parsed.actorType,
    actorId: parsed.actorId,
    occurredAt,
    schemaVersion: EVENT_SCHEMA_VERSION,
    payload: parsed.payload,
    correlationId: parsed.correlationId,
    requestId: parsed.requestId,
    ip: parsed.ip,
    userAgent: parsed.userAgent,
  };
}

export async function readDomainEvent(
  db: Queryable,
  eventId: string,
): Promise<EventEnvelope | undefined> {
  const result = await db.query<DomainEventRow>(
    `SELECT ${DOMAIN_EVENT_COLUMNS} FROM domain_events WHERE event_id = $1`,
    [eventId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toEnvelope(row);
}

/**
 * Bounded read of an aggregate's event history.
 * ARCHITECTURE.md §3 invariant 10 / DATA_MODEL.md §13: normal paths do not load
 * unbounded history, so a limit is always applied.
 */
export async function listAggregateEvents(
  db: Queryable,
  params: {
    tenantId: string;
    aggregateType: string;
    aggregateId: string;
    limit?: number;
  },
): Promise<EventEnvelope[]> {
  const limit = Math.min(params.limit ?? 50, 100);
  const result = await db.query<DomainEventRow>(
    `SELECT ${DOMAIN_EVENT_COLUMNS} FROM domain_events
     WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT $4`,
    [params.tenantId, params.aggregateType, params.aggregateId, limit],
  );
  return result.rows.map(toEnvelope);
}
