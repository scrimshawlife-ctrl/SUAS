/**
 * Provider Router.
 *
 * Spec citations:
 * - SUAS-specs PROVIDER_INTEGRATIONS.md §2 rule 5 (consent and minimum-necessary
 *   disclosure evaluated before transmitting veteran data), rule 6 (provider
 *   outage must not silently fail a Service Request), rule 8 (manual coordination
 *   remains available), rule 9 (routing happens above the adapter), §10
 *   (concurrency), §12 (health-driven degradation), §13 (projection)
 * - SUAS-specs FULFILLMENT.md §3.2 (idempotency), §3.3 (unknown outcome), §4
 *   (provider-neutral execution), §7 (reroute without a new Service Request)
 * - SUAS-specs CONSENT.md §3.8, §3.10-§3.11 (evaluate before each external
 *   mutation that newly discloses; a reroute re-evaluates for the new grantee)
 *
 * Routing lives here rather than in any adapter, so replacing a provider never
 * touches the Service Request or Fulfillment state machines.
 */

import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import type { ServiceCategory } from '../coordination/index.js';
import { requireDisclosure } from '../consent/index.js';
import { projectForProvider } from '../privacy/index.js';
import type { JsonObject } from '../jobs/index.js';
import {
  AttemptAlreadyInFlightError,
  createAttempt,
  findAttempt,
  findInFlightAttempt,
  recordAttemptOutcome,
  ReconciliationRequiredError,
  upsertFulfillment,
  type FulfillmentAttempt,
} from './attempts.js';
import { capabilityForCategory } from './port.js';
import type { AdapterHealth, FulfillmentAdapter, FulfillmentOutcome } from './port.js';

export interface AdapterConfiguration {
  readonly adapterConfigurationId: string;
  readonly tenantId: string;
  readonly adapterId: string;
  readonly capability: ServiceCategory;
  readonly integrationMode: string;
  readonly enabled: boolean;
  readonly routingPriority: number;
  readonly health: AdapterHealth;
  readonly coverageCounties: readonly string[];
}

export class NoRoutableAdapterError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(capability: ServiceCategory) {
    super(
      `No enabled, healthy adapter is configured for ${capability}. The Service Request is ` +
        `preserved and a manual coordination path remains available ` +
        `(SUAS-specs PROVIDER_INTEGRATIONS.md §2 rules 6 and 8).`,
    );
    this.name = 'NoRoutableAdapterError';
  }
}

export class AdapterNotRegisteredError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(adapterId: string) {
    super(`Adapter "${adapterId}" is configured but no implementation is registered.`);
    this.name = 'AdapterNotRegisteredError';
  }
}

/** Health states a router will not send new work to. PROVIDER_INTEGRATIONS.md §12. */
const UNROUTABLE_HEALTH: readonly AdapterHealth[] = ['UNAVAILABLE', 'MISCONFIGURED'];

/**
 * Adapters available to this process, keyed by opaque adapter id.
 *
 * Registration is explicit and environment-owned. Provider-specific implementations
 * are composed above this provider-neutral registry and never alter domain semantics.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, FulfillmentAdapter>();

  register(adapter: FulfillmentAdapter): void {
    this.adapters.set(adapter.adapterId, adapter);
  }

  get(adapterId: string): FulfillmentAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  clear(): void {
    this.adapters.clear();
  }
}

/**
 * Select the adapter for a capability.
 *
 * PROVIDER_INTEGRATIONS.md §2 rule 9: routing by coverage, capability, and health
 * happens above the adapter. Ordering is priority then adapter id, so selection
 * is deterministic rather than dependent on row order.
 */
export async function selectAdapterConfiguration(
  db: Queryable,
  params: {
    tenantId: string;
    capability: ServiceCategory;
    county?: string;
    preferAdapterId?: string;
    excludeAdapterIds?: readonly string[];
  },
): Promise<AdapterConfiguration | undefined> {
  const result = await db.query<{
    adapter_configuration_id: string;
    tenant_id: string;
    adapter_id: string;
    capability: ServiceCategory;
    integration_mode: string;
    enabled: boolean;
    routing_priority: number;
    health: AdapterHealth;
    coverage_counties: string[];
  }>(
    `SELECT adapter_configuration_id, tenant_id, adapter_id, capability, integration_mode,
            enabled, routing_priority, health, coverage_counties
     FROM provider_adapter_configurations
     WHERE tenant_id = $1
       AND capability = $2
       AND enabled = true
       AND health <> ALL($3::suas_adapter_health[])
       AND ($4::text IS NULL OR adapter_id = $4)
       AND ($5::text[] IS NULL OR NOT (adapter_id = ANY($5)))
       AND (coverage_counties = '{}' OR $6::text IS NULL OR $6 = ANY(coverage_counties))
     ORDER BY routing_priority ASC, adapter_id ASC
     LIMIT 1`,
    [
      params.tenantId,
      params.capability,
      UNROUTABLE_HEALTH,
      params.preferAdapterId ?? null,
      params.excludeAdapterIds !== undefined && params.excludeAdapterIds.length > 0
        ? params.excludeAdapterIds
        : null,
      params.county ?? null,
    ],
  );

  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        adapterConfigurationId: row.adapter_configuration_id,
        tenantId: row.tenant_id,
        adapterId: row.adapter_id,
        capability: row.capability,
        integrationMode: row.integration_mode,
        enabled: row.enabled,
        routingPriority: row.routing_priority,
        health: row.health,
        coverageCounties: row.coverage_counties,
      };
}

export interface InitiateFulfillmentInput {
  readonly tenantId: string;
  readonly serviceRequestId: string;
  readonly caseId: string;
  readonly veteranUserId: string;
  readonly capability: ServiceCategory;
  readonly actorId: string;
  /** Source record the projection is built from, for transmitting adapters. */
  readonly disclosureSource?: Readonly<Record<string, unknown>>;
  readonly county?: string;
  readonly preferAdapterId?: string;
  readonly excludeAdapterIds?: readonly string[];
  readonly correlationId?: string;
}

export interface InitiateFulfillmentResult {
  readonly attempt: FulfillmentAttempt;
  readonly outcome: FulfillmentOutcome;
  /** Field names disclosed to the adapter, for the audit trail. */
  readonly disclosedFields: readonly string[];
}

/**
 * Initiate one deliberate Fulfillment Attempt.
 *
 * Order is deliberate: an in-flight attempt blocks first, then routing, then
 * consent and projection, and only then is an attempt row written. Nothing is
 * persisted for a disclosure that was refused, and no adapter is called before
 * the disclosure decision.
 */
export async function initiateFulfillment(
  pool: Pool,
  registry: AdapterRegistry,
  input: InitiateFulfillmentInput,
): Promise<InitiateFulfillmentResult> {
  // FULFILLMENT.md §3.3: a prior unknown outcome must be reconciled before
  // another attempt could duplicate a booking.
  const inFlight = await findInFlightAttempt(pool, input.tenantId, input.serviceRequestId);
  if (inFlight !== undefined) {
    throw inFlight.status === 'PROVIDER_UNKNOWN'
      ? new ReconciliationRequiredError()
      : new AttemptAlreadyInFlightError();
  }

  const configuration = await selectAdapterConfiguration(pool, {
    tenantId: input.tenantId,
    capability: input.capability,
    ...(input.county !== undefined ? { county: input.county } : {}),
    ...(input.preferAdapterId !== undefined ? { preferAdapterId: input.preferAdapterId } : {}),
    ...(input.excludeAdapterIds !== undefined
      ? { excludeAdapterIds: input.excludeAdapterIds }
      : {}),
  });
  if (configuration === undefined) throw new NoRoutableAdapterError(input.capability);

  const adapter = registry.get(configuration.adapterId);
  if (adapter === undefined) throw new AdapterNotRegisteredError(configuration.adapterId);

  // PROVIDER_INTEGRATIONS.md §2 rule 5 and §13: consent and the minimum-necessary
  // projection are evaluated before any transmission. A manual path transmits
  // nothing, so neither applies to it — which is precisely why manual
  // coordination stays available while capability projections are unreleased.
  let projection: JsonObject = {};
  let disclosedFields: readonly string[] = [];

  if (adapter.transmitsExternally) {
    await requireDisclosure(pool, {
      tenantId: input.tenantId,
      veteranUserId: input.veteranUserId,
      permission: 'can_share',
      scope: 'service_request_fulfillment',
      granteeType: 'SERVICE_PROVIDER',
      granteeId: configuration.adapterId,
      purpose: `Fulfil a ${input.capability} Service Request`,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    // Throws when no released capability contract exists, which is the current
    // state of every capability. See the Slice 4 and Slice 7 conformance records.
    const built = projectForProvider(
      capabilityForCategory(input.capability),
      input.disclosureSource ?? {},
    );
    projection = built.fields as JsonObject;
    disclosedFields = built.disclosedFieldNames;
  }

  const attempt = await withTransaction(pool, (tx) =>
    createAttempt(tx, {
      tenantId: input.tenantId,
      serviceRequestId: input.serviceRequestId,
      capability: input.capability,
      adapterId: configuration.adapterId,
      integrationMode: adapter.integrationMode,
      initialStatus: adapter.transmitsExternally ? 'PROVIDER_PENDING' : 'MANUAL_PENDING',
    }),
  );

  let outcome: FulfillmentOutcome;
  try {
    outcome = await adapter.initiate({
      serviceRequestId: input.serviceRequestId,
      capability: input.capability,
      idempotencyKey: attempt.idempotencyKey,
      projection,
    });
  } catch (error) {
    // FULFILLMENT.md §3.3: the mutation may have succeeded. Record the ambiguity
    // rather than assuming failure — assuming failure is what produces a second
    // ride or a second room.
    const failureReason = error instanceof Error ? error.message : String(error);
    const unknown = await withTransaction(pool, (tx) =>
      recordAttemptOutcome(tx, input.tenantId, attempt.fulfillmentAttemptId, {
        status: 'PROVIDER_UNKNOWN',
        failureReason: failureReason.slice(0, 500),
      }),
    );
    await auditDisclosure(
      pool,
      input,
      configuration.adapterId,
      disclosedFields,
      'PROVIDER_UNKNOWN',
    );
    return {
      attempt: unknown,
      outcome: { status: 'PROVIDER_UNKNOWN', fulfillmentMode: 'UNAVAILABLE' },
      disclosedFields,
    };
  }

  const recorded = await withTransaction(pool, async (tx) => {
    const updated = await recordAttemptOutcome(tx, input.tenantId, attempt.fulfillmentAttemptId, {
      status: outcome.status,
      ...(outcome.externalReference !== undefined
        ? { externalReference: outcome.externalReference }
        : {}),
      ...(outcome.lastProviderStatus !== undefined
        ? { lastProviderStatus: outcome.lastProviderStatus }
        : {}),
      ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
      ...(outcome.metadata !== undefined ? { metadata: outcome.metadata } : {}),
    });

    // FULFILLMENT.md §1 and §5: provider acceptance is evidence for the SUAS
    // ACCEPTED fulfillment record. It does not move the Service Request; that is
    // a documented command in DISPATCH.md.
    if (outcome.status === 'PROVIDER_ACCEPTED') {
      await upsertFulfillment(tx, {
        tenantId: input.tenantId,
        serviceRequestId: input.serviceRequestId,
        fulfillmentAttemptId: attempt.fulfillmentAttemptId,
        state: 'ACCEPTED',
        fulfillmentMode: outcome.fulfillmentMode,
      });
    }

    return updated;
  });

  await auditDisclosure(pool, input, configuration.adapterId, disclosedFields, outcome.status);

  return { attempt: recorded, outcome, disclosedFields };
}

/**
 * Reconcile an attempt whose outcome is unknown.
 *
 * FULFILLMENT.md §3.3 and PROVIDER_INTEGRATIONS.md §10.5: query provider status
 * before another mutation is attempted. Reconciliation reuses the attempt's
 * existing idempotency key, so it can never book a second time.
 */
export async function reconcileAttempt(
  pool: Pool,
  registry: AdapterRegistry,
  input: { tenantId: string; attemptId: string },
): Promise<FulfillmentAttempt> {
  const attempt = await findAttempt(pool, input.tenantId, input.attemptId);
  if (attempt === undefined) throw new Error(`No fulfillment attempt ${input.attemptId}.`);

  const adapter = registry.get(attempt.adapterId);
  if (adapter === undefined) throw new AdapterNotRegisteredError(attempt.adapterId);

  const outcome = await adapter.reconcile({
    serviceRequestId: attempt.serviceRequestId,
    capability: attempt.capability,
    idempotencyKey: attempt.idempotencyKey,
    // Reconciliation reads provider-side state; it discloses nothing new.
    projection: {},
  });

  return withTransaction(pool, (tx) =>
    recordAttemptOutcome(tx, input.tenantId, attempt.fulfillmentAttemptId, {
      status: outcome.status,
      ...(outcome.externalReference !== undefined
        ? { externalReference: outcome.externalReference }
        : {}),
      ...(outcome.lastProviderStatus !== undefined
        ? { lastProviderStatus: outcome.lastProviderStatus }
        : {}),
    }),
  );
}

/**
 * CONSENT.md §5: an external provider disclosure Audit Event records the request,
 * the attempt, the adapter identity, the consent basis, the purpose, and the
 * field names disclosed — never a payload dump.
 */
async function auditDisclosure(
  pool: Pool,
  input: InitiateFulfillmentInput,
  adapterId: string,
  disclosedFields: readonly string[],
  outcomeStatus: string,
): Promise<void> {
  await withTransaction(pool, (tx) =>
    appendAuditEvent(tx, {
      eventType: 'PROVIDER_FULFILLMENT_ATTEMPTED',
      action: 'INITIATE_FULFILLMENT_ATTEMPT',
      targetType: 'ProviderAdapter',
      targetId: adapterId,
      aggregateType: 'ServiceRequest',
      aggregateId: input.serviceRequestId,
      tenantId: input.tenantId,
      actorType: 'RESPONDER',
      actorId: input.actorId,
      payload: {
        capability: input.capability,
        outcome_status: outcomeStatus,
        disclosed_fields: [...disclosedFields],
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    }),
  );
}
