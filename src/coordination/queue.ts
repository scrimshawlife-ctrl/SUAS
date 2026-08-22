/**
 * Responder queue.
 *
 * Spec citations:
 * - SUAS-specs RESPONDER_WORKFLOWS.md §4 (queue contract: bounded/paginated,
 *   never cross-tenant, freshness is advisory), §11 (unbounded and cross-tenant
 *   queues are non-goals)
 * - SUAS-specs CASES.md §9 (queues are bounded/paginated; priority sorting must
 *   not load every Case into memory)
 * - SUAS-specs API.md §5 (cursor + limit, default 20, maximum 100)
 *
 * The tenant is a required argument rather than a filter option, so a caller
 * cannot omit it and accidentally read across tenants.
 */

import type { Queryable } from '../db/transaction.js';
import type { CaseStatus } from './case-transitions.js';
import type { SupportCase } from './cases.js';

/** API.md §5. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface QueueFilters {
  readonly statuses?: readonly CaseStatus[];
  readonly priorityLevels?: readonly ('GREEN' | 'YELLOW' | 'ORANGE' | 'RED')[];
  /** `unassigned` or `mine` (RESPONDER_WORKFLOWS.md §4). */
  readonly ownership?: 'unassigned' | 'mine';
  /** Required when ownership is `mine`. */
  readonly responderUserId?: string;
}

export interface QueuePage {
  readonly cases: readonly SupportCase[];
  /** Opaque keyset cursor; absent when no further page exists. */
  readonly nextCursor: string | undefined;
}

interface QueueRow {
  case_id: string;
  tenant_id: string;
  veteran_user_id: string;
  status: CaseStatus;
  priority_signal_level: string | null;
  created_at: Date;
}

/** Keyset cursor over (created_at, case_id), stable under concurrent inserts. */
function encodeCursor(createdAt: Date, caseId: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${caseId}`, 'utf8').toString('base64url');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(cursor: string): { createdAt: string; caseId: string } | undefined {
  try {
    const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (parts.length !== 2) return undefined;
    const [createdAt, caseId] = parts;
    if (createdAt === undefined || caseId === undefined) return undefined;
    // Validate the decoded shape here so a crafted-but-decodable cursor is a
    // 400 InvalidCursorError, not a 500 from the `::timestamptz` / `::uuid` cast
    // in the keyset predicate below.
    if (Number.isNaN(Date.parse(createdAt))) return undefined;
    if (!UUID_PATTERN.test(caseId)) return undefined;
    return { createdAt, caseId };
  } catch {
    return undefined;
  }
}

export class InvalidCursorError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor() {
    super('The pagination cursor is not valid.');
    this.name = 'InvalidCursorError';
  }
}

export class QueueOwnershipError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor() {
    super('Filtering the queue by "mine" requires a responder.');
    this.name = 'QueueOwnershipError';
  }
}

/**
 * Read one bounded page of the responder queue for a single tenant.
 *
 * Ordering is keyset-based on `(created_at, case_id)` so pagination does not
 * silently duplicate or omit cases as new ones arrive (API.md §5). The result is
 * advisory: `claimCase` re-checks eligibility atomically at mutation time
 * (RESPONDER_WORKFLOWS.md §4.4).
 */
export async function readCaseQueue(
  db: Queryable,
  tenantId: string,
  filters: QueueFilters = {},
  page: { cursor?: string; limit?: number } = {},
): Promise<QueuePage> {
  const limit = Math.min(Math.max(page.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  if (filters.ownership === 'mine' && filters.responderUserId === undefined) {
    throw new QueueOwnershipError();
  }

  const conditions: string[] = ['c.tenant_id = $1'];
  const values: unknown[] = [tenantId];

  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    values.push(filters.statuses);
    conditions.push(`c.status = ANY($${values.length}::suas_case_status[])`);
  }

  if (filters.priorityLevels !== undefined && filters.priorityLevels.length > 0) {
    values.push(filters.priorityLevels);
    conditions.push(`c.priority_signal_level = ANY($${values.length}::suas_signal_level[])`);
  }

  if (filters.ownership === 'unassigned') {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM case_assignments a
                   WHERE a.case_id = c.case_id AND a.status = 'ACTIVE')`,
    );
  } else if (filters.ownership === 'mine') {
    values.push(filters.responderUserId);
    conditions.push(
      `EXISTS (SELECT 1 FROM case_assignments a
               WHERE a.case_id = c.case_id AND a.status = 'ACTIVE'
                 AND a.responder_user_id = $${values.length})`,
    );
  }

  if (page.cursor !== undefined) {
    const decoded = decodeCursor(page.cursor);
    if (decoded === undefined) throw new InvalidCursorError();
    values.push(decoded.createdAt, decoded.caseId);
    conditions.push(
      `(c.created_at, c.case_id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
    );
  }

  // One row over the page size tells us whether another page exists without a
  // second count query.
  values.push(limit + 1);

  const result = await db.query<QueueRow>(
    `SELECT c.case_id, c.tenant_id, c.veteran_user_id, c.status,
            c.priority_signal_level, c.created_at
     FROM support_cases c
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.created_at DESC, c.case_id DESC
     LIMIT $${values.length}`,
    values,
  );

  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  const hasMore = result.rows.length > limit;

  return {
    cases: rows.map((row) => ({
      caseId: row.case_id,
      tenantId: row.tenant_id,
      veteranUserId: row.veteran_user_id,
      status: row.status,
      prioritySignalLevel: row.priority_signal_level ?? undefined,
    })),
    nextCursor:
      hasMore && last !== undefined ? encodeCursor(last.created_at, last.case_id) : undefined,
  };
}
