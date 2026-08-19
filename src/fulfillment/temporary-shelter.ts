import type { FulfillmentMode } from './port.js';

/**
 * SUAS-owned temporary-shelter search context.
 *
 * This shape contains only operational fields needed to discover temporary
 * accommodation. Provider adapters translate it to provider-local DTOs.
 */
export interface TemporaryShelterSearchContext {
  readonly serviceRequestId: string;
  readonly location: {
    readonly latitude: number;
    readonly longitude: number;
    readonly radiusKm?: number;
  };
  readonly stay: {
    readonly checkInDate: string;
    readonly checkOutDate: string;
  };
  readonly occupancy: {
    readonly adults: number;
    readonly rooms: number;
  };
}

export const TEMPORARY_SHELTER_AVAILABILITY_STATUSES = [
  'AVAILABLE',
  'UNAVAILABLE',
  'UNKNOWN',
] as const;
export type TemporaryShelterAvailabilityStatus =
  (typeof TEMPORARY_SHELTER_AVAILABILITY_STATUSES)[number];

/** A normalized, non-authoritative offer returned by a shelter adapter. */
export interface TemporaryShelterOffer {
  readonly offerId: string;
  readonly providerRef: string;
  readonly adapterRef: string;
  readonly capability: 'SHELTER';
  readonly serviceRequestId: string;
  readonly accommodationName: string;
  readonly availabilityStatus: TemporaryShelterAvailabilityStatus;
  readonly fulfillmentMode: FulfillmentMode;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly location?: {
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly distanceKm?: number;
  /** Informational only. No funding or payment authority is implied. */
  readonly totalPrice?: string;
  readonly currency?: string;
  readonly roomDescription?: string;
  readonly cancellationSupported: boolean;
  readonly paymentRequired: boolean;
  /** Booking is unavailable while the provider requires raw payment-card handling. */
  readonly reservationBlocked: boolean;
  readonly sourceFreshness: string;
}

export const TEMPORARY_SHELTER_OPERATION_STATUSES = ['UNSUPPORTED', 'PAYMENT_BLOCKED'] as const;
export type TemporaryShelterOperationStatus = (typeof TEMPORARY_SHELTER_OPERATION_STATUSES)[number];

export interface TemporaryShelterOperationResult {
  readonly status: TemporaryShelterOperationStatus;
  readonly fulfillmentMode: 'INFORMATION_ONLY' | 'UNAVAILABLE';
  readonly reason: string;
}

export interface TemporaryShelterOfferAction {
  readonly offer: TemporaryShelterOffer;
  readonly idempotencyKey: string;
}

/**
 * Capability-specific shelter port. Search is operational; mutation methods
 * explicitly report unsupported/payment-blocked rather than fabricating a hold,
 * reservation, status, or cancellation.
 */
export interface TemporaryShelterPort {
  searchAvailability(
    context: TemporaryShelterSearchContext,
  ): Promise<readonly TemporaryShelterOffer[]>;
  hold(action: TemporaryShelterOfferAction): Promise<TemporaryShelterOperationResult>;
  reserve(action: TemporaryShelterOfferAction): Promise<TemporaryShelterOperationResult>;
  getStatus(externalReference: string): Promise<TemporaryShelterOperationResult>;
  cancel(
    externalReference: string,
    idempotencyKey: string,
  ): Promise<TemporaryShelterOperationResult>;
}

export interface TemporaryShelterRankingExplanation {
  readonly availability: TemporaryShelterAvailabilityStatus;
  readonly reservationBlocked: boolean;
  readonly distanceKm: number | undefined;
  readonly deterministicTieBreaker: string;
  readonly summary: string;
}

export interface RankedTemporaryShelterOffer {
  readonly rank: number;
  readonly offer: TemporaryShelterOffer;
  readonly explanation: TemporaryShelterRankingExplanation;
}

const AVAILABILITY_RANK: Readonly<Record<TemporaryShelterAvailabilityStatus, number>> = {
  AVAILABLE: 0,
  UNKNOWN: 1,
  UNAVAILABLE: 2,
};

/**
 * Deterministic, explainable ranking without clinical, eligibility, funding, or
 * cross-currency price judgments. Available and actionable offers come first,
 * then recorded distance, followed by stable provider/offer identity.
 */
export function rankTemporaryShelterOffers(
  offers: readonly TemporaryShelterOffer[],
): readonly RankedTemporaryShelterOffer[] {
  const ranked = [...offers].sort((left, right) => {
    const availability =
      AVAILABILITY_RANK[left.availabilityStatus] - AVAILABILITY_RANK[right.availabilityStatus];
    if (availability !== 0) return availability;

    const blocked = Number(left.reservationBlocked) - Number(right.reservationBlocked);
    if (blocked !== 0) return blocked;

    const leftDistance = left.distanceKm ?? Number.POSITIVE_INFINITY;
    const rightDistance = right.distanceKm ?? Number.POSITIVE_INFINITY;
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;

    const provider = left.providerRef.localeCompare(right.providerRef);
    if (provider !== 0) return provider;
    return left.offerId.localeCompare(right.offerId);
  });

  return ranked.map((offer, index) => ({
    rank: index + 1,
    offer,
    explanation: {
      availability: offer.availabilityStatus,
      reservationBlocked: offer.reservationBlocked,
      distanceKm: offer.distanceKm,
      deterministicTieBreaker: `${offer.providerRef}:${offer.offerId}`,
      summary:
        'Ordered by availability, reservation actionability, recorded distance, then stable provider and offer identity. Price is informational and is not compared across currencies.',
    },
  }));
}
