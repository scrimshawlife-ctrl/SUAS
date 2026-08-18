/**
 * Durable async-work capability port.
 *
 * Spec citations:
 * - SUAS-specs ARCHITECTURE.md §3 invariants 4-5 (correctness-critical state is
 *   never process-local; production-critical async work survives restart)
 * - SUAS-specs ARCHITECTURE.md §8 "Durable background work" — the exact durable
 *   job product remains D-022 and is therefore not chosen here
 * - SUAS-specs ARCHITECTURE.md §10 (retries with external consequences use stable
 *   logical identity)
 * - SUAS-specs ARCHITECTURE.md §16 (volatile process-local production queues are a
 *   non-goal)
 * - SUAS-specs HANDOFF.md §3 (durable job abstraction with a fake/test
 *   implementation while the provider remains undecided)
 *
 * This file defines the seam only. No queue vendor is selected by Slice 1, and no
 * implementation here is authorized to carry production-critical work.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Whether an implementation actually survives process restart.
 * `non-durable` implementations are valid only where the released contract permits
 * a fake/test seam (LOCAL/TEST).
 */
export type JobQueueDurability = 'durable' | 'non-durable';

export interface JobEnqueueRequest {
  /** Logical work type, e.g. a Follow-Up due sweep. Owned by the enqueuing module. */
  readonly jobType: string;
  readonly payload: JsonObject;
  /**
   * Stable logical identity for the work. ARCHITECTURE.md §8/§10: duplicate or
   * replayed enqueues of the same logical work must not multiply observable
   * business effects.
   */
  readonly idempotencyKey?: string;
  /**
   * Tenant scope. ARCHITECTURE.md §3 invariant 11: tenant isolation survives jobs.
   * Absent only for genuinely tenant-independent system work.
   */
  readonly tenantId?: string;
  /** Earliest execution time, for scheduled work such as Follow-Up due processing. */
  readonly runAt?: Date;
  /** Bounded attempt ceiling. ARCHITECTURE.md §13 (bounded/backoff retry). */
  readonly maxAttempts?: number;
}

export interface EnqueuedJob {
  readonly jobId: string;
  readonly jobType: string;
  /** True when an existing job with the same idempotency key was reused. */
  readonly deduplicated: boolean;
}

export interface DurableJobQueuePort {
  /**
   * Declares whether this implementation is durable. Callers that require
   * durability must assert on this rather than assume it.
   */
  readonly durability: JobQueueDurability;
  /** Implementation name, for build-info and operational visibility. */
  readonly implementation: string;

  enqueue(request: JobEnqueueRequest): Promise<EnqueuedJob>;
}
