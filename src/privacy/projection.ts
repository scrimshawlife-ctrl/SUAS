/**
 * Minimum-necessary provider disclosure projection.
 *
 * Spec citations:
 * - SUAS-specs PRIVACY.md §4 — build a capability-specific projection from
 *   SUAS-owned fields; the default projection excludes full Case Notes, Check-In
 *   responses, Support Signal basis, Trusted Circle contacts, audit history, and
 *   unrelated requests; provider replacement creates a new disclosure decision.
 * - SUAS-specs CONSENT.md §5, §9 — the projection must be auditable; adapters do
 *   not receive whole Case, Check-In, Case Note, Trusted Circle, or audit
 *   payloads by default.
 * - SUAS-specs PROVIDER_INTEGRATIONS.md §13 — the forbidden categories, and:
 *   "If a provider needs location, contact, accessibility, or destination data,
 *   the capability contract must identify the field and applicable Consent Grant
 *   purpose."
 *
 * No capability contract is registered here, because none is released. v0.1.1
 * names the categories a projection must exclude but does not define the fields
 * any capability may include, and inventing that list would be inventing product
 * semantics. The registry is therefore deny-by-default and empty: every
 * capability fails closed until a released contract is registered, which is
 * Slice 7's work once PROVIDER_INTEGRATIONS defines the fields.
 */

/** MVP capabilities. CONTEXT.md; ARCHITECTURE.md §11 fulfillment ports. */
export const PROVIDER_CAPABILITIES = [
  'TRANSPORTATION',
  'TEMPORARY_SHELTER',
  'FOOD_SUPPORT',
  'PEER_SUPPORT',
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

/**
 * Categories an adapter must never receive by default.
 * PRIVACY.md §4.2; PROVIDER_INTEGRATIONS.md §13; CONSENT.md §9.
 */
export const FORBIDDEN_PROJECTION_FIELDS = [
  'case_notes',
  'case_note',
  'checkin_answers',
  'check_in_answers',
  'check_in_responses',
  'checkin_responses',
  'support_signal_basis',
  'signal_basis',
  'trusted_circle',
  'trusted_contacts',
  'audit_history',
  'audit_events',
  'unrelated_requests',
  'medical_history',
  'diagnoses',
  'ssn',
  'dd214',
  'military_records',
  'location_history',
  'continuous_location',
] as const;

export class ProjectionContractUnavailableError extends Error {
  readonly code = 'PROJECTION_CONTRACT_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(capability: string) {
    super(
      `No released disclosure projection contract exists for capability "${capability}". ` +
        `PROVIDER_INTEGRATIONS.md §13 requires the capability contract to identify each ` +
        `disclosed field and its Consent Grant purpose; v0.1.1 does not define them, so no ` +
        `provider disclosure can be built.`,
    );
    this.name = 'ProjectionContractUnavailableError';
  }
}

export class ForbiddenProjectionFieldError extends Error {
  readonly code = 'FORBIDDEN_DISCLOSURE_FIELD';
  readonly httpStatus = 422;

  constructor(fields: readonly string[]) {
    super(
      `Fields ${fields.map((field) => `"${field}"`).join(', ')} may never be disclosed to a ` +
        `provider by default (SUAS-specs PRIVACY.md §4.2; PROVIDER_INTEGRATIONS.md §13).`,
    );
    this.name = 'ForbiddenProjectionFieldError';
  }
}

/**
 * A released capability contract: the exact field names an adapter may receive,
 * and the Consent Grant scope that must cover the disclosure.
 */
export interface ProjectionContract {
  readonly capability: ProviderCapability;
  readonly allowedFields: readonly string[];
  /** Released source that defines this contract, for the conformance record. */
  readonly releasedIn: string;
}

/**
 * Registered contracts, keyed by capability.
 *
 * Deliberately empty: v0.1.1 releases no per-capability field list. Slice 7
 * registers contracts once they exist, and the registry rejects any contract
 * naming a forbidden category.
 */
const CONTRACTS = new Map<ProviderCapability, ProjectionContract>();

export function registerProjectionContract(contract: ProjectionContract): void {
  const forbidden = contract.allowedFields.filter((field) =>
    (FORBIDDEN_PROJECTION_FIELDS as readonly string[]).includes(field),
  );
  if (forbidden.length > 0) {
    throw new ForbiddenProjectionFieldError(forbidden);
  }
  CONTRACTS.set(contract.capability, contract);
}

/** Test and Slice 7 support: forget a registered contract. */
export function clearProjectionContracts(): void {
  CONTRACTS.clear();
}

export function projectionContractFor(
  capability: ProviderCapability,
): ProjectionContract | undefined {
  return CONTRACTS.get(capability);
}

export interface ProviderProjection {
  readonly capability: ProviderCapability;
  /** The fields an adapter receives. Nothing outside the contract survives. */
  readonly fields: Record<string, unknown>;
  /**
   * Field names disclosed, for the Audit Event. CONSENT.md §5 records names and
   * categories, never bodies.
   */
  readonly disclosedFieldNames: readonly string[];
}

/**
 * Build the minimum-necessary projection for a capability.
 *
 * Fails closed twice over: an unregistered capability is refused outright, and a
 * source object carrying a forbidden category is refused rather than silently
 * filtered, so a caller cannot quietly hand over a whole Support Case and rely on
 * the allow-list to save them.
 */
export function projectForProvider(
  capability: ProviderCapability,
  source: Readonly<Record<string, unknown>>,
): ProviderProjection {
  const contract = CONTRACTS.get(capability);
  if (contract === undefined) {
    throw new ProjectionContractUnavailableError(capability);
  }

  const forbidden = Object.keys(source).filter((field) =>
    (FORBIDDEN_PROJECTION_FIELDS as readonly string[]).includes(field),
  );
  if (forbidden.length > 0) {
    throw new ForbiddenProjectionFieldError(forbidden);
  }

  const fields: Record<string, unknown> = {};
  for (const field of contract.allowedFields) {
    if (Object.hasOwn(source, field) && source[field] !== undefined) {
      fields[field] = source[field];
    }
  }

  return {
    capability,
    fields,
    disclosedFieldNames: Object.keys(fields),
  };
}
