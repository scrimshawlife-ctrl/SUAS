/**
 * Resource catalog.
 *
 * Spec citations:
 * - SUAS-specs RESOURCES.md §1 (a Resource may be API-backed, referral-only,
 *   manual, information-only, or unavailable), §2 (core fields), §3 (freshness
 *   bands), §4 (freshness is not live availability), §5 (verification), §6
 *   (veteran-visible fields), §7 (active/inactive), §8 (query contract), §9
 *   (audit only — no Resource Domain Event exists), §10 (non-goals)
 * - SUAS-specs PROVIDER_INTEGRATIONS.md §3 (integration modes)
 * - SUAS-specs API.md §5 (cursor and limit)
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import { assertServiceCategory, type ServiceCategory } from '../coordination/index.js';
import type { IntegrationMode } from './port.js';
import { INTEGRATION_MODES } from './port.js';

/** RESOURCES.md §3. Computed from server time at read, never stored (§9). */
export type FreshnessBand = 'FRESH' | 'AGING' | 'STALE' | 'UNVERIFIED';

export const FRESHNESS_AGING_DAYS = 30;
export const FRESHNESS_STALE_DAYS = 90;

export interface Resource {
  readonly resourceId: string;
  readonly tenantId: string;
  readonly serviceName: string;
  readonly category: ServiceCategory;
  readonly counties: readonly string[];
  readonly integrationModes: readonly IntegrationMode[];
  readonly active: boolean;
  readonly lastVerifiedAt: Date | undefined;
  readonly verificationSource: string | undefined;
  readonly contactMethod: string | undefined;
  readonly referralMethod: string | undefined;
  readonly hours: string | undefined;
  readonly cost: string | undefined;
  readonly eligibility: string | undefined;
}

interface ResourceRow {
  resource_id: string;
  tenant_id: string;
  service_name: string;
  category: ServiceCategory;
  counties: string[];
  integration_modes: IntegrationMode[];
  active: boolean;
  last_verified_at: Date | null;
  verification_source: string | null;
  contact_method: string | null;
  referral_method: string | null;
  hours: string | null;
  cost: string | null;
  eligibility: string | null;
}

const RESOURCE_COLUMNS = `
  resource_id, tenant_id, service_name, category, counties, integration_modes,
  active, last_verified_at, verification_source, contact_method, referral_method,
  hours, cost, eligibility
`;

function toResource(row: ResourceRow): Resource {
  return {
    resourceId: row.resource_id,
    tenantId: row.tenant_id,
    serviceName: row.service_name,
    category: row.category,
    counties: row.counties,
    integrationModes: row.integration_modes,
    active: row.active,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    verificationSource: row.verification_source ?? undefined,
    contactMethod: row.contact_method ?? undefined,
    referralMethod: row.referral_method ?? undefined,
    hours: row.hours ?? undefined,
    cost: row.cost ?? undefined,
    eligibility: row.eligibility ?? undefined,
  };
}

export class ResourceValidationError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ResourceValidationError';
  }
}

export class InactiveResourceError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super(
      'An inactive Resource is not selectable for new fulfillment or referrals ' +
        '(SUAS-specs RESOURCES.md §7).',
    );
    this.name = 'InactiveResourceError';
  }
}

/**
 * Freshness band at read time.
 *
 * RESOURCES.md §3 defines the bands and §9 states the band is computed from
 * server time at read, not stored business state — so it is a pure function
 * rather than a column.
 */
export function freshnessBand(
  lastVerifiedAt: Date | undefined,
  now: Date = new Date(),
): FreshnessBand {
  if (lastVerifiedAt === undefined) return 'UNVERIFIED';
  const ageDays = (now.getTime() - lastVerifiedAt.getTime()) / 86_400_000;
  if (ageDays < FRESHNESS_AGING_DAYS) return 'FRESH';
  if (ageDays <= FRESHNESS_STALE_DAYS) return 'AGING';
  return 'STALE';
}

/** RESOURCES.md §3: a stale Resource is warned about, never silently hidden. */
export function requiresStaleWarning(band: FreshnessBand): boolean {
  return band === 'STALE' || band === 'AGING' || band === 'UNVERIFIED';
}

export interface CreateResourceInput {
  readonly tenantId: string;
  readonly serviceName: string;
  readonly category: string;
  readonly counties?: readonly string[];
  readonly integrationModes?: readonly string[];
  readonly serviceProviderId?: string;
  readonly contactMethod?: string;
  readonly referralMethod?: string;
  readonly hours?: string;
  readonly cost?: string;
  readonly eligibility?: string;
}

export async function createResource(db: Queryable, input: CreateResourceInput): Promise<Resource> {
  assertServiceCategory(input.category);

  const modes = input.integrationModes ?? [];
  for (const mode of modes) {
    if (!(INTEGRATION_MODES as readonly string[]).includes(mode)) {
      throw new ResourceValidationError(
        `"${mode}" is not a known integration mode. Allowed: ${INTEGRATION_MODES.join(', ')} ` +
          `(SUAS-specs PROVIDER_INTEGRATIONS.md §3).`,
      );
    }
  }

  const result = await db.query<ResourceRow>(
    `INSERT INTO resources
       (resource_id, tenant_id, service_provider_id, service_name, category, counties,
        integration_modes, contact_method, referral_method, hours, cost, eligibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7::suas_integration_mode[], $8, $9, $10, $11, $12)
     RETURNING ${RESOURCE_COLUMNS}`,
    [
      randomUUID(),
      input.tenantId,
      input.serviceProviderId ?? null,
      input.serviceName,
      input.category,
      input.counties ?? [],
      modes,
      input.contactMethod ?? null,
      input.referralMethod ?? null,
      input.hours ?? null,
      input.cost ?? null,
      input.eligibility ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Resource insert returned no row.');
  return toResource(row);
}

export interface VerifyResourceInput {
  readonly tenantId: string;
  readonly resourceId: string;
  readonly verificationSource: string;
  readonly actorId: string;
  /** Stable identity so a replayed verification does not fabricate history. */
  readonly idempotencyKey?: string;
}

/**
 * Record a verification.
 *
 * RESOURCES.md §5: an explicit audited action, idempotent on replay, and the
 * source text must carry no credentials. §9 has no Resource Domain Event, so this
 * writes an Audit Event only.
 */
export async function verifyResource(
  tx: Queryable,
  input: VerifyResourceInput,
): Promise<{ resource: Resource; deduplicated: boolean }> {
  if (input.idempotencyKey !== undefined) {
    const seen = await tx.query(
      `SELECT 1 FROM audit_events
       WHERE tenant_id = $1 AND event_type = 'RESOURCE_VERIFIED'
         AND payload->>'idempotency_key' = $2`,
      [input.tenantId, input.idempotencyKey],
    );
    if ((seen.rowCount ?? 0) > 0) {
      const existing = await findResource(tx, input.tenantId, input.resourceId);
      if (existing === undefined) throw new Error('Verified resource no longer exists.');
      return { resource: existing, deduplicated: true };
    }
  }

  const result = await tx.query<ResourceRow>(
    `UPDATE resources
       SET last_verified_at = now(), verification_source = $3, updated_at = now()
     WHERE tenant_id = $1 AND resource_id = $2
     RETURNING ${RESOURCE_COLUMNS}`,
    [input.tenantId, input.resourceId, input.verificationSource],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ResourceValidationError('No such Resource.');

  await appendAuditEvent(tx, {
    eventType: 'RESOURCE_VERIFIED',
    action: 'VERIFY_RESOURCE',
    targetType: 'Resource',
    targetId: input.resourceId,
    aggregateType: 'Resource',
    aggregateId: input.resourceId,
    tenantId: input.tenantId,
    actorType: 'ORG_ADMIN',
    actorId: input.actorId,
    payload: {
      verification_source: input.verificationSource,
      ...(input.idempotencyKey !== undefined ? { idempotency_key: input.idempotencyKey } : {}),
    },
  });

  return { resource: toResource(row), deduplicated: false };
}

/**
 * Activate a Resource.
 * RESOURCES.md §11: activation is rejected when verification evidence is missing.
 * The database CHECK enforces it; this surfaces a usable message first.
 */
export async function setResourceActive(
  tx: Queryable,
  input: { tenantId: string; resourceId: string; active: boolean; actorId: string },
): Promise<Resource> {
  const current = await findResource(tx, input.tenantId, input.resourceId);
  if (current === undefined) throw new ResourceValidationError('No such Resource.');

  if (
    input.active &&
    (current.lastVerifiedAt === undefined || current.verificationSource === undefined)
  ) {
    throw new ResourceValidationError(
      'A Resource cannot be activated without last_verified_at and a verification source ' +
        '(SUAS-specs RESOURCES.md §2, §11).',
    );
  }

  const result = await tx.query<ResourceRow>(
    `UPDATE resources
       SET active = $3,
           deactivated_at = CASE WHEN $3 THEN NULL ELSE now() END,
           updated_at = now()
     WHERE tenant_id = $1 AND resource_id = $2
     RETURNING ${RESOURCE_COLUMNS}`,
    [input.tenantId, input.resourceId, input.active],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ResourceValidationError('No such Resource.');

  await appendAuditEvent(tx, {
    eventType: input.active ? 'RESOURCE_ACTIVATED' : 'RESOURCE_DEACTIVATED',
    action: input.active ? 'ACTIVATE_RESOURCE' : 'DEACTIVATE_RESOURCE',
    targetType: 'Resource',
    targetId: input.resourceId,
    aggregateType: 'Resource',
    aggregateId: input.resourceId,
    tenantId: input.tenantId,
    actorType: 'ORG_ADMIN',
    actorId: input.actorId,
    payload: { active: input.active },
  });

  return toResource(row);
}

export async function findResource(
  db: Queryable,
  tenantId: string,
  resourceId: string,
): Promise<Resource | undefined> {
  const result = await db.query<ResourceRow>(
    `SELECT ${RESOURCE_COLUMNS} FROM resources WHERE tenant_id = $1 AND resource_id = $2`,
    [tenantId, resourceId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toResource(row);
}

export interface ResourceSearchFilters {
  readonly category?: ServiceCategory;
  readonly county?: string;
  readonly activeOnly?: boolean;
  readonly integrationMode?: IntegrationMode;
}

export interface ResourceSearchResult {
  readonly resource: Resource;
  readonly freshness: FreshnessBand;
  readonly staleWarning: boolean;
}

/**
 * Bounded, tenant-scoped catalog search.
 *
 * RESOURCES.md §8 and §10: never load the full catalog, never cross a tenant,
 * and never make an eligibility judgement — filters are recorded criteria only.
 */
export async function searchResources(
  db: Queryable,
  tenantId: string,
  filters: ResourceSearchFilters = {},
  page: { limit?: number } = {},
): Promise<ResourceSearchResult[]> {
  const limit = Math.min(Math.max(page.limit ?? 20, 1), 100);

  const result = await db.query<ResourceRow>(
    `SELECT ${RESOURCE_COLUMNS} FROM resources
     WHERE tenant_id = $1
       AND ($2::suas_service_category IS NULL OR category = $2)
       AND ($3::boolean IS NOT TRUE OR active = true)
       AND ($4::text IS NULL OR counties = '{}' OR $4 = ANY(counties))
       AND ($5::suas_integration_mode IS NULL OR $5 = ANY(integration_modes))
     ORDER BY active DESC, last_verified_at DESC NULLS LAST, resource_id
     LIMIT $6`,
    [
      tenantId,
      filters.category ?? null,
      filters.activeOnly ?? null,
      filters.county ?? null,
      filters.integrationMode ?? null,
      limit,
    ],
  );

  const now = new Date();
  return result.rows.map((row) => {
    const resource = toResource(row);
    const band = freshnessBand(resource.lastVerifiedAt, now);
    return { resource, freshness: band, staleWarning: requiresStaleWarning(band) };
  });
}

/**
 * Veteran-facing projection.
 *
 * RESOURCES.md §6: public fields only. Internal adapter identifiers,
 * verification internals, and routing metadata are excluded.
 */
export function veteranVisibleResource(
  resource: Resource,
): Record<string, string | string[] | undefined> {
  return {
    service_name: resource.serviceName,
    category: resource.category,
    counties: [...resource.counties],
    hours: resource.hours,
    cost: resource.cost,
    contact_method: resource.contactMethod,
  };
}
