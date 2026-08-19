/**
 * Fulfillment capability port.
 *
 * Spec citations:
 * - SUAS-specs PROVIDER_INTEGRATIONS.md §1 (capability ports with replaceable
 *   adapters), §2 (governing invariants: no SDKs in domain modules, no vendor
 *   objects across the boundary, no vendor status as canonical state, idempotent
 *   external mutation, consent before transmission, outage never fails a request
 *   silently, manual coordination always available), §3 (integration modes),
 *   §4 (capability ports), §7 (fulfillment modes), §8 (status normalization),
 *   §12 (health states)
 * - SUAS-specs FULFILLMENT.md §3.1 (attempt status), §4 (provider-neutral
 *   execution: a provider may operate by API, phone, email, or manual
 *   coordination, and lack of an API does not make a provider invalid)
 *
 * The four released port names — Transportation, TemporaryShelter, FoodSupport,
 * PeerSupport — are one interface parameterised by capability. §4 says the exact
 * interface names may vary but the semantics must not, and four identical
 * interfaces would only invite them to drift apart.
 */

import type { ServiceCategory } from '../coordination/index.js';
import type { ProviderCapability } from '../privacy/index.js';
import type { JsonObject } from '../jobs/index.js';

/**
 * The released specs name the same four things twice: DISPATCH.md §7 calls them
 * Service Request categories (`FOOD`, `TRANSPORTATION`, `SHELTER`,
 * `PEER_SUPPORT`), while ARCHITECTURE.md §11 and FULFILLMENT.md §4 name the
 * capability ports (`FoodSupportPort`, `TransportationPort`,
 * `TemporaryShelterPort`, `PeerSupportPort`). The mapping is stated here rather
 * than assumed at each call site; the naming divergence is returned to specs.
 */
export const CAPABILITY_FOR_CATEGORY: Readonly<Record<ServiceCategory, ProviderCapability>> = {
  FOOD: 'FOOD_SUPPORT',
  TRANSPORTATION: 'TRANSPORTATION',
  SHELTER: 'TEMPORARY_SHELTER',
  PEER_SUPPORT: 'PEER_SUPPORT',
};

export function capabilityForCategory(category: ServiceCategory): ProviderCapability {
  return CAPABILITY_FOR_CATEGORY[category];
}

/** PROVIDER_INTEGRATIONS.md §3. */
export const INTEGRATION_MODES = [
  'API',
  'WEBHOOK',
  'DEEP_LINK',
  'PHONE',
  'EMAIL',
  'MANUAL_COORDINATION',
  'NONE',
] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

/** PROVIDER_INTEGRATIONS.md §7. */
export const FULFILLMENT_MODES = [
  'DIRECT_BOOKING',
  'PROVIDER_CONFIRMATION',
  'PHONE_CONFIRMATION',
  'REFERRAL_REQUIRED',
  'MANUAL_COORDINATION',
  'INFORMATION_ONLY',
  'UNAVAILABLE',
] as const;
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];

/** FULFILLMENT.md §3.1; PROVIDER_INTEGRATIONS.md §8. */
export const ATTEMPT_STATUSES = [
  'PROVIDER_PENDING',
  'PROVIDER_ACCEPTED',
  'PROVIDER_IN_PROGRESS',
  'PROVIDER_COMPLETED',
  'PROVIDER_DECLINED',
  'PROVIDER_CANCELLED',
  'PROVIDER_FAILED',
  'PROVIDER_UNKNOWN',
  'MANUAL_PENDING',
  'MANUAL_COMPLETED',
  'MANUAL_FAILED',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** Attempt statuses from which no further provider activity is expected. */
export const TERMINAL_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'PROVIDER_COMPLETED',
  'PROVIDER_DECLINED',
  'PROVIDER_CANCELLED',
  'PROVIDER_FAILED',
  'MANUAL_COMPLETED',
  'MANUAL_FAILED',
];

/** PROVIDER_INTEGRATIONS.md §12. */
export const ADAPTER_HEALTH_STATES = [
  'HEALTHY',
  'DEGRADED',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'MISCONFIGURED',
] as const;
export type AdapterHealth = (typeof ADAPTER_HEALTH_STATES)[number];

/**
 * What an adapter is asked to do.
 *
 * `projection` carries only the fields a released capability contract permits.
 * The router builds it; the adapter never reaches back for more, which is how
 * PROVIDER_INTEGRATIONS.md §13 stays enforceable rather than aspirational.
 */
export interface FulfillmentRequest {
  readonly serviceRequestId: string;
  readonly capability: ServiceCategory;
  /** Stable per attempt. Reused on retry (FULFILLMENT.md §3.2). */
  readonly idempotencyKey: string;
  /** Minimum-necessary disclosure. Empty for paths that transmit nothing. */
  readonly projection: JsonObject;
}

/**
 * An adapter's normalized answer.
 *
 * Vendor objects never appear here. PROVIDER_INTEGRATIONS.md §2 rule 2 keeps
 * vendor request and response types inside the adapter.
 */
export interface FulfillmentOutcome {
  readonly status: AttemptStatus;
  readonly fulfillmentMode: FulfillmentMode;
  readonly externalReference?: string;
  /** Raw provider status label, retained as evidence only. */
  readonly lastProviderStatus?: string;
  readonly failureReason?: string;
  /** Bounded normalized data. Never a payload dump (§6). */
  readonly metadata?: JsonObject;
}

export interface FulfillmentAdapter {
  /** Opaque identity. Never a vendor name (§2 rule 10). */
  readonly adapterId: string;
  readonly integrationMode: IntegrationMode;
  readonly capabilities: readonly ServiceCategory[];
  /**
   * Whether this adapter transmits veteran data outside SUAS.
   *
   * False for manual coordination, where a responder acts by phone and nothing
   * crosses the boundary automatically. The router requires a consent-evaluated
   * projection only when this is true.
   */
  readonly transmitsExternally: boolean;

  health(): Promise<AdapterHealth>;
  /** Begin one deliberate attempt. Must be idempotent on the supplied key. */
  initiate(request: FulfillmentRequest): Promise<FulfillmentOutcome>;
  /**
   * Re-read provider-side state for an attempt whose outcome is unknown.
   * FULFILLMENT.md §3.3 requires reconciliation before a duplicate-risk retry.
   */
  reconcile(request: FulfillmentRequest): Promise<FulfillmentOutcome>;
}
