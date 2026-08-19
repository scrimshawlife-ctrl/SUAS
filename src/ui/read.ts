/**
 * Surface reads: canonical facts a surface is allowed to render.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §7.2 (QRF labels rest on canonical facts)
 * - SUAS-specs MVP_REFERENCE.md §9 (summaries only when derived from real data)
 * - SUAS-specs API.md §4 (tenant is server-derived, never a request parameter)
 * - SUAS-specs PRIVACY.md (minimum necessary)
 *
 * These functions select the narrowest set of columns a surface needs. Tenant is
 * always an argument, never a filter the caller may omit.
 */

import type { Queryable } from '../db/index.js';
import type { ServiceRequestStatus } from '../coordination/index.js';
import type { QrfFacts } from './qrf.js';

/** Statuses that mean the request is no longer in flight. */
const TERMINAL_STATUSES: readonly ServiceRequestStatus[] = [
  'CLOSED',
  'CONFIRMED',
  'CANCELLED',
  'EXPIRED',
];

interface QrfRow {
  service_request_id: string;
  status: ServiceRequestStatus;
  responder_assigned: boolean;
}

export interface ActiveQrf {
  readonly serviceRequestId: string;
  readonly facts: QrfFacts;
}

/**
 * The veteran's in-flight peer-support request, if one exists.
 *
 * `responderNotificationDelivered` is always `false`, and that is a finding
 * rather than a stub. MVP_REFERENCE.md §7.2 permits `RESPONDER_NOTIFIED` only
 * when the system "actually knows" a notification occurred, and the released
 * `notifications` table (migration 0008) records no Case or Service Request
 * linkage — there is no join from a delivery back to this request. Inventing
 * one through a `dedupe_key` naming convention would manufacture the very
 * certainty §7.2 forbids, so the surface stays on `SEARCHING` after assignment.
 * Returned to specs; see the Slice 10 conformance record §10.
 */
export async function readActiveQrf(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
): Promise<ActiveQrf | undefined> {
  const result = await db.query<QrfRow>(
    `SELECT r.service_request_id,
            r.status,
            EXISTS (
              SELECT 1 FROM case_assignments a
               WHERE a.case_id = r.case_id
                 AND a.tenant_id = r.tenant_id
                 AND a.status = 'ACTIVE'
            ) AS responder_assigned
       FROM service_requests r
       JOIN support_cases c
         ON c.case_id = r.case_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1
        AND c.veteran_user_id = $2
        AND r.category = 'PEER_SUPPORT'
        AND r.status <> ALL($3::suas_service_request_status[])
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [tenantId, veteranUserId, TERMINAL_STATUSES],
  );

  const row = result.rows[0];
  if (row === undefined) return undefined;

  return {
    serviceRequestId: row.service_request_id,
    facts: {
      requestStatus: row.status,
      responderAssigned: row.responder_assigned,
      // See the note above: not knowable from released schema.
      responderNotificationDelivered: false,
      // Degradation is observed by the caller that owns the dependency, not
      // inferred here from the absence of progress.
      coordinationDegraded: false,
      // UNFULFILLABLE already carries this; there is no separate released
      // "matching ran and found nobody" fact to read.
      matchingExhausted: false,
    },
  };
}
