/**
 * Durable job queue selection.
 *
 * Spec citations:
 * - SUAS-specs ARCHITECTURE.md §8 (exact durable job product remains D-022)
 * - SUAS-specs ARCHITECTURE.md §3 invariant 5 (production-critical async work
 *   survives process/worker restart)
 * - SUAS-specs ENVIRONMENT.md §4 (a lower configuration layer may further restrict
 *   a feature; it may not enable an unavailable one)
 * - SUAS-specs ENVIRONMENT.md §5 (fail closed)
 */

import type { SuasConfig } from '../config/index.js';
import { InMemoryJobQueue } from './in-memory-queue.js';
import type { DurableJobQueuePort } from './port.js';

export class DurableJobQueueUnavailableError extends Error {
  constructor(environment: string) {
    super(
      `No durable job queue implementation is available for ${environment}. The durable job ` +
        `product remains D-022 (SUAS-specs ARCHITECTURE.md §8), and a non-durable in-memory ` +
        `queue must not carry production-critical async work (ARCHITECTURE.md §3 invariant 5, ` +
        `§16). Slice 1 provides the abstraction seam only.`,
    );
    this.name = 'DurableJobQueueUnavailableError';
  }
}

/**
 * Return the job queue for this environment.
 *
 * LOCAL and TEST receive the declared non-durable fake. STAGING and PRODUCTION
 * fail closed: selecting a durable implementation requires the D-022 decision and
 * a released manifest update, which this release does not provide.
 */
export function createJobQueue(config: SuasConfig): DurableJobQueuePort {
  if (config.environment === 'LOCAL' || config.environment === 'TEST') {
    return new InMemoryJobQueue();
  }
  throw new DurableJobQueueUnavailableError(config.environment);
}
