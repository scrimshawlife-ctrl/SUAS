/**
 * Settlements.
 *
 * Spec citations:
 * - SUAS-specs SETTLEMENT.md §1 (an explicit durable resolution record for one
 *   resolution cycle), §2 (required content), §3 (resolution-cycle history),
 *   §6 (veteran visibility), §8 (events/audit), §9 (non-goals)
 * - SUAS-specs DATA_MODEL.md §8
 * - SUAS-specs CASES.md §4.2 (reopen preserves prior Settlement)
 *
 * SETTLEMENT.md §3.5 rejects "one mutable settlement row" as a history model.
 * History is therefore a table of cycles, and the Case's pointer is a cache over
 * it rather than the record itself.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import type { JsonObject } from '../jobs/index.js';

export interface Settlement {
  readonly settlementId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly resolutionCycle: number;
  readonly requestedSummary: JsonObject;
  readonly occurredSummary: JsonObject;
  readonly fulfilledSummary: JsonObject;
  readonly unresolvedSummary: JsonObject;
  readonly remainingFollowUps: JsonObject[];
  readonly responderConfirmedBy: string;
  readonly veteranConfirmedBy: string | undefined;
  readonly authoredBy: string;
  readonly settledAt: Date;
}

interface SettlementRow {
  settlement_id: string;
  tenant_id: string;
  case_id: string;
  resolution_cycle: number;
  requested_summary: JsonObject;
  occurred_summary: JsonObject;
  fulfilled_summary: JsonObject;
  unresolved_summary: JsonObject;
  remaining_follow_ups: JsonObject[];
  responder_confirmed_by: string;
  veteran_confirmed_by: string | null;
  authored_by: string;
  settled_at: Date;
}

const SETTLEMENT_COLUMNS = `
  settlement_id, tenant_id, case_id, resolution_cycle, requested_summary,
  occurred_summary, fulfilled_summary, unresolved_summary, remaining_follow_ups,
  responder_confirmed_by, veteran_confirmed_by, authored_by, settled_at
`;

function toSettlement(row: SettlementRow): Settlement {
  return {
    settlementId: row.settlement_id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    resolutionCycle: row.resolution_cycle,
    requestedSummary: row.requested_summary,
    occurredSummary: row.occurred_summary,
    fulfilledSummary: row.fulfilled_summary,
    unresolvedSummary: row.unresolved_summary,
    remainingFollowUps: row.remaining_follow_ups,
    responderConfirmedBy: row.responder_confirmed_by,
    veteranConfirmedBy: row.veteran_confirmed_by ?? undefined,
    authoredBy: row.authored_by,
    settledAt: row.settled_at,
  };
}

export class SettlementContentError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(missing: readonly string[]) {
    super(
      `Settlement content is incomplete: ${missing.join(', ')} ` +
        `(SUAS-specs SETTLEMENT.md §2, §5.2).`,
    );
    this.name = 'SettlementContentError';
  }
}

/** SETTLEMENT.md §2. Every field here is required content. */
export interface SettlementContent {
  /** Referenced Service Requests and their statuses. */
  readonly requested: JsonObject;
  /** Referenced Referrals, Contact Attempts, assignments and actions. */
  readonly occurred: JsonObject;
  /** Referenced fulfillments, including partial, failed, and cancelled. */
  readonly fulfilled: JsonObject;
  /** Explicit unmet or open needs. */
  readonly unresolved: JsonObject;
  /** Accountable human author. §5.6 forbids autonomous generative authorship. */
  readonly authoredBy: string;
  readonly responderConfirmedBy: string;
  readonly veteranConfirmedBy?: string;
}

/**
 * Validate required content before anything is written.
 * SETTLEMENT.md §5.2: resolve without required Settlement content fails.
 */
export function assertSettlementContent(content: SettlementContent): void {
  const missing: string[] = [];
  if (content.requested === undefined) missing.push('what was requested');
  if (content.occurred === undefined) missing.push('what occurred');
  if (content.fulfilled === undefined) missing.push('what was fulfilled');
  if (content.unresolved === undefined) missing.push('what remains unresolved');
  if (content.authoredBy === undefined || content.authoredBy.trim() === '') {
    missing.push('an accountable author');
  }
  if (content.responderConfirmedBy === undefined || content.responderConfirmedBy.trim() === '') {
    missing.push('responder confirmation');
  }
  if (missing.length > 0) throw new SettlementContentError(missing);
}

/**
 * Next resolution cycle for a Case.
 *
 * SETTLEMENT.md §3.2-§3.3: a reopen starts a new cycle, and resolving it creates
 * a new Settlement. Derived from the highest existing cycle, not from a counter
 * that could drift.
 */
export async function nextResolutionCycle(db: Queryable, caseId: string): Promise<number> {
  const result = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(resolution_cycle), 0) + 1 AS next FROM settlements WHERE case_id = $1`,
    [caseId],
  );
  return result.rows[0]?.next ?? 1;
}

export interface CreateSettlementInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly resolutionCycle: number;
  readonly content: SettlementContent;
  /** Carried-forward responsibilities with owner and due date. §2, §4. */
  readonly remainingFollowUps: readonly JsonObject[];
}

export async function createSettlement(
  tx: Queryable,
  input: CreateSettlementInput,
): Promise<Settlement> {
  assertSettlementContent(input.content);

  const result = await tx.query<SettlementRow>(
    `INSERT INTO settlements
       (settlement_id, tenant_id, case_id, resolution_cycle, requested_summary,
        occurred_summary, fulfilled_summary, unresolved_summary, remaining_follow_ups,
        responder_confirmed_by, veteran_confirmed_by, veteran_confirmed_at, authored_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${SETTLEMENT_COLUMNS}`,
    [
      randomUUID(),
      input.tenantId,
      input.caseId,
      input.resolutionCycle,
      JSON.stringify(input.content.requested),
      JSON.stringify(input.content.occurred),
      JSON.stringify(input.content.fulfilled),
      JSON.stringify(input.content.unresolved),
      JSON.stringify(input.remainingFollowUps),
      input.content.responderConfirmedBy,
      input.content.veteranConfirmedBy ?? null,
      input.content.veteranConfirmedBy === undefined ? null : new Date(),
      input.content.authoredBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Settlement insert returned no row.');
  return toSettlement(row);
}

/**
 * The current Settlement for a Case.
 *
 * SETTLEMENT.md §3.6: deterministic, and not dependent on insertion order. The
 * highest resolution cycle is the answer regardless of the order rows arrived in.
 */
export async function findCurrentSettlement(
  db: Queryable,
  tenantId: string,
  caseId: string,
): Promise<Settlement | undefined> {
  const result = await db.query<SettlementRow>(
    `SELECT ${SETTLEMENT_COLUMNS} FROM settlements
     WHERE tenant_id = $1 AND case_id = $2
     ORDER BY resolution_cycle DESC
     LIMIT 1`,
    [tenantId, caseId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toSettlement(row);
}

/** Full history, oldest cycle first. Prior cycles remain independently addressable. */
export async function listSettlements(
  db: Queryable,
  tenantId: string,
  caseId: string,
): Promise<Settlement[]> {
  const result = await db.query<SettlementRow>(
    `SELECT ${SETTLEMENT_COLUMNS} FROM settlements
     WHERE tenant_id = $1 AND case_id = $2
     ORDER BY resolution_cycle ASC`,
    [tenantId, caseId],
  );
  return result.rows.map(toSettlement);
}

export async function findSettlement(
  db: Queryable,
  tenantId: string,
  settlementId: string,
): Promise<Settlement | undefined> {
  const result = await db.query<SettlementRow>(
    `SELECT ${SETTLEMENT_COLUMNS} FROM settlements
     WHERE tenant_id = $1 AND settlement_id = $2`,
    [tenantId, settlementId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toSettlement(row);
}

/**
 * Fields a veteran may read.
 *
 * SETTLEMENT.md §6: a Settlement is not a clinical chart, and internal records
 * are not exposed merely because the Settlement references them. This projection
 * therefore drops the occurred summary — which references Contact Attempts and
 * internal responder actions — and every internal actor identity.
 */
export function veteranVisibleSettlement(settlement: Settlement): JsonObject {
  return {
    settlement_id: settlement.settlementId,
    resolution_cycle: settlement.resolutionCycle,
    requested: settlement.requestedSummary,
    fulfilled: settlement.fulfilledSummary,
    unresolved: settlement.unresolvedSummary,
    remaining_follow_ups: settlement.remainingFollowUps,
    settled_at: settlement.settledAt.toISOString(),
  };
}
