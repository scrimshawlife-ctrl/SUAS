/**
 * Non-durable in-memory job queue — LOCAL/TEST seam only.
 *
 * Spec citations:
 * - SUAS-specs HANDOFF.md §3 (fake/test implementation while the durable job
 *   provider remains undecided under D-022)
 * - SUAS-specs ARCHITECTURE.md §16 (volatile process-local production queues are a
 *   non-goal)
 *
 * This implementation loses all queued work on process exit. It declares itself
 * `non-durable` so no caller can mistake it for the durable seam, and the factory
 * refuses to hand it to STAGING or PRODUCTION.
 */

import { randomUUID } from 'node:crypto';
import type {
  DurableJobQueuePort,
  EnqueuedJob,
  JobEnqueueRequest,
  JobQueueDurability,
} from './port.js';

export interface RecordedJob extends JobEnqueueRequest {
  readonly jobId: string;
  readonly enqueuedAt: Date;
}

export class InMemoryJobQueue implements DurableJobQueuePort {
  readonly durability: JobQueueDurability = 'non-durable';
  readonly implementation = 'in-memory-fake';

  private readonly jobs: RecordedJob[] = [];
  private readonly byIdempotencyKey = new Map<string, RecordedJob>();

  enqueue(request: JobEnqueueRequest): Promise<EnqueuedJob> {
    const dedupeKey =
      request.idempotencyKey === undefined
        ? undefined
        : `${request.tenantId ?? '-'}:${request.jobType}:${request.idempotencyKey}`;

    if (dedupeKey !== undefined) {
      const existing = this.byIdempotencyKey.get(dedupeKey);
      if (existing !== undefined) {
        return Promise.resolve({
          jobId: existing.jobId,
          jobType: existing.jobType,
          deduplicated: true,
        });
      }
    }

    const job: RecordedJob = { ...request, jobId: randomUUID(), enqueuedAt: new Date() };
    this.jobs.push(job);
    if (dedupeKey !== undefined) {
      this.byIdempotencyKey.set(dedupeKey, job);
    }

    return Promise.resolve({ jobId: job.jobId, jobType: job.jobType, deduplicated: false });
  }

  /** Test-only inspection of enqueued work. */
  enqueued(): readonly RecordedJob[] {
    return this.jobs;
  }

  clear(): void {
    this.jobs.length = 0;
    this.byIdempotencyKey.clear();
  }
}
