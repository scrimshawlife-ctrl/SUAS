/**
 * Transaction helper.
 *
 * Spec citations:
 * - SUAS-specs EVENT_MODEL.md §5.3 — domain state and its required Domain Event
 *   are committed atomically, or through an outbox-equivalent pattern that cannot
 *   permanently lose the event after domain commit.
 * - SUAS-specs ARCHITECTURE.md §10 (atomic/idempotent handling).
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Minimal query surface shared by a Pool and a PoolClient. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Run `fn` inside a single transaction. The callback receives the client, so
 * every write it performs — domain state, Domain Event, and outbox row — commits
 * or rolls back together.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      // Preserve the original failure; a rollback error is secondary.
    });
    throw error;
  } finally {
    client.release();
  }
}
