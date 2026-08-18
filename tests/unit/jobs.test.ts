/**
 * Durable job seam evidence.
 *
 * SUAS-specs ARCHITECTURE.md §3 invariant 5, §8 (D-022 undecided), §10, §16;
 * SUAS-specs HANDOFF.md §3.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  createJobQueue,
  DurableJobQueueUnavailableError,
  InMemoryJobQueue,
} from '../../src/jobs/index.js';
import { validEnv } from '../helpers/env.js';

const STRONG_SECRET = 'a'.repeat(48);

describe('job queue selection', () => {
  it.each(['LOCAL', 'TEST'])('provides the declared non-durable fake in %s', (environment) => {
    const queue = createJobQueue(loadConfig(validEnv({ SUAS_ENV: environment })));
    expect(queue.durability).toBe('non-durable');
    expect(queue.implementation).toBe('in-memory-fake');
  });

  it('refuses to hand a non-durable queue to STAGING and cites D-022', () => {
    const config = loadConfig(
      validEnv({ SUAS_ENV: 'STAGING', SUAS_SESSION_SECRET: STRONG_SECRET }),
    );
    expect(() => createJobQueue(config)).toThrow(DurableJobQueueUnavailableError);
    expect(() => createJobQueue(config)).toThrow(/D-022/);
  });
});

describe('InMemoryJobQueue', () => {
  it('enqueues distinct work', async () => {
    const queue = new InMemoryJobQueue();
    const first = await queue.enqueue({ jobType: 'follow_up.due', payload: { case_id: 'a' } });
    const second = await queue.enqueue({ jobType: 'follow_up.due', payload: { case_id: 'b' } });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(first.jobId).not.toBe(second.jobId);
    expect(queue.enqueued()).toHaveLength(2);
  });

  it('reuses the same job for a repeated idempotency key', async () => {
    const queue = new InMemoryJobQueue();
    const request = {
      jobType: 'notification.send',
      payload: { notification_id: 'n1' },
      idempotencyKey: 'n1',
      tenantId: 't1',
    };
    const first = await queue.enqueue(request);
    const replay = await queue.enqueue(request);
    expect(replay.deduplicated).toBe(true);
    expect(replay.jobId).toBe(first.jobId);
    expect(queue.enqueued()).toHaveLength(1);
  });

  it('scopes idempotency by tenant so tenants cannot collide', async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue({ jobType: 'x', payload: {}, idempotencyKey: 'k', tenantId: 't1' });
    const other = await queue.enqueue({
      jobType: 'x',
      payload: {},
      idempotencyKey: 'k',
      tenantId: 't2',
    });
    expect(other.deduplicated).toBe(false);
    expect(queue.enqueued()).toHaveLength(2);
  });
});
