/**
 * Manual and fake fulfillment adapters.
 *
 * Spec citations:
 * - SUAS-specs PROVIDER_INTEGRATIONS.md §1 ("Manual and referral-only providers
 *   are first-class"), §2 rule 8 (manual coordination must remain available where
 *   an API is absent or unavailable), §3 (`MANUAL_COORDINATION` mode), §7
 *   (`MANUAL_COORDINATION` fulfillment mode)
 * - SUAS-specs FULFILLMENT.md §4 (a provider may operate by phone, email, or
 *   manual coordination; lack of an API does not make a provider invalid)
 * - SUAS-specs ADMIN.md §3 ("Manual Adapter paths remain first-class and visible
 *   as configuration, not as a failure mode")
 * - SUAS-specs ENVIRONMENT.md §3 (adapter modes are manual/fake/disabled in
 *   v0.1.1; a real adapter needs D-017–D-020)
 *
 * These are the only adapters v0.1.1 authorizes. No real vendor adapter exists,
 * and the configuration schema cannot name one.
 */

import type { ServiceCategory } from '../coordination/index.js';
import type {
  AdapterHealth,
  FulfillmentAdapter,
  FulfillmentOutcome,
  FulfillmentRequest,
  IntegrationMode,
} from './port.js';

const ALL_CAPABILITIES: readonly ServiceCategory[] = [
  'FOOD',
  'TRANSPORTATION',
  'SHELTER',
  'PEER_SUPPORT',
];

/**
 * Manual coordination.
 *
 * A responder does the work by phone or in person. Nothing is transmitted, so
 * this adapter needs no disclosure projection — and that is exactly why manual
 * paths stay available while the released capability projections are undefined.
 *
 * The attempt opens `MANUAL_PENDING`; a human closes it. ADMIN.md §3 is explicit
 * that this is configuration, not a degraded fallback.
 */
export class ManualAdapter implements FulfillmentAdapter {
  readonly adapterId: string;
  readonly integrationMode: IntegrationMode = 'MANUAL_COORDINATION';
  readonly capabilities: readonly ServiceCategory[] = ALL_CAPABILITIES;
  readonly transmitsExternally = false;

  constructor(adapterId = 'manual') {
    this.adapterId = adapterId;
  }

  health(): Promise<AdapterHealth> {
    // Manual coordination has no dependency to be unhealthy.
    return Promise.resolve('HEALTHY');
  }

  initiate(_request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    return Promise.resolve({
      status: 'MANUAL_PENDING',
      fulfillmentMode: 'MANUAL_COORDINATION',
    });
  }

  reconcile(_request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    // There is no provider to ask. A human records the outcome.
    return Promise.resolve({
      status: 'MANUAL_PENDING',
      fulfillmentMode: 'MANUAL_COORDINATION',
    });
  }
}

export interface FakeAdapterScript {
  /** Outcome returned by `initiate`. Defaults to provider acceptance. */
  readonly onInitiate?: FulfillmentOutcome;
  /** Outcome returned by `reconcile`. */
  readonly onReconcile?: FulfillmentOutcome;
  readonly health?: AdapterHealth;
  /**
   * Simulate an ambiguous timeout: `initiate` throws after the provider may have
   * accepted, which the router records as `PROVIDER_UNKNOWN`
   * (FULFILLMENT.md §3.3).
   */
  readonly failInitiateWith?: Error;
}

/**
 * Scriptable fake provider adapter for the synthetic environment classes.
 *
 * It behaves like an API-backed provider — declaring `transmitsExternally` —
 * so the consent and projection path is genuinely exercised rather than skipped.
 * It performs no network call and reaches no real provider.
 */
export class FakeAdapter implements FulfillmentAdapter {
  readonly adapterId: string;
  readonly integrationMode: IntegrationMode = 'API';
  readonly capabilities: readonly ServiceCategory[];
  readonly transmitsExternally = true;

  private readonly script: FakeAdapterScript;
  private readonly calls: { method: string; request: FulfillmentRequest }[] = [];

  constructor(
    adapterId = 'fake',
    capabilities: readonly ServiceCategory[] = ALL_CAPABILITIES,
    script: FakeAdapterScript = {},
  ) {
    this.adapterId = adapterId;
    this.capabilities = capabilities;
    this.script = script;
  }

  health(): Promise<AdapterHealth> {
    return Promise.resolve(this.script.health ?? 'HEALTHY');
  }

  initiate(request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    this.calls.push({ method: 'initiate', request });
    if (this.script.failInitiateWith !== undefined) {
      return Promise.reject(this.script.failInitiateWith);
    }
    return Promise.resolve(
      this.script.onInitiate ?? {
        status: 'PROVIDER_ACCEPTED',
        fulfillmentMode: 'PROVIDER_CONFIRMATION',
        externalReference: `fake-ref-${request.idempotencyKey}`,
        lastProviderStatus: 'accepted',
      },
    );
  }

  reconcile(request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    this.calls.push({ method: 'reconcile', request });
    return Promise.resolve(
      this.script.onReconcile ?? {
        status: 'PROVIDER_ACCEPTED',
        fulfillmentMode: 'PROVIDER_CONFIRMATION',
        externalReference: `fake-ref-${request.idempotencyKey}`,
        lastProviderStatus: 'accepted',
      },
    );
  }

  /** Test-only: what this adapter was actually handed. */
  received(): readonly { method: string; request: FulfillmentRequest }[] {
    return this.calls;
  }

  /** Test-only: the projection fields this adapter saw across all calls. */
  disclosedFields(): string[] {
    const fields = new Set<string>();
    for (const call of this.calls) {
      for (const key of Object.keys(call.request.projection)) {
        fields.add(key);
      }
    }
    return [...fields].sort();
  }
}

/**
 * An adapter that is configured but has no fulfillment integration.
 * PROVIDER_INTEGRATIONS.md §3: `NONE` means SUAS can display or reference the
 * resource but cannot fulfil through it.
 */
export class InformationOnlyAdapter implements FulfillmentAdapter {
  readonly adapterId: string;
  readonly integrationMode: IntegrationMode = 'NONE';
  readonly capabilities: readonly ServiceCategory[] = ALL_CAPABILITIES;
  readonly transmitsExternally = false;

  constructor(adapterId = 'information-only') {
    this.adapterId = adapterId;
  }

  health(): Promise<AdapterHealth> {
    return Promise.resolve('HEALTHY');
  }

  initiate(_request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    return Promise.resolve({
      status: 'MANUAL_FAILED',
      fulfillmentMode: 'INFORMATION_ONLY',
      failureReason: 'This resource is information-only and cannot be fulfilled through SUAS.',
    });
  }

  reconcile(request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    return this.initiate(request);
  }
}
