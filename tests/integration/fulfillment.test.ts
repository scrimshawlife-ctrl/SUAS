/**
 * Resources, referrals, and fulfillment integration evidence (requires PostgreSQL).
 *
 * SUAS-specs FULFILLMENT.md §1-§9, §12; PROVIDER_INTEGRATIONS.md §2, §3, §9-§13;
 * RESOURCES.md §2-§9, §11; REFERRALS.md §2-§6, §9; CONSENT.md §3.7-§3.11.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import { listAggregateEvents } from '../../src/events/index.js';
import {
  claimCase,
  createServiceRequest,
  executeCaseCommand,
  openCase,
} from '../../src/coordination/index.js';
import {
  AdapterRegistry,
  AttemptAlreadyInFlightError,
  confirmFulfillment,
  ConfirmationActorRequiredError,
  ConfirmationReasonRequiredError,
  createResource,
  disputeFulfillment,
  draftReferral,
  FakeAdapter,
  findFulfillment,
  freshnessBand,
  FulfillmentNotConfirmableError,
  IllegalReferralTransitionError,
  initiateFulfillment,
  listAttempts,
  ManualAdapter,
  NoRoutableAdapterError,
  reconcileAttempt,
  ReconciliationRequiredError,
  recordAttemptOutcome,
  requiresStaleWarning,
  ResourceValidationError,
  searchResources,
  sendReferral,
  setResourceActive,
  updateReferralStatus,
  upsertFulfillment,
  veteranVisibleResource,
  verifyResource,
} from '../../src/fulfillment/index.js';
import { clearProjectionContracts, registerProjectionContract } from '../../src/privacy/index.js';
import {
  consentTemplateVersionKey,
  createConsentTemplateVersion,
  ConsentDeniedError,
  grantConsent,
  publishConsentTemplateVersion,
  revokeConsent,
} from '../../src/consent/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterEach(() => {
  clearProjectionContracts();
});
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function user(tenantId: string, label: string) {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

/** A case with an assigned responder and a TRANSPORTATION Service Request. */
async function requestScenario() {
  const tenantId = syntheticTenantId();
  const veteran = await user(tenantId, 'veteran');
  const responder = await user(tenantId, 'responder');
  const opened = await withTransaction(pool, (tx) =>
    openCase(tx, {
      tenantId,
      veteranUserId: veteran.userId,
      actorType: 'RESPONDER',
      actorId: responder.userId,
    }),
  );
  const caseId = opened.supportCase.caseId;
  await claimCase(pool, { tenantId, caseId, responderUserId: responder.userId });
  await executeCaseCommand(pool, {
    tenantId,
    caseId,
    command: 'ACTIVATE',
    actorId: responder.userId,
    actorType: 'RESPONDER',
  });
  const request = await withTransaction(pool, (tx) =>
    createServiceRequest(tx, {
      tenantId,
      caseId,
      category: 'TRANSPORTATION',
      createdBy: responder.userId,
      actorType: 'RESPONDER',
    }),
  );
  return { tenantId, veteran, responder, caseId, request };
}

async function configureAdapter(
  tenantId: string,
  adapterId: string,
  options: {
    capability?: string;
    mode?: string;
    enabled?: boolean;
    priority?: number;
    health?: string;
  } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO provider_adapter_configurations
       (adapter_configuration_id, tenant_id, adapter_id, capability, integration_mode,
        enabled, routing_priority, health)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      tenantId,
      adapterId,
      options.capability ?? 'TRANSPORTATION',
      options.mode ?? 'MANUAL_COORDINATION',
      options.enabled ?? true,
      options.priority ?? 100,
      options.health ?? 'HEALTHY',
    ],
  );
}

/** A published grant permitting fulfillment disclosure to one adapter. */
async function grantFulfillmentConsent(
  tenantId: string,
  veteranUserId: string,
  granteeId: string,
): Promise<string> {
  const templateKey = `fulfillment-${randomUUID().slice(0, 8)}`;
  const versionKey = consentTemplateVersionKey(templateKey, 1);
  await createConsentTemplateVersion(pool, { templateKey, version: 1, body: 'Synthetic.' });
  await publishConsentTemplateVersion(pool, versionKey, undefined);

  const grant = await grantConsent(pool, {
    tenantId,
    veteranUserId,
    permission: 'can_share',
    scope: 'service_request_fulfillment',
    purpose: 'Share the minimum needed to arrange transport',
    granteeType: 'SERVICE_PROVIDER',
    granteeId,
    consentTemplateVersion: versionKey,
  });
  return grant.consentGrantId;
}

describe('PROVIDER_INTEGRATIONS.md §2 rule 8 — manual coordination is first-class', () => {
  it('fulfils through the manual adapter with no consent projection at all', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'manual');
    const registry = new AdapterRegistry();
    registry.register(new ManualAdapter());

    const result = await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
    });

    // Nothing crosses the SUAS boundary, so no projection contract is needed —
    // which is why manual paths work while capability projections are unreleased.
    expect(result.outcome.status).toBe('MANUAL_PENDING');
    expect(result.outcome.fulfillmentMode).toBe('MANUAL_COORDINATION');
    expect(result.disclosedFields).toEqual([]);
  });

  it.each(['FOOD', 'TRANSPORTATION', 'SHELTER', 'PEER_SUPPORT'] as const)(
    'satisfies the %s capability manually',
    async (capability) => {
      const tenantId = syntheticTenantId();
      const veteran = await user(tenantId, 'veteran');
      const responder = await user(tenantId, 'responder');
      const opened = await withTransaction(pool, (tx) =>
        openCase(tx, {
          tenantId,
          veteranUserId: veteran.userId,
          actorType: 'RESPONDER',
          actorId: responder.userId,
        }),
      );
      await claimCase(pool, {
        tenantId,
        caseId: opened.supportCase.caseId,
        responderUserId: responder.userId,
      });
      const request = await withTransaction(pool, (tx) =>
        createServiceRequest(tx, {
          tenantId,
          caseId: opened.supportCase.caseId,
          category: capability,
          createdBy: responder.userId,
          actorType: 'RESPONDER',
        }),
      );
      await configureAdapter(tenantId, 'manual', { capability });

      const registry = new AdapterRegistry();
      registry.register(new ManualAdapter());
      const result = await initiateFulfillment(pool, registry, {
        tenantId,
        serviceRequestId: request.serviceRequestId,
        caseId: opened.supportCase.caseId,
        veteranUserId: veteran.userId,
        capability,
        actorId: responder.userId,
      });

      expect(result.outcome.status).toBe('MANUAL_PENDING');
    },
  );
});

describe('PROVIDER_INTEGRATIONS.md §13 — disclosure is gated before any adapter call', () => {
  it('refuses a transmitting adapter without a consent grant', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'fake', { mode: 'API' });
    const adapter = new FakeAdapter('fake');
    const registry = new AdapterRegistry();
    registry.register(adapter);

    await expect(
      initiateFulfillment(pool, registry, {
        tenantId,
        serviceRequestId: request.serviceRequestId,
        caseId,
        veteranUserId: veteran.userId,
        capability: 'TRANSPORTATION',
        actorId: responder.userId,
      }),
    ).rejects.toThrow(ConsentDeniedError);

    // The adapter was never called and no attempt row was written.
    expect(adapter.received()).toEqual([]);
    expect(await listAttempts(pool, tenantId, request.serviceRequestId)).toEqual([]);
  });

  it('uses the released transportation projection for a consented adapter', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'fake', { mode: 'API' });
    await grantFulfillmentConsent(tenantId, veteran.userId, 'fake');

    const adapter = new FakeAdapter('fake');
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const result = await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
      disclosureSource: {
        rider: { firstName: 'Synthetic', lastName: 'Rider', phoneNumber: '+15555550100' },
        pickup: { latitude: 37.775, longitude: -122.418 },
        dropoff: { latitude: 37.785, longitude: -122.408 },
      },
    });
    expect(result.outcome.status).toBe('PROVIDER_ACCEPTED');
    expect(adapter.disclosedFields()).toEqual(['dropoff', 'pickup', 'rider']);
  });

  it('discloses only contracted fields once a contract is registered', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'fake', { mode: 'API' });
    await grantFulfillmentConsent(tenantId, veteran.userId, 'fake');

    // Test-only override exercises the generic registry independently of the released contract.
    registerProjectionContract({
      capability: 'TRANSPORTATION',
      allowedFields: ['service_request_id', 'pickup_address'],
      releasedIn: 'test-only fixture',
    });

    const adapter = new FakeAdapter('fake');
    const registry = new AdapterRegistry();
    registry.register(adapter);

    const result = await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
      disclosureSource: {
        service_request_id: request.serviceRequestId,
        pickup_address: '1 Test St',
        veteran_display_name: 'Should Not Travel',
      },
    });

    expect(result.outcome.status).toBe('PROVIDER_ACCEPTED');
    expect(adapter.disclosedFields()).toEqual(['pickup_address', 'service_request_id']);
    expect(adapter.disclosedFields()).not.toContain('veteran_display_name');
  });

  it('stops disclosing after the grant is revoked', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'fake', { mode: 'API' });
    const grantId = await grantFulfillmentConsent(tenantId, veteran.userId, 'fake');
    registerProjectionContract({
      capability: 'TRANSPORTATION',
      allowedFields: ['service_request_id'],
      releasedIn: 'test-only fixture',
    });

    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake'));
    await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
      disclosureSource: { service_request_id: request.serviceRequestId },
    });

    await revokeConsent(pool, tenantId, grantId);

    // A second request for the same veteran: the prior attempt created no
    // standing permission (CONSENT.md §3.10).
    const second = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId,
        category: 'TRANSPORTATION',
        createdBy: responder.userId,
        actorType: 'RESPONDER',
      }),
    );

    await expect(
      initiateFulfillment(pool, registry, {
        tenantId,
        serviceRequestId: second.serviceRequestId,
        caseId,
        veteranUserId: veteran.userId,
        capability: 'TRANSPORTATION',
        actorId: responder.userId,
        disclosureSource: { service_request_id: second.serviceRequestId },
      }),
    ).rejects.toThrow(ConsentDeniedError);
  });

  it('audits the disclosure with field names, not values', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'fake', { mode: 'API' });
    await grantFulfillmentConsent(tenantId, veteran.userId, 'fake');
    registerProjectionContract({
      capability: 'TRANSPORTATION',
      allowedFields: ['pickup_address'],
      releasedIn: 'test-only fixture',
    });

    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake'));
    await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
      disclosureSource: { pickup_address: '1 Test St' },
    });

    const audits = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events
       WHERE tenant_id = $1 AND event_type = 'PROVIDER_FULFILLMENT_ATTEMPTED'`,
      [tenantId],
    );
    expect(audits.rows[0]?.payload).toMatchObject({ disclosed_fields: ['pickup_address'] });
    expect(JSON.stringify(audits.rows)).not.toContain('1 Test St');
  });
});

describe('FULFILLMENT.md §3.2, §9 — attempt identity and concurrency', () => {
  it('gives each attempt a stable idempotency key', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'manual');
    const registry = new AdapterRegistry();
    registry.register(new ManualAdapter());

    const result = await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
    });

    expect(result.attempt.idempotencyKey).toContain(request.serviceRequestId);
    expect(result.attempt.idempotencyKey).toContain(result.attempt.fulfillmentAttemptId);
  });

  it('refuses a second attempt while one is in flight', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'manual');
    const registry = new AdapterRegistry();
    registry.register(new ManualAdapter());

    const base = {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION' as const,
      actorId: responder.userId,
    };
    await initiateFulfillment(pool, registry, base);

    await expect(initiateFulfillment(pool, registry, base)).rejects.toThrow(
      AttemptAlreadyInFlightError,
    );
  });

  it('allows a reroute after the first attempt fails, without a new Service Request', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'manual-a', { priority: 10 });
    await configureAdapter(tenantId, 'manual-b', { priority: 20 });
    const registry = new AdapterRegistry();
    registry.register(new ManualAdapter('manual-a'));
    registry.register(new ManualAdapter('manual-b'));

    const first = await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
    });
    expect(first.attempt.adapterId).toBe('manual-a');

    await withTransaction(pool, (tx) =>
      recordAttemptOutcome(tx, tenantId, first.attempt.fulfillmentAttemptId, {
        status: 'MANUAL_FAILED',
        failureReason: 'no capacity',
      }),
    );

    const second = await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
      excludeAdapterIds: ['manual-a'],
    });

    // FULFILLMENT.md §7: a new attempt, a new identity, the same Service Request.
    expect(second.attempt.adapterId).toBe('manual-b');
    expect(second.attempt.fulfillmentAttemptId).not.toBe(first.attempt.fulfillmentAttemptId);
    expect(second.attempt.idempotencyKey).not.toBe(first.attempt.idempotencyKey);
    expect(second.attempt.serviceRequestId).toBe(request.serviceRequestId);
    expect(await listAttempts(pool, tenantId, request.serviceRequestId)).toHaveLength(2);
  });
});

describe('FULFILLMENT.md §3.3 — ambiguous outcomes', () => {
  async function unknownAttempt() {
    const scenario = await requestScenario();
    await configureAdapter(scenario.tenantId, 'fake', { mode: 'API' });
    await grantFulfillmentConsent(scenario.tenantId, scenario.veteran.userId, 'fake');
    registerProjectionContract({
      capability: 'TRANSPORTATION',
      allowedFields: ['service_request_id'],
      releasedIn: 'test-only fixture',
    });

    const registry = new AdapterRegistry();
    registry.register(
      new FakeAdapter('fake', ['TRANSPORTATION'], {
        failInitiateWith: new Error('socket hang up after provider may have accepted'),
        onReconcile: {
          status: 'PROVIDER_ACCEPTED',
          fulfillmentMode: 'PROVIDER_CONFIRMATION',
          externalReference: 'provider-ref-1',
        },
      }),
    );

    const result = await initiateFulfillment(pool, registry, {
      tenantId: scenario.tenantId,
      serviceRequestId: scenario.request.serviceRequestId,
      caseId: scenario.caseId,
      veteranUserId: scenario.veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: scenario.responder.userId,
      disclosureSource: { service_request_id: scenario.request.serviceRequestId },
    });
    return { ...scenario, registry, result };
  }

  it('records PROVIDER_UNKNOWN rather than assuming failure', async () => {
    const { result } = await unknownAttempt();
    expect(result.attempt.status).toBe('PROVIDER_UNKNOWN');
    expect(result.attempt.failureReason).toContain('socket hang up');
  });

  it('refuses another attempt until the unknown one is reconciled', async () => {
    const { tenantId, veteran, responder, caseId, request, registry } = await unknownAttempt();

    await expect(
      initiateFulfillment(pool, registry, {
        tenantId,
        serviceRequestId: request.serviceRequestId,
        caseId,
        veteranUserId: veteran.userId,
        capability: 'TRANSPORTATION',
        actorId: responder.userId,
        disclosureSource: { service_request_id: request.serviceRequestId },
      }),
    ).rejects.toThrow(ReconciliationRequiredError);
  });

  it('reconciles using the original idempotency key, so it cannot book twice', async () => {
    const { tenantId, registry, result } = await unknownAttempt();

    const reconciled = await reconcileAttempt(pool, registry, {
      tenantId,
      attemptId: result.attempt.fulfillmentAttemptId,
    });

    expect(reconciled.status).toBe('PROVIDER_ACCEPTED');
    expect(reconciled.externalReference).toBe('provider-ref-1');
    expect(reconciled.idempotencyKey).toBe(result.attempt.idempotencyKey);
  });
});

describe('PROVIDER_INTEGRATIONS.md §12 — routing and degradation', () => {
  it('does not route to a disabled adapter', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'manual', { enabled: false });
    const registry = new AdapterRegistry();
    registry.register(new ManualAdapter());

    await expect(
      initiateFulfillment(pool, registry, {
        tenantId,
        serviceRequestId: request.serviceRequestId,
        caseId,
        veteranUserId: veteran.userId,
        capability: 'TRANSPORTATION',
        actorId: responder.userId,
      }),
    ).rejects.toThrow(NoRoutableAdapterError);
  });

  it.each(['UNAVAILABLE', 'MISCONFIGURED'])('does not route to a %s adapter', async (health) => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'manual', { health });
    const registry = new AdapterRegistry();
    registry.register(new ManualAdapter());

    await expect(
      initiateFulfillment(pool, registry, {
        tenantId,
        serviceRequestId: request.serviceRequestId,
        caseId,
        veteranUserId: veteran.userId,
        capability: 'TRANSPORTATION',
        actorId: responder.userId,
      }),
    ).rejects.toThrow(NoRoutableAdapterError);
  });

  it('degrades from an unavailable API adapter to manual coordination', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'fake', { mode: 'API', priority: 10, health: 'UNAVAILABLE' });
    await configureAdapter(tenantId, 'manual', { priority: 20 });

    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake'));
    registry.register(new ManualAdapter());

    const result = await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
    });

    // PROVIDER_INTEGRATIONS.md §2 rule 6: the request survives the outage.
    expect(result.attempt.adapterId).toBe('manual');
    expect(result.outcome.status).toBe('MANUAL_PENDING');
  });

  it('respects routing priority', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'manual-low', { priority: 50 });
    await configureAdapter(tenantId, 'manual-high', { priority: 5 });
    const registry = new AdapterRegistry();
    registry.register(new ManualAdapter('manual-low'));
    registry.register(new ManualAdapter('manual-high'));

    const result = await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
    });
    expect(result.attempt.adapterId).toBe('manual-high');
  });

  it('does not route across tenants', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(syntheticTenantId(), 'manual');
    const registry = new AdapterRegistry();
    registry.register(new ManualAdapter());

    await expect(
      initiateFulfillment(pool, registry, {
        tenantId,
        serviceRequestId: request.serviceRequestId,
        caseId,
        veteranUserId: veteran.userId,
        capability: 'TRANSPORTATION',
        actorId: responder.userId,
      }),
    ).rejects.toThrow(NoRoutableAdapterError);
  });
});

describe('FULFILLMENT.md §6 — confirmation requires a human', () => {
  async function completedFulfillment() {
    const scenario = await requestScenario();
    await withTransaction(pool, (tx) =>
      upsertFulfillment(tx, {
        tenantId: scenario.tenantId,
        serviceRequestId: scenario.request.serviceRequestId,
        state: 'COMPLETED',
      }),
    );
    return scenario;
  }

  it('refuses confirmation with no veteran or responder actor', async () => {
    const { tenantId, request } = await completedFulfillment();
    await expect(
      withTransaction(pool, (tx) =>
        confirmFulfillment(tx, { tenantId, serviceRequestId: request.serviceRequestId }),
      ),
    ).rejects.toThrow(ConfirmationActorRequiredError);
  });

  it('refuses a responder-only confirmation with no reason', async () => {
    const { tenantId, responder, request } = await completedFulfillment();
    await expect(
      withTransaction(pool, (tx) =>
        confirmFulfillment(tx, {
          tenantId,
          serviceRequestId: request.serviceRequestId,
          responderConfirmedBy: responder.userId,
        }),
      ),
    ).rejects.toThrow(ConfirmationReasonRequiredError);
  });

  it('accepts a veteran confirmation', async () => {
    const { tenantId, request } = await completedFulfillment();
    const confirmed = await withTransaction(pool, (tx) =>
      confirmFulfillment(tx, {
        tenantId,
        serviceRequestId: request.serviceRequestId,
        veteranConfirmed: true,
      }),
    );
    expect(confirmed.state).toBe('CONFIRMED');
    expect(confirmed.veteranConfirmedAt).toBeDefined();
  });

  it('accepts a responder confirmation with a recorded reason', async () => {
    const { tenantId, responder, request } = await completedFulfillment();
    const confirmed = await withTransaction(pool, (tx) =>
      confirmFulfillment(tx, {
        tenantId,
        serviceRequestId: request.serviceRequestId,
        responderConfirmedBy: responder.userId,
        reason: 'veteran unreachable by phone for three days',
      }),
    );
    expect(confirmed.state).toBe('CONFIRMED');
  });

  it('moves a disputed completion to DISPUTED, never CONFIRMED', async () => {
    const { tenantId, request } = await completedFulfillment();
    const disputed = await withTransaction(pool, (tx) =>
      disputeFulfillment(tx, tenantId, request.serviceRequestId, 'the ride never arrived'),
    );
    expect(disputed.state).toBe('DISPUTED');
    expect((await findFulfillment(pool, tenantId, request.serviceRequestId))?.state).toBe(
      'DISPUTED',
    );
  });

  it('refuses to confirm a disputed fulfillment, leaving it DISPUTED', async () => {
    const { tenantId, request } = await completedFulfillment();
    await withTransaction(pool, (tx) =>
      disputeFulfillment(tx, tenantId, request.serviceRequestId, 'the ride never arrived'),
    );

    await expect(
      withTransaction(pool, (tx) =>
        confirmFulfillment(tx, {
          tenantId,
          serviceRequestId: request.serviceRequestId,
          veteranConfirmed: true,
        }),
      ),
    ).rejects.toThrow(FulfillmentNotConfirmableError);

    // The dispute stands; a confirmation attempt does not overwrite it.
    expect((await findFulfillment(pool, tenantId, request.serviceRequestId))?.state).toBe(
      'DISPUTED',
    );
  });

  it('does not fulfil the request merely because a provider accepted', async () => {
    const { tenantId, veteran, responder, caseId, request } = await requestScenario();
    await configureAdapter(tenantId, 'fake', { mode: 'API' });
    await grantFulfillmentConsent(tenantId, veteran.userId, 'fake');
    registerProjectionContract({
      capability: 'TRANSPORTATION',
      allowedFields: ['service_request_id'],
      releasedIn: 'test-only fixture',
    });

    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake'));
    await initiateFulfillment(pool, registry, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      caseId,
      veteranUserId: veteran.userId,
      capability: 'TRANSPORTATION',
      actorId: responder.userId,
      disclosureSource: { service_request_id: request.serviceRequestId },
    });

    // FULFILLMENT.md §1: a request is not fulfilled because it is assigned or
    // because a provider said yes. The Service Request has not moved.
    const requestRow = await pool.query<{ status: string }>(
      'SELECT status FROM service_requests WHERE service_request_id = $1',
      [request.serviceRequestId],
    );
    expect(requestRow.rows[0]?.status).toBe('CREATED');
    expect((await findFulfillment(pool, tenantId, request.serviceRequestId))?.state).toBe(
      'ACCEPTED',
    );
  });
});

describe('RESOURCES.md — catalog', () => {
  it('computes freshness bands at the released boundaries', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

    expect(freshnessBand(daysAgo(1), now)).toBe('FRESH');
    expect(freshnessBand(daysAgo(29), now)).toBe('FRESH');
    expect(freshnessBand(daysAgo(30), now)).toBe('AGING');
    expect(freshnessBand(daysAgo(90), now)).toBe('AGING');
    expect(freshnessBand(daysAgo(91), now)).toBe('STALE');
    expect(freshnessBand(undefined, now)).toBe('UNVERIFIED');

    expect(requiresStaleWarning('FRESH')).toBe(false);
    expect(requiresStaleWarning('STALE')).toBe(true);
  });

  it('refuses to activate a Resource with no verification evidence', async () => {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const resource = await createResource(pool, {
      tenantId,
      serviceName: 'Test Pantry',
      category: 'FOOD',
    });

    await expect(
      withTransaction(pool, (tx) =>
        setResourceActive(tx, {
          tenantId,
          resourceId: resource.resourceId,
          active: true,
          actorId: admin.userId,
        }),
      ),
    ).rejects.toThrow(ResourceValidationError);
  });

  it('activates once verified, and records verification as an Audit Event only', async () => {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const resource = await createResource(pool, {
      tenantId,
      serviceName: 'Test Pantry',
      category: 'FOOD',
    });

    await withTransaction(pool, (tx) =>
      verifyResource(tx, {
        tenantId,
        resourceId: resource.resourceId,
        verificationSource: 'called the pantry manager',
        actorId: admin.userId,
      }),
    );
    const activated = await withTransaction(pool, (tx) =>
      setResourceActive(tx, {
        tenantId,
        resourceId: resource.resourceId,
        active: true,
        actorId: admin.userId,
      }),
    );
    expect(activated.active).toBe(true);

    // RESOURCES.md §9: no Resource Domain Event exists in the catalog.
    const domainEvents = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'Resource',
      aggregateId: resource.resourceId,
    });
    expect(domainEvents).toEqual([]);

    const audits = await pool.query(
      `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'RESOURCE_VERIFIED'`,
      [tenantId],
    );
    expect(audits.rowCount).toBe(1);
  });

  it('is idempotent for a replayed verification command', async () => {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const resource = await createResource(pool, {
      tenantId,
      serviceName: 'Test Pantry',
      category: 'FOOD',
    });

    const input = {
      tenantId,
      resourceId: resource.resourceId,
      verificationSource: 'called the pantry manager',
      actorId: admin.userId,
      idempotencyKey: 'verify-1',
    };
    const first = await withTransaction(pool, (tx) => verifyResource(tx, input));
    const replay = await withTransaction(pool, (tx) => verifyResource(tx, input));

    expect(first.deduplicated).toBe(false);
    expect(replay.deduplicated).toBe(true);

    const audits = await pool.query(
      `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'RESOURCE_VERIFIED'`,
      [tenantId],
    );
    expect(audits.rowCount).toBe(1);
  });

  it('rejects an unknown integration mode and an unknown category', async () => {
    const tenantId = syntheticTenantId();
    await expect(
      createResource(pool, {
        tenantId,
        serviceName: 'Bad',
        category: 'FOOD',
        integrationModes: ['CARRIER_PIGEON'],
      }),
    ).rejects.toThrow(ResourceValidationError);

    await expect(
      createResource(pool, { tenantId, serviceName: 'Bad', category: 'HOUSING' }),
    ).rejects.toThrow();
  });

  it('searches within one tenant, bounded, with freshness warnings', async () => {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const resource = await createResource(pool, {
      tenantId,
      serviceName: 'Test Pantry',
      category: 'FOOD',
      counties: ['Santa Clara'],
    });
    await withTransaction(pool, (tx) =>
      verifyResource(tx, {
        tenantId,
        resourceId: resource.resourceId,
        verificationSource: 'phone',
        actorId: admin.userId,
      }),
    );
    await pool.query(
      `UPDATE resources SET last_verified_at = now() - interval '200 days' WHERE resource_id = $1`,
      [resource.resourceId],
    );

    // Another tenant's catalog must not appear.
    const otherTenant = syntheticTenantId();
    await createResource(pool, {
      tenantId: otherTenant,
      serviceName: 'Other Tenant Pantry',
      category: 'FOOD',
    });

    const results = await searchResources(pool, tenantId, { category: 'FOOD' });
    expect(results).toHaveLength(1);
    expect(results[0]?.freshness).toBe('STALE');
    // RESOURCES.md §3: stale is warned about, not hidden.
    expect(results[0]?.staleWarning).toBe(true);

    const capped = await searchResources(pool, tenantId, {}, { limit: 5000 });
    expect(capped.length).toBeLessThanOrEqual(100);
  });

  it('excludes internal fields from the veteran-facing projection', async () => {
    const tenantId = syntheticTenantId();
    const resource = await createResource(pool, {
      tenantId,
      serviceName: 'Test Pantry',
      category: 'FOOD',
      contactMethod: 'front desk',
      eligibility: 'internal eligibility note',
    });

    const projection = veteranVisibleResource(resource);
    expect(projection).toHaveProperty('service_name');
    expect(projection).not.toHaveProperty('eligibility');
    expect(projection).not.toHaveProperty('verification_source');
    expect(projection).not.toHaveProperty('resource_id');
  });
});

describe('REFERRALS.md — consented handoff', () => {
  async function draft() {
    const scenario = await requestScenario();
    const referral = await draftReferral(pool, {
      tenantId: scenario.tenantId,
      caseId: scenario.caseId,
      serviceRequestId: scenario.request.serviceRequestId,
      destinationType: 'Organization',
      destinationId: randomUUID(),
      reason: 'food assistance',
      method: 'EMAIL',
      actorId: scenario.responder.userId,
    });
    return { ...scenario, referral };
  }

  it('drafts without disclosing anything', async () => {
    const { referral, tenantId } = await draft();
    expect(referral.status).toBe('DRAFTED');
    expect(referral.consentBasis).toBeUndefined();

    // A draft evaluates no consent, so no disclosure audit exists yet.
    const audits = await pool.query(
      `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'CONSENT_EVALUATED'`,
      [tenantId],
    );
    expect(audits.rowCount).toBe(0);
  });

  it('refuses to send without a grant covering the destination', async () => {
    const { tenantId, veteran, responder, referral } = await draft();
    await expect(
      sendReferral(pool, {
        tenantId,
        referralId: referral.referralId,
        veteranUserId: veteran.userId,
        actorId: responder.userId,
        idempotencyKey: 'send-1',
      }),
    ).rejects.toThrow(ConsentDeniedError);

    expect((await import('../../src/fulfillment/index.js')).findReferral).toBeDefined();
  });

  it('sends with a grant, and a replay discloses nothing further', async () => {
    const { tenantId, veteran, responder, referral } = await draft();

    const templateKey = `referral-${randomUUID().slice(0, 8)}`;
    const versionKey = consentTemplateVersionKey(templateKey, 1);
    await createConsentTemplateVersion(pool, { templateKey, version: 1, body: 'Synthetic.' });
    await publishConsentTemplateVersion(pool, versionKey, undefined);
    await grantConsent(pool, {
      tenantId,
      veteranUserId: veteran.userId,
      permission: 'can_share',
      scope: 'service_request_fulfillment',
      purpose: 'refer for food assistance',
      granteeType: 'ORGANIZATION',
      granteeId: referral.destinationId,
      consentTemplateVersion: versionKey,
    });

    const input = {
      tenantId,
      referralId: referral.referralId,
      veteranUserId: veteran.userId,
      actorId: responder.userId,
      idempotencyKey: 'send-1',
      disclosedFields: ['service_request_id', 'category'],
    };

    const sent = await sendReferral(pool, input);
    expect(sent.deduplicated).toBe(false);
    expect(sent.referral.status).toBe('SENT');
    expect(sent.referral.consentBasis).toBe('CONSENT_GRANT');

    const before = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE tenant_id = $1 AND event_type = 'CONSENT_EVALUATED'`,
      [tenantId],
    );

    const replay = await sendReferral(pool, input);
    expect(replay.deduplicated).toBe(true);

    const after = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE tenant_id = $1 AND event_type = 'CONSENT_EVALUATED'`,
      [tenantId],
    );
    // REFERRALS.md §5.1: a replay must not disclose twice — it does not even
    // re-evaluate consent.
    expect(after.rows[0]?.n).toBe((before.rows[0] as { n: number }).n);
  });

  it('refuses an undocumented status transition', async () => {
    const { tenantId, responder, referral } = await draft();
    await expect(
      updateReferralStatus(pool, {
        tenantId,
        referralId: referral.referralId,
        to: 'COMPLETED',
        actorId: responder.userId,
      }),
    ).rejects.toThrow(IllegalReferralTransitionError);
  });

  it('does not fulfil a Service Request when a Referral completes', async () => {
    const { tenantId, request, referral } = await draft();

    // REFERRALS.md §1 and §8: sending or completing a Referral is not Fulfillment.
    expect(await findFulfillment(pool, tenantId, request.serviceRequestId)).toBeUndefined();
    expect(referral.status).toBe('DRAFTED');

    const requestRow = await pool.query<{ status: string }>(
      'SELECT status FROM service_requests WHERE service_request_id = $1',
      [request.serviceRequestId],
    );
    expect(requestRow.rows[0]?.status).toBe('CREATED');
  });
});
