/**
 * Consent Grants and Consent Events.
 *
 * Spec citations:
 * - SUAS-specs CONSENT.md §2 (grant shape), §4 (revocation; history preserved;
 *   a revoked row is never reused), §6 (published templates only), §7 (states),
 *   §8 (events)
 * - SUAS-specs PRIVACY.md §2 (consent history preserved), §10 (no purge)
 * - SUAS-specs EVENT_MODEL.md §3 (`CONSENT_GRANTED`, `CONSENT_REVOKED`)
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import type { JsonObject } from '../jobs/index.js';
import { assertTemplatePublished } from './templates.js';
import {
  assertPermissionScope,
  type ConsentEventType,
  type ConsentGrantStatus,
  type ConsentPermission,
  type ConsentScope,
  type GranteeType,
} from './vocabulary.js';

export interface ConsentGrant {
  readonly consentGrantId: string;
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly permission: ConsentPermission;
  readonly scope: ConsentScope;
  readonly purpose: string;
  readonly granteeType: GranteeType;
  readonly granteeId: string;
  readonly consentTemplateVersion: string;
  readonly status: ConsentGrantStatus;
  readonly grantedAt: Date;
  readonly expiresAt: Date | undefined;
  readonly revokedAt: Date | undefined;
}

interface GrantRow {
  consent_grant_id: string;
  tenant_id: string;
  veteran_user_id: string;
  permission: ConsentPermission;
  scope: ConsentScope;
  purpose: string;
  grantee_type: GranteeType;
  grantee_id: string;
  consent_template_version: string;
  status: ConsentGrantStatus;
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const GRANT_COLUMNS = `
  consent_grant_id, tenant_id, veteran_user_id, permission, scope, purpose,
  grantee_type, grantee_id, consent_template_version, status, granted_at,
  expires_at, revoked_at
`;

function toGrant(row: GrantRow): ConsentGrant {
  return {
    consentGrantId: row.consent_grant_id,
    tenantId: row.tenant_id,
    veteranUserId: row.veteran_user_id,
    permission: row.permission,
    scope: row.scope,
    purpose: row.purpose,
    granteeType: row.grantee_type,
    granteeId: row.grantee_id,
    consentTemplateVersion: row.consent_template_version,
    status: row.status,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}

export interface ConsentEventRecord {
  readonly consentEventId: string;
  readonly eventType: ConsentEventType;
  readonly consentGrantId: string | undefined;
  readonly permission: ConsentPermission | undefined;
  readonly scope: ConsentScope | undefined;
  readonly granteeType: GranteeType | undefined;
  readonly granteeId: string | undefined;
  readonly occurredAt: Date;
}

export interface RecordConsentEventInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly eventType: ConsentEventType;
  readonly consentGrantId?: string;
  readonly permission?: ConsentPermission;
  readonly scope?: ConsentScope;
  readonly granteeType?: GranteeType;
  readonly granteeId?: string;
  readonly purpose?: string;
  readonly payload?: JsonObject;
}

/**
 * Append immutable consent history.
 *
 * CONSENT.md §7 requires a `DENIED` event when an action requiring consent is
 * refused, even though no grant exists, which is why the grant reference is
 * optional.
 */
export async function recordConsentEvent(
  db: Queryable,
  input: RecordConsentEventInput,
): Promise<ConsentEventRecord> {
  const consentEventId = randomUUID();
  const result = await db.query<{ occurred_at: Date }>(
    `INSERT INTO consent_events
       (consent_event_id, tenant_id, consent_grant_id, veteran_user_id, event_type,
        permission, scope, grantee_type, grantee_id, purpose, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING occurred_at`,
    [
      consentEventId,
      input.tenantId,
      input.consentGrantId ?? null,
      input.veteranUserId,
      input.eventType,
      input.permission ?? null,
      input.scope ?? null,
      input.granteeType ?? null,
      input.granteeId ?? null,
      input.purpose ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Consent event insert returned no row.');

  return {
    consentEventId,
    eventType: input.eventType,
    consentGrantId: input.consentGrantId,
    permission: input.permission,
    scope: input.scope,
    granteeType: input.granteeType,
    granteeId: input.granteeId,
    occurredAt: row.occurred_at,
  };
}

export interface GrantConsentInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly permission: ConsentPermission;
  readonly scope: ConsentScope;
  readonly purpose: string;
  readonly granteeType: GranteeType;
  readonly granteeId: string;
  readonly consentTemplateVersion: string;
  readonly expiresAt?: Date;
}

/**
 * Issue a Consent Grant and its `GRANTED` history entry.
 *
 * Callers additionally emit the `CONSENT_GRANTED` Domain Event in the same
 * transaction; that carries the request context they own.
 */
export async function grantConsent(db: Queryable, input: GrantConsentInput): Promise<ConsentGrant> {
  assertPermissionScope(input.permission, input.scope);
  // CONSENT.md §6: never ship a grant against an unpublished template.
  await assertTemplatePublished(db, input.consentTemplateVersion);

  const result = await db.query<GrantRow>(
    `INSERT INTO consent_grants
       (consent_grant_id, tenant_id, veteran_user_id, permission, scope, purpose,
        grantee_type, grantee_id, consent_template_version, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${GRANT_COLUMNS}`,
    [
      randomUUID(),
      input.tenantId,
      input.veteranUserId,
      input.permission,
      input.scope,
      input.purpose,
      input.granteeType,
      input.granteeId,
      input.consentTemplateVersion,
      input.expiresAt ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Consent grant insert returned no row.');
  const grant = toGrant(row);

  await recordConsentEvent(db, {
    tenantId: grant.tenantId,
    veteranUserId: grant.veteranUserId,
    eventType: 'GRANTED',
    consentGrantId: grant.consentGrantId,
    permission: grant.permission,
    scope: grant.scope,
    granteeType: grant.granteeType,
    granteeId: grant.granteeId,
    purpose: grant.purpose,
    payload: { consent_template_version: grant.consentTemplateVersion },
  });

  return grant;
}

/**
 * Revoke a grant.
 *
 * CONSENT.md §4: sets status and `revoked_at`, writes a ConsentEvent, and
 * preserves history. The row is never deleted and never reused — re-consent
 * inserts a new grant.
 */
export async function revokeConsent(
  db: Queryable,
  tenantId: string,
  consentGrantId: string,
): Promise<ConsentGrant | undefined> {
  const result = await db.query<GrantRow>(
    `UPDATE consent_grants
       SET status = 'REVOKED', revoked_at = now()
     WHERE tenant_id = $1 AND consent_grant_id = $2 AND status = 'ACTIVE'
     RETURNING ${GRANT_COLUMNS}`,
    [tenantId, consentGrantId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const grant = toGrant(row);

  await recordConsentEvent(db, {
    tenantId: grant.tenantId,
    veteranUserId: grant.veteranUserId,
    eventType: 'REVOKED',
    consentGrantId: grant.consentGrantId,
    permission: grant.permission,
    scope: grant.scope,
    granteeType: grant.granteeType,
    granteeId: grant.granteeId,
    purpose: grant.purpose,
  });

  return grant;
}

/**
 * Find the live grant matching a disclosure exactly.
 *
 * The match is on the full tuple with no widening: CONSENT.md §2.1 forbids
 * treating a YELLOW grant as covering RED, or a support_signal grant as covering
 * checkin_answers. Expiry is applied here so an unswept expired grant cannot
 * authorize a use.
 */
export async function findActiveGrant(
  db: Queryable,
  params: {
    tenantId: string;
    veteranUserId: string;
    permission: ConsentPermission;
    scope: ConsentScope;
    granteeType: GranteeType;
    granteeId: string;
  },
): Promise<ConsentGrant | undefined> {
  const result = await db.query<GrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM consent_grants
     WHERE tenant_id = $1 AND veteran_user_id = $2 AND permission = $3 AND scope = $4
       AND grantee_type = $5 AND grantee_id = $6 AND status = 'ACTIVE'
       AND (expires_at IS NULL OR expires_at > now())`,
    [
      params.tenantId,
      params.veteranUserId,
      params.permission,
      params.scope,
      params.granteeType,
      params.granteeId,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toGrant(row);
}

export async function listGrantsForVeteran(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
): Promise<ConsentGrant[]> {
  const result = await db.query<GrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM consent_grants
     WHERE tenant_id = $1 AND veteran_user_id = $2
     ORDER BY granted_at DESC
     LIMIT 200`,
    [tenantId, veteranUserId],
  );
  return result.rows.map(toGrant);
}

export async function listConsentEvents(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
): Promise<ConsentEventRecord[]> {
  const result = await db.query<{
    consent_event_id: string;
    event_type: ConsentEventType;
    consent_grant_id: string | null;
    permission: ConsentPermission | null;
    scope: ConsentScope | null;
    grantee_type: GranteeType | null;
    grantee_id: string | null;
    occurred_at: Date;
  }>(
    `SELECT consent_event_id, event_type, consent_grant_id, permission, scope,
            grantee_type, grantee_id, occurred_at
     FROM consent_events
     WHERE tenant_id = $1 AND veteran_user_id = $2
     ORDER BY occurred_at DESC
     LIMIT 200`,
    [tenantId, veteranUserId],
  );
  return result.rows.map((row) => ({
    consentEventId: row.consent_event_id,
    eventType: row.event_type,
    consentGrantId: row.consent_grant_id ?? undefined,
    permission: row.permission ?? undefined,
    scope: row.scope ?? undefined,
    granteeType: row.grantee_type ?? undefined,
    granteeId: row.grantee_id ?? undefined,
    occurredAt: row.occurred_at,
  }));
}

/**
 * Sweep grants whose expiry has passed, writing `EXPIRED` history.
 *
 * Evaluation already refuses an expired grant, so this only keeps stored status
 * truthful. It is not retention: no row is deleted, and D-007 remains open.
 */
export async function expireDueGrants(db: Queryable): Promise<number> {
  const result = await db.query<GrantRow>(
    `UPDATE consent_grants
       SET status = 'EXPIRED'
     WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= now()
     RETURNING ${GRANT_COLUMNS}`,
  );

  for (const row of result.rows) {
    const grant = toGrant(row);
    await recordConsentEvent(db, {
      tenantId: grant.tenantId,
      veteranUserId: grant.veteranUserId,
      eventType: 'EXPIRED',
      consentGrantId: grant.consentGrantId,
      permission: grant.permission,
      scope: grant.scope,
      granteeType: grant.granteeType,
      granteeId: grant.granteeId,
    });
  }

  return result.rows.length;
}
