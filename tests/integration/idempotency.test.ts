/**
 * Command idempotency integration evidence (requires PostgreSQL).
 *
 * SUAS-specs API.md §7 (rules 1-7), §6 (409 IDEMPOTENCY_CONFLICT);
 * DATA_MODEL.md §10, §14 rule 15; ARCHITECTURE.md §5.17, §9, §10;
 * TESTING.md §3.5.
 */

import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendDomainEvent, readDomainEvent } from '../../src/events/index.js';
import {
  CommandFailedFinalError,
  CommandInProgressError,
  commandScope,
  fingerprintRequest,
  IdempotencyConflictError,
  IdempotencyResultTooLargeError,
  MAX_IDEMPOTENCY_RESULT_BYTES,
  readCommandRecord,
  reserveCommand,
  runIdempotentCommand,
  type FingerprintableValue,
} from '../../src/idempotency/index.js';
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

const scope = commandScope({ command: 'POST /cases', aggregateType: 'SupportCase' });

function input(
  tenantId: string,
  key: string,
  request: FingerprintableValue = { category: 'FOOD' },
) {
  return {
    tenantId,
    commandScope: scope,
    idempotencyKey: key,
    requestFingerprint: fingerprintRequest(request),
  };
}

describe('API.md §7.3 — same key and same request replays the authoritative result', () => {
  it('executes once and replays the stored outcome', async () => {
    const tenantId = syntheticTenantId();
    const aggregateId = syntheticAggregateId();
    let executions = 0;

    const execute = () => {
      executions += 1;
      return Promise.resolve({ result: { case_id: aggregateId, status: 'OPEN' }, aggregateId });
    };

    const first = await runIdempotentCommand(pool, input(tenantId, 'key-1'), execute);
    const second = await runIdempotentCommand(pool, input(tenantId, 'key-1'), execute);

    expect(executions).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
  });

  it('replays across a new pool, proving the record is not process-local', async () => {
    const tenantId = syntheticTenantId();
    let executions = 0;
    const execute = () => {
      executions += 1;
      return Promise.resolve({ result: { ok: true } });
    };

    await runIdempotentCommand(pool, input(tenantId, 'restart-key'), execute);

    // A separate pool stands in for a restarted process or a second instance.
    const otherInstance = createTestPool(2);
    try {
      const replay = await runIdempotentCommand(
        otherInstance,
        input(tenantId, 'restart-key'),
        execute,
      );
      expect(replay.replayed).toBe(true);
      expect(executions).toBe(1);
    } finally {
      await otherInstance.end();
    }
  });

  it('is insensitive to request key order when comparing fingerprints', async () => {
    const tenantId = syntheticTenantId();
    let executions = 0;
    const execute = () => {
      executions += 1;
      return Promise.resolve({ result: { ok: true } });
    };

    await runIdempotentCommand(pool, input(tenantId, 'order-key', { a: 1, b: 2 }), execute);
    const replay = await runIdempotentCommand(
      pool,
      input(tenantId, 'order-key', { b: 2, a: 1 }),
      execute,
    );

    expect(replay.replayed).toBe(true);
    expect(executions).toBe(1);
  });
});

describe('API.md §7.4 — same key with a conflicting request fails', () => {
  it('raises the released IDEMPOTENCY_CONFLICT code', async () => {
    const tenantId = syntheticTenantId();
    await runIdempotentCommand(pool, input(tenantId, 'key-2', { category: 'FOOD' }), () =>
      Promise.resolve({ result: { ok: true } }),
    );

    const conflicting = runIdempotentCommand(
      pool,
      input(tenantId, 'key-2', { category: 'SHELTER' }),
      () => Promise.resolve({ result: { ok: true } }),
    );

    await expect(conflicting).rejects.toThrow(IdempotencyConflictError);
    await expect(conflicting).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      httpStatus: 409,
    });
  });

  it('scopes keys by tenant, so tenants cannot collide', async () => {
    const request = { category: 'FOOD' };
    await runIdempotentCommand(pool, input(syntheticTenantId(), 'shared', request), () =>
      Promise.resolve({ result: { instance: 'a' } }),
    );
    const other = await runIdempotentCommand(
      pool,
      input(syntheticTenantId(), 'shared', request),
      () => Promise.resolve({ result: { instance: 'b' } }),
    );

    expect(other.replayed).toBe(false);
    expect(other.result).toEqual({ instance: 'b' });
  });

  it('scopes keys by command, so the same key in another command is independent', async () => {
    const tenantId = syntheticTenantId();
    await runIdempotentCommand(pool, input(tenantId, 'k'), () =>
      Promise.resolve({ result: { a: true } }),
    );

    const elsewhere = await runIdempotentCommand(
      pool,
      {
        tenantId,
        commandScope: commandScope({ command: 'POST /service-requests' }),
        idempotencyKey: 'k',
        requestFingerprint: fingerprintRequest({ category: 'FOOD' }),
      },
      () => Promise.resolve({ result: { b: true } }),
    );

    expect(elsewhere.replayed).toBe(false);
  });
});

describe('ARCHITECTURE.md §9, §10 — atomicity and contention', () => {
  it('commits the domain event and the completed record together', async () => {
    const tenantId = syntheticTenantId();
    const aggregateId = syntheticAggregateId();

    const run = await runIdempotentCommand(pool, input(tenantId, 'atomic-key'), async (tx) => {
      const { event } = await appendDomainEvent(tx, {
        eventType: 'CASE_CREATED',
        aggregateType: 'SupportCase',
        aggregateId,
        tenantId,
        actorType: 'RESPONDER',
        actorId: 'responder-1',
        payload: { category: 'FOOD' },
      });
      return {
        result: { case_id: aggregateId },
        aggregateType: 'SupportCase',
        aggregateId,
        eventId: event.eventId,
      };
    });

    const record = await readCommandRecord(pool, {
      tenantId,
      commandScope: scope,
      idempotencyKey: 'atomic-key',
    });

    expect(record?.state).toBe('COMPLETED');
    expect(record?.eventId).toBeDefined();
    // EVENT_MODEL.md §2.1: the event identity is not the command key.
    expect(record?.eventId).not.toBe(record?.idempotencyKey);
    expect(await readDomainEvent(pool, record?.eventId ?? '')).toBeDefined();
    expect(run.result).toEqual({ case_id: aggregateId });
  });

  it('never reports success for work that rolled back', async () => {
    const tenantId = syntheticTenantId();
    const aggregateId = syntheticAggregateId();
    let capturedEventId = '';

    await expect(
      runIdempotentCommand(pool, input(tenantId, 'rollback-key'), async (tx) => {
        const { event } = await appendDomainEvent(tx, {
          eventType: 'CASE_CREATED',
          aggregateType: 'SupportCase',
          aggregateId,
          tenantId,
          actorType: 'RESPONDER',
          actorId: 'responder-1',
          payload: { category: 'FOOD' },
        });
        capturedEventId = event.eventId;
        throw new Error('command body failed');
      }),
    ).rejects.toThrow('command body failed');

    expect(await readDomainEvent(pool, capturedEventId)).toBeUndefined();
    const record = await readCommandRecord(pool, {
      tenantId,
      commandScope: scope,
      idempotencyKey: 'rollback-key',
    });
    expect(record?.state).toBe('FAILED_RETRYABLE');
    expect(record?.lastError).toContain('command body failed');
  });

  it('produces one winner when the same key is reserved concurrently', async () => {
    const tenantId = syntheticTenantId();
    const outcomes = await Promise.all([
      reserveCommand(pool, input(tenantId, 'contested')),
      reserveCommand(pool, input(tenantId, 'contested')),
      reserveCommand(pool, input(tenantId, 'contested')),
    ]);

    const statuses = outcomes.map((outcome) => outcome.status).sort();
    expect(statuses.filter((status) => status === 'reserved')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'in_progress')).toHaveLength(2);
  });

  it('rejects a retry while the original request is still in flight', async () => {
    const tenantId = syntheticTenantId();
    await reserveCommand(pool, input(tenantId, 'in-flight'));

    await expect(
      runIdempotentCommand(pool, input(tenantId, 'in-flight'), () =>
        Promise.resolve({ result: { ok: true } }),
      ),
    ).rejects.toThrow(CommandInProgressError);
  });
});

describe('API.md §7.5 — a request that lost its response may retry', () => {
  it('re-runs after a retryable failure', async () => {
    const tenantId = syntheticTenantId();
    let attempts = 0;

    const flaky = () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient database blip');
      return Promise.resolve({ result: { attempt: attempts } });
    };

    await expect(runIdempotentCommand(pool, input(tenantId, 'retry-key'), flaky)).rejects.toThrow(
      'transient',
    );

    const retried = await runIdempotentCommand(pool, input(tenantId, 'retry-key'), flaky);
    expect(retried.replayed).toBe(false);
    expect(retried.result).toEqual({ attempt: 2 });

    const record = await readCommandRecord(pool, {
      tenantId,
      commandScope: scope,
      idempotencyKey: 'retry-key',
    });
    expect(record?.state).toBe('COMPLETED');
    expect(record?.attempts).toBe(2);
  });

  it('replays a terminal failure instead of re-running it', async () => {
    const tenantId = syntheticTenantId();
    let executions = 0;

    const failing = () => {
      executions += 1;
      return Promise.reject(new Error('category is not offered'));
    };

    await expect(
      runIdempotentCommand(
        pool,
        { ...input(tenantId, 'final-key'), isFinalFailure: () => true },
        failing,
      ),
    ).rejects.toThrow('category is not offered');

    await expect(
      runIdempotentCommand(
        pool,
        { ...input(tenantId, 'final-key'), isFinalFailure: () => true },
        failing,
      ),
    ).rejects.toThrow(CommandFailedFinalError);

    expect(executions).toBe(1);
  });
});

describe('DATA_MODEL.md §10 — the stored result stays bounded', () => {
  it('refuses to store an oversized outcome', async () => {
    const tenantId = syntheticTenantId();
    await expect(
      runIdempotentCommand(pool, input(tenantId, 'big-key'), () =>
        Promise.resolve({ result: { blob: 'x'.repeat(MAX_IDEMPOTENCY_RESULT_BYTES + 1) } }),
      ),
    ).rejects.toThrow(IdempotencyResultTooLargeError);
  });
});
