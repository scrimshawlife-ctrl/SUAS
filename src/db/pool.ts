/**
 * PostgreSQL connection pool.
 *
 * Spec citations:
 * - SUAS-specs ARCHITECTURE.md §3 invariant 2 (one logical PostgreSQL system of record)
 * - SUAS-specs ENVIRONMENT.md §3 "Data / persistence" (bounded DATABASE_POOL_MAX)
 * - SUAS-specs ARCHITECTURE.md §13 (finite timeouts)
 */

import { Pool } from 'pg';
import type { SuasConfig } from '../config/index.js';

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      'DATABASE_URL is not configured; persistence is unavailable in this process ' +
        '(SUAS-specs ENVIRONMENT.md §3 "Data / persistence").',
    );
    this.name = 'DatabaseNotConfiguredError';
  }
}

export function createPool(config: SuasConfig): Pool {
  const url = config.database.url;
  if (url === undefined) {
    throw new DatabaseNotConfiguredError();
  }
  return new Pool({
    connectionString: url,
    max: config.database.poolMax,
    // Finite timeouts, per ARCHITECTURE.md §13. These are implementation
    // mechanism values; no production SLO is implied (RELEASE_MANIFEST-0.1.1.md).
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}
