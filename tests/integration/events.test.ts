/**
 * Event kernel integration evidence (requires PostgreSQL).
 *
 * SUAS-specs EVENT_MODEL.md §1, §2.1, §5, §10; DATA_MODEL.md §11, §14 rule 14;
 * ARCHITECTURE.md §5.18, §8; TESTING.md §3.5.
 */

import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import {
  appendAuditEvent,
  appendDomainEvent,
  createConsumerDispatch,
  deliverToConsumer,
  hasProcessed,
  listAggregateEvents,
  listDeadLetters,
  publishPendingEvents,
  readDomainEvent,
  readOutboxEntry,
  requeueDeadLetter,
  UnsupportedEventSchemaVersionError,
  type EventConsumer,
  type EventEnvelope,
} from '../../src/events/index.js';
import {
  createTestPool,
  resetKernelTables,
  syntheticAggregateId,
  syntheticTenantId,
} from '../helpers/db.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

function caseCreated(tenantId: string, aggregateId: string, idempotencyKey?: string) {
  return {
    eventType: 'CASE_CREATED' as const,
    aggregateType: 'SupportCase',
    aggregateId,
    tenantId,
    actorType: 'RESPONDER' as const,
    actorId: 'responder-1',
    payload: { category: 'FOOD' },
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

describe('EVENT_MODEL.md §2 — envelope', () => {
  it('persists every required envelope field with a server-authoritative time', async () => {
    const tenantId = syntheticTenantId();
    const aggregateId = syntheticAggregateId();

    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, {
        ...caseCreated(tenantId, aggregateId),
        correlationId: 'corr-1',
        requestId: 'req-1',
      }),
    );

    const stored = await readDomainEvent(pool, event.eventId);
    expect(stored).toBeDefined();
    expect(stored?.eventType).toBe('CASE_CREATED');
    expect(stored?.aggregateType).toBe('SupportCase');
    expect(stored?.tenantId).toBe(tenantId);
    expect(stored?.actorType).toBe('RESPONDER');
    expect(stored?.schemaVersion).toBe('0.1.0');
    expect(stored?.payload).toEqual({ category: 'FOOD' });
    expect(stored?.occurredAt).toBeInstanceOf(Date);
    expect(stored?.correlationId).toBe('corr-1');
  });

  it('records causation as a link between two facts', async () => {
    const tenantId = syntheticTenantId();
    const aggregateId = syntheticAggregateId();

    const first = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, aggregateId)),
    );
    const second = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, {
        ...caseCreated(tenantId, aggregateId),
        eventType: 'CASE_ASSIGNED',
        causationEventId: first.event.eventId,
      }),
    );

    expect(second.event.causationEventId).toBe(first.event.eventId);
    expect(second.event.eventId).not.toBe(first.event.eventId);
  });

  it('rejects an event type outside the released catalog', async () => {
    const tenantId = syntheticTenantId();
    await expect(
      withTransaction(pool, (tx) =>
        appendDomainEvent(tx, {
          ...caseCreated(tenantId, syntheticAggregateId()),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          eventType: 'PROVIDER_WEBHOOK_RECEIVED' as any,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('EVENT_MODEL.md §2.1 — identity separation', () => {
  it('keeps event_id distinct from the idempotency key', async () => {
    const tenantId = syntheticTenantId();
    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId(), 'command-key-1')),
    );

    expect(event.idempotencyKey).toBe('command-key-1');
    expect(event.eventId).not.toBe(event.idempotencyKey);
    expect(event.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('resolves a producer replay to the persisted fact instead of a second event', async () => {
    const tenantId = syntheticTenantId();
    const aggregateId = syntheticAggregateId();

    const first = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, aggregateId, 'replayed-command')),
    );
    const replay = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, aggregateId, 'replayed-command')),
    );

    expect(replay.deduplicated).toBe(true);
    expect(replay.event.eventId).toBe(first.event.eventId);

    const history = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId,
    });
    expect(history).toHaveLength(1);
  });

  it('scopes the logical identity by tenant, so tenants cannot collide', async () => {
    const aggregateId = syntheticAggregateId();
    const a = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(syntheticTenantId(), aggregateId, 'same-key')),
    );
    const b = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(syntheticTenantId(), aggregateId, 'same-key')),
    );

    expect(b.deduplicated).toBe(false);
    expect(b.event.eventId).not.toBe(a.event.eventId);
  });

  it('allows an event without an idempotency key to repeat as a distinct fact', async () => {
    const tenantId = syntheticTenantId();
    const aggregateId = syntheticAggregateId();

    const first = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, aggregateId)),
    );
    const second = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, aggregateId)),
    );

    expect(second.event.eventId).not.toBe(first.event.eventId);
  });
});

describe('EVENT_MODEL.md §1, §10 — event stores are append-only', () => {
  it('rejects UPDATE of a Domain Event', async () => {
    const tenantId = syntheticTenantId();
    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
    );

    await expect(
      pool.query(`UPDATE domain_events SET payload = '{"tampered":true}' WHERE event_id = $1`, [
        event.eventId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects DELETE of a Domain Event', async () => {
    const tenantId = syntheticTenantId();
    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
    );

    await expect(
      pool.query(`DELETE FROM domain_events WHERE event_id = $1`, [event.eventId]),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects UPDATE and DELETE of an Audit Event', async () => {
    const tenantId = syntheticTenantId();
    const audit = await withTransaction(pool, (tx) =>
      appendAuditEvent(tx, {
        eventType: 'ADMIN_WRITE',
        action: 'PUBLISH_QUESTIONNAIRE',
        targetType: 'QuestionnaireVersion',
        targetId: 'qv-1',
        aggregateType: 'QuestionnaireVersion',
        aggregateId: syntheticAggregateId(),
        tenantId,
        actorType: 'SUAS_ADMIN',
        actorId: 'admin-1',
        payload: { outcome: 'ALLOW' },
      }),
    );

    await expect(
      pool.query(`UPDATE audit_events SET action = 'X' WHERE audit_event_id = $1`, [
        audit.auditEventId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`DELETE FROM audit_events WHERE audit_event_id = $1`, [audit.auditEventId]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('EVENT_MODEL.md §5.3 — a committed event cannot be lost', () => {
  it('writes the event and its outbox row in the same transaction', async () => {
    const tenantId = syntheticTenantId();
    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
    );

    const entry = await readOutboxEntry(pool, event.eventId);
    expect(entry?.status).toBe('PENDING');
    expect(entry?.attempts).toBe(0);
  });

  it('leaves neither the event nor the outbox row when the transaction fails', async () => {
    const tenantId = syntheticTenantId();
    const aggregateId = syntheticAggregateId();
    let capturedEventId = '';

    await expect(
      withTransaction(pool, async (tx) => {
        const { event } = await appendDomainEvent(tx, caseCreated(tenantId, aggregateId));
        capturedEventId = event.eventId;
        throw new Error('domain write failed after the event was appended');
      }),
    ).rejects.toThrow('domain write failed');

    expect(await readDomainEvent(pool, capturedEventId)).toBeUndefined();
    expect(await readOutboxEntry(pool, capturedEventId)).toBeUndefined();
  });

  it('keeps the event pending when the publisher fails after domain commit', async () => {
    const tenantId = syntheticTenantId();
    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
    );

    const failed = await publishPendingEvents(
      pool,
      () => {
        throw new Error('publisher crashed');
      },
      // A zero ceiling makes the scheduled retry due immediately, so the
      // recovery below does not have to wait out real backoff.
      { maxBackoffSeconds: 0 },
    );
    expect(failed).toEqual({ published: 0, failed: 1, deadLettered: 0 });

    const afterFailure = await readOutboxEntry(pool, event.eventId);
    expect(afterFailure?.status).toBe('PENDING');
    expect(afterFailure?.attempts).toBe(1);
    expect(afterFailure?.lastError).toContain('publisher crashed');

    // The fact survived, so a later publisher run still delivers it.
    const delivered: string[] = [];
    const recovered = await publishPendingEvents(pool, (published) => {
      delivered.push(published.eventId);
      return Promise.resolve();
    });
    expect(recovered.published).toBe(1);
    expect(delivered).toEqual([event.eventId]);
    expect((await readOutboxEntry(pool, event.eventId))?.status).toBe('PUBLISHED');
  });
});

describe('ARCHITECTURE.md §8, §13 — bounded retry and failed-work visibility', () => {
  it('dead-letters an event after its bounded attempts are exhausted', async () => {
    const tenantId = syntheticTenantId();
    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId()), { maxAttempts: 2 }),
    );

    const fail = () =>
      publishPendingEvents(pool, () => Promise.reject(new Error('nope')), {
        maxBackoffSeconds: 0,
      });

    expect((await fail()).failed).toBe(1);
    expect((await fail()).deadLettered).toBe(1);

    const entry = await readOutboxEntry(pool, event.eventId);
    expect(entry?.status).toBe('DEAD_LETTER');
    expect(entry?.attempts).toBe(2);

    const dead = await listDeadLetters(pool);
    expect(dead.map((row) => row.eventId)).toContain(event.eventId);
  });

  it('does not redeliver a dead-lettered event until it is requeued', async () => {
    const tenantId = syntheticTenantId();
    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId()), { maxAttempts: 1 }),
    );
    await publishPendingEvents(pool, () => Promise.reject(new Error('nope')), {
      maxBackoffSeconds: 0,
    });
    expect((await readOutboxEntry(pool, event.eventId))?.status).toBe('DEAD_LETTER');

    const quiet = await publishPendingEvents(pool, () => Promise.resolve());
    expect(quiet.published).toBe(0);

    expect(await requeueDeadLetter(pool, event.eventId)).toBe(true);
    const replayed = await publishPendingEvents(pool, () => Promise.resolve());
    expect(replayed.published).toBe(1);
  });

  it('grows the retry delay within its ceiling', async () => {
    const { backoffSeconds } = await import('../../src/events/index.js');
    expect(backoffSeconds(1)).toBe(2);
    expect(backoffSeconds(3)).toBe(8);
    expect(backoffSeconds(20, 300)).toBe(300);
  });
});

describe('EVENT_MODEL.md §5.4, §10 — duplicate delivery yields one effect', () => {
  function countingConsumer(name: string, applied: string[]): EventConsumer {
    return {
      name,
      handles: ['CASE_CREATED'],
      handle: (event: EventEnvelope) => {
        applied.push(event.eventId);
        return Promise.resolve();
      },
    };
  }

  it('applies an event once even when delivered repeatedly', async () => {
    const tenantId = syntheticTenantId();
    const applied: string[] = [];
    const consumer = countingConsumer('case-projection', applied);

    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
    );

    const first = await deliverToConsumer(pool, consumer, event);
    const second = await deliverToConsumer(pool, consumer, event);
    const third = await deliverToConsumer(pool, consumer, event);

    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('duplicate');
    expect(third.outcome).toBe('duplicate');
    expect(applied).toEqual([event.eventId]);
    expect(await hasProcessed(pool, 'case-projection', event.eventId)).toBe(true);
  });

  it('tracks dedupe per consumer, so a second consumer still sees the event', async () => {
    const tenantId = syntheticTenantId();
    const a: string[] = [];
    const b: string[] = [];

    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
    );

    await deliverToConsumer(pool, countingConsumer('consumer-a', a), event);
    await deliverToConsumer(pool, countingConsumer('consumer-b', b), event);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('does not mark an event processed when the handler fails', async () => {
    const tenantId = syntheticTenantId();
    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
    );

    const flaky: EventConsumer = {
      name: 'flaky',
      handles: ['CASE_CREATED'],
      handle: () => Promise.reject(new Error('handler failed')),
    };

    await expect(deliverToConsumer(pool, flaky, event)).rejects.toThrow('handler failed');
    expect(await hasProcessed(pool, 'flaky', event.eventId)).toBe(false);
  });

  it('ignores an event the consumer does not subscribe to', async () => {
    const tenantId = syntheticTenantId();
    const applied: string[] = [];
    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
    );

    const other: EventConsumer = {
      name: 'followups',
      handles: ['FOLLOWUP_DUE'],
      handle: (delivered) => {
        applied.push(delivered.eventId);
        return Promise.resolve();
      },
    };

    const result = await deliverToConsumer(pool, other, event);
    expect(result.outcome).toBe('not_subscribed');
    expect(applied).toEqual([]);
  });

  it('rejects an unsupported event schema version instead of misreading it', async () => {
    const tenantId = syntheticTenantId();
    const { event } = await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
    );

    const future: EventEnvelope = { ...event, schemaVersion: '9.9.9' };
    const consumer: EventConsumer = {
      name: 'strict',
      handles: ['CASE_CREATED'],
      handle: () => Promise.resolve(),
    };

    await expect(deliverToConsumer(pool, consumer, future)).rejects.toThrow(
      UnsupportedEventSchemaVersionError,
    );
    expect(await hasProcessed(pool, 'strict', event.eventId)).toBe(false);
  });

  it('fans out through the publisher to every registered consumer', async () => {
    const tenantId = syntheticTenantId();
    const a: string[] = [];
    const b: string[] = [];

    await withTransaction(pool, (tx) =>
      appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
    );

    const dispatch = createConsumerDispatch(pool, [
      countingConsumer('fanout-a', a),
      countingConsumer('fanout-b', b),
    ]);
    const result = await publishPendingEvents(pool, dispatch);

    expect(result.published).toBe(1);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe('ARCHITECTURE.md §3 invariant 1 — concurrent publishers', () => {
  it('delivers each pending event to exactly one publisher run', async () => {
    const tenantId = syntheticTenantId();
    for (let i = 0; i < 6; i += 1) {
      await withTransaction(pool, (tx) =>
        appendDomainEvent(tx, caseCreated(tenantId, syntheticAggregateId())),
      );
    }

    const delivered: string[] = [];
    const dispatch = (event: EventEnvelope) => {
      delivered.push(event.eventId);
      return Promise.resolve();
    };

    const [left, right] = await Promise.all([
      publishPendingEvents(pool, dispatch, { batchSize: 6 }),
      publishPendingEvents(pool, dispatch, { batchSize: 6 }),
    ]);

    expect(left.published + right.published).toBe(6);
    expect(new Set(delivered).size).toBe(6);
  });
});
