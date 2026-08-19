import type { JsonObject } from '../jobs/index.js';
import type {
  AdapterHealth,
  FulfillmentAdapter,
  FulfillmentOutcome,
  FulfillmentRequest,
  IntegrationMode,
} from './port.js';
import {
  rankTemporaryShelterOffers,
  type RankedTemporaryShelterOffer,
  type TemporaryShelterOffer,
  type TemporaryShelterOfferAction,
  type TemporaryShelterOperationResult,
  type TemporaryShelterPort,
  type TemporaryShelterSearchContext,
} from './temporary-shelter.js';

export interface AmadeusLodgingConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly tokenUrl?: string;
  readonly apiBaseUrl?: string;
}

export const AMADEUS_LODGING_DEFAULT_TOKEN_URL =
  'https://test.api.amadeus.com/v1/security/oauth2/token';
export const AMADEUS_LODGING_DEFAULT_API_BASE_URL = 'https://test.api.amadeus.com';

export interface AmadeusFetchTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface AmadeusTokenProvider {
  accessToken(): Promise<string>;
}

interface TokenCache {
  readonly token: string;
  readonly expiresAtMs: number;
}

const globalFetchTransport: AmadeusFetchTransport = {
  fetch(url, init) {
    return fetch(url, init);
  },
};

export class AmadeusLodgingProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'AmadeusLodgingProviderError';
  }
}

export class AmadeusLodgingOAuthTokenProvider implements AmadeusTokenProvider {
  private cache: TokenCache | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly config: Pick<AmadeusLodgingConfig, 'clientId' | 'clientSecret' | 'tokenUrl'>,
    private readonly transport: AmadeusFetchTransport = globalFetchTransport,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async accessToken(): Promise<string> {
    if (this.cache !== undefined && this.cache.expiresAtMs - 30_000 > this.now()) {
      return this.cache.token;
    }
    if (this.inFlight !== undefined) return this.inFlight;

    this.inFlight = this.refreshToken();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async refreshToken(): Promise<string> {
    if (this.config.clientId === undefined || this.config.clientSecret === undefined) {
      throw new AmadeusLodgingProviderError('oauth_credentials_missing');
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const response = await this.transport.fetch(
      this.config.tokenUrl ?? AMADEUS_LODGING_DEFAULT_TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
    if (!response.ok) {
      throw new AmadeusLodgingProviderError('oauth_token_failed', response.status);
    }

    const payload = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new AmadeusLodgingProviderError('oauth_token_missing', response.status);
    }

    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 300;
    this.cache = {
      token: payload.access_token,
      expiresAtMs: this.now() + expiresIn * 1000,
    };
    return payload.access_token;
  }
}

interface HotelListItem {
  readonly hotelId?: unknown;
  readonly name?: unknown;
  readonly geoCode?: unknown;
  readonly distance?: unknown;
}

interface HotelOfferEnvelope {
  readonly hotel?: unknown;
  readonly available?: unknown;
  readonly offers?: unknown;
}

interface HotelListRecord {
  readonly hotelId: string;
  readonly name: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly distanceKm?: number;
}

export class AmadeusLodgingAdapter implements FulfillmentAdapter, TemporaryShelterPort {
  readonly adapterId: string;
  readonly integrationMode: IntegrationMode = 'API';
  readonly capabilities = ['SHELTER'] as const;
  readonly transmitsExternally = true;

  constructor(
    private readonly config: AmadeusLodgingConfig,
    private readonly tokenProvider: AmadeusTokenProvider = new AmadeusLodgingOAuthTokenProvider(
      config,
    ),
    private readonly transport: AmadeusFetchTransport = globalFetchTransport,
    adapterId = 'shelter-api',
    private readonly now: () => Date = () => new Date(),
  ) {
    this.adapterId = adapterId;
  }

  async health(): Promise<AdapterHealth> {
    try {
      await this.tokenProvider.accessToken();
      return 'HEALTHY';
    } catch (error) {
      if (error instanceof AmadeusLodgingProviderError) {
        if (
          error.message === 'oauth_credentials_missing' ||
          error.statusCode === 401 ||
          error.statusCode === 403
        ) {
          return 'MISCONFIGURED';
        }
        if (error.statusCode === 429) return 'RATE_LIMITED';
      }
      return 'UNAVAILABLE';
    }
  }

  async searchAvailability(
    context: TemporaryShelterSearchContext,
  ): Promise<readonly TemporaryShelterOffer[]> {
    assertSearchContext(context);

    const hotelsPayload = await this.getJson(
      '/v1/reference-data/locations/hotels/by-geocode',
      new URLSearchParams({
        latitude: String(context.location.latitude),
        longitude: String(context.location.longitude),
        radius: String(context.location.radiusKm ?? 5),
        radiusUnit: 'KM',
        hotelSource: 'ALL',
      }),
    );
    const hotels = hotelListFromPayload(hotelsPayload)
      .sort((left, right) => {
        const distance =
          (left.distanceKm ?? Number.POSITIVE_INFINITY) -
          (right.distanceKm ?? Number.POSITIVE_INFINITY);
        return distance === 0 ? left.hotelId.localeCompare(right.hotelId) : distance;
      })
      .slice(0, 20);

    if (hotels.length === 0) return [];

    const offersPayload = await this.getJson(
      '/v3/shopping/hotel-offers',
      new URLSearchParams({
        hotelIds: hotels.map((hotel) => hotel.hotelId).join(','),
        adults: String(context.occupancy.adults),
        checkInDate: context.stay.checkInDate,
        checkOutDate: context.stay.checkOutDate,
        roomQuantity: String(context.occupancy.rooms),
        paymentPolicy: 'NONE',
        includeClosed: 'false',
        bestRateOnly: 'true',
      }),
    );

    return normalizeAmadeusHotelOffers(
      offersPayload,
      context,
      hotels,
      this.adapterId,
      this.now().toISOString(),
    );
  }

  async searchRankedAvailability(
    context: TemporaryShelterSearchContext,
  ): Promise<readonly RankedTemporaryShelterOffer[]> {
    return rankTemporaryShelterOffers(await this.searchAvailability(context));
  }

  hold(_action: TemporaryShelterOfferAction): Promise<TemporaryShelterOperationResult> {
    return Promise.resolve(paymentBlocked('hold'));
  }

  reserve(_action: TemporaryShelterOfferAction): Promise<TemporaryShelterOperationResult> {
    return Promise.resolve(paymentBlocked('reservation'));
  }

  getStatus(_externalReference: string): Promise<TemporaryShelterOperationResult> {
    return Promise.resolve(unsupported('reservation status'));
  }

  cancel(
    _externalReference: string,
    _idempotencyKey: string,
  ): Promise<TemporaryShelterOperationResult> {
    return Promise.resolve(unsupported('cancellation'));
  }

  initiate(_request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    return Promise.resolve({
      status: 'PROVIDER_FAILED',
      fulfillmentMode: 'INFORMATION_ONLY',
      failureReason:
        'Amadeus lodging search is available, but provider reservation is payment-blocked because the current booking API requires raw payment-card handling.',
    });
  }

  reconcile(_request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    return Promise.resolve({
      status: 'PROVIDER_FAILED',
      fulfillmentMode: 'INFORMATION_ONLY',
      failureReason: 'No provider reservation exists to reconcile; Amadeus lodging is search-only.',
    });
  }

  private async getJson(path: string, query: URLSearchParams): Promise<JsonObject> {
    const token = await this.tokenProvider.accessToken();
    const baseUrl = this.config.apiBaseUrl ?? AMADEUS_LODGING_DEFAULT_API_BASE_URL;
    const response = await this.transport.fetch(`${baseUrl}${path}?${query.toString()}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.amadeus+json, application/json',
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      throw new AmadeusLodgingProviderError('amadeus_request_failed', response.status);
    }
    const payload = await response.json();
    if (!isJsonObject(payload)) {
      throw new AmadeusLodgingProviderError('amadeus_response_invalid', response.status);
    }
    return payload;
  }
}

function paymentBlocked(operation: string): TemporaryShelterOperationResult {
  return {
    status: 'PAYMENT_BLOCKED',
    fulfillmentMode: 'INFORMATION_ONLY',
    reason:
      `Amadeus ${operation} is not implemented because the current hotel booking API ` +
      'requires payment-card data, which this runtime must not collect or transmit.',
  };
}

function unsupported(operation: string): TemporaryShelterOperationResult {
  return {
    status: 'UNSUPPORTED',
    fulfillmentMode: 'INFORMATION_ONLY',
    reason: `Amadeus ${operation} is unavailable because this adapter does not create provider reservations.`,
  };
}

function assertSearchContext(context: TemporaryShelterSearchContext): void {
  const { latitude, longitude, radiusKm } = context.location;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new AmadeusLodgingProviderError('invalid_shelter_latitude');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new AmadeusLodgingProviderError('invalid_shelter_longitude');
  }
  if (radiusKm !== undefined && (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 300)) {
    throw new AmadeusLodgingProviderError('invalid_shelter_radius');
  }
  if (!isIsoDate(context.stay.checkInDate) || !isIsoDate(context.stay.checkOutDate)) {
    throw new AmadeusLodgingProviderError('invalid_shelter_stay_dates');
  }
  if (context.stay.checkOutDate <= context.stay.checkInDate) {
    throw new AmadeusLodgingProviderError('invalid_shelter_stay_range');
  }
  if (
    !Number.isInteger(context.occupancy.adults) ||
    context.occupancy.adults < 1 ||
    context.occupancy.adults > 9
  ) {
    throw new AmadeusLodgingProviderError('invalid_shelter_adults');
  }
  if (
    !Number.isInteger(context.occupancy.rooms) ||
    context.occupancy.rooms < 1 ||
    context.occupancy.rooms > 9
  ) {
    throw new AmadeusLodgingProviderError('invalid_shelter_rooms');
  }
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function hotelListFromPayload(payload: JsonObject): HotelListRecord[] {
  const data = Array.isArray(payload.data) ? (payload.data as HotelListItem[]) : [];
  return data.flatMap((item) => {
    if (typeof item.hotelId !== 'string' || item.hotelId.length === 0) return [];
    const geo = isJsonObject(item.geoCode) ? item.geoCode : undefined;
    const distance = isJsonObject(item.distance) ? item.distance : undefined;
    const latitude = numberValue(geo?.latitude);
    const longitude = numberValue(geo?.longitude);
    const distanceValue = numberValue(distance?.value);
    const unit = typeof distance?.unit === 'string' ? distance.unit : 'KM';
    const distanceKm =
      distanceValue === undefined
        ? undefined
        : unit === 'MILE'
          ? distanceValue * 1.609344
          : distanceValue;
    return [
      {
        hotelId: item.hotelId,
        name: typeof item.name === 'string' ? item.name : item.hotelId,
        ...(latitude !== undefined ? { latitude } : {}),
        ...(longitude !== undefined ? { longitude } : {}),
        ...(distanceKm !== undefined ? { distanceKm } : {}),
      },
    ];
  });
}

export function normalizeAmadeusHotelOffers(
  payload: JsonObject,
  context: TemporaryShelterSearchContext,
  hotels: readonly HotelListRecord[],
  adapterId = 'shelter-api',
  sourceFreshness = new Date().toISOString(),
): readonly TemporaryShelterOffer[] {
  const hotelById = new Map(hotels.map((hotel) => [hotel.hotelId, hotel]));
  const envelopes = Array.isArray(payload.data) ? (payload.data as HotelOfferEnvelope[]) : [];

  return envelopes.flatMap((envelope) => {
    const providerHotel = isJsonObject(envelope.hotel) ? envelope.hotel : undefined;
    const hotelId = typeof providerHotel?.hotelId === 'string' ? providerHotel.hotelId : undefined;
    if (hotelId === undefined || providerHotel === undefined) return [];
    const listed = hotelById.get(hotelId);
    const offers = Array.isArray(envelope.offers) ? envelope.offers : [];

    return offers.flatMap((candidate) => {
      if (!isJsonObject(candidate) || typeof candidate.id !== 'string') return [];
      const price = isJsonObject(candidate.price) ? candidate.price : undefined;
      const room = isJsonObject(candidate.room) ? candidate.room : undefined;
      const description = isJsonObject(room?.description) ? room.description : undefined;
      const policies = isJsonObject(candidate.policies) ? candidate.policies : undefined;
      const paymentType =
        typeof policies?.paymentType === 'string' ? policies.paymentType.toUpperCase() : undefined;
      const providerLatitude = numberValue(providerHotel.latitude);
      const providerLongitude = numberValue(providerHotel.longitude);
      const latitude = listed?.latitude ?? providerLatitude;
      const longitude = listed?.longitude ?? providerLongitude;
      const totalPrice = stringValue(price?.total) ?? stringValue(price?.base);
      const currency = stringValue(price?.currency);
      const roomDescription = stringValue(description?.text);
      const available = envelope.available !== false;

      return [
        {
          offerId: candidate.id,
          providerRef: hotelId,
          adapterRef: adapterId,
          capability: 'SHELTER' as const,
          serviceRequestId: context.serviceRequestId,
          accommodationName: stringValue(providerHotel.name) ?? listed?.name ?? hotelId,
          availabilityStatus: available ? ('AVAILABLE' as const) : ('UNAVAILABLE' as const),
          fulfillmentMode: 'INFORMATION_ONLY' as const,
          checkInDate: stringValue(candidate.checkInDate) ?? context.stay.checkInDate,
          checkOutDate: stringValue(candidate.checkOutDate) ?? context.stay.checkOutDate,
          ...(latitude !== undefined && longitude !== undefined
            ? { location: { latitude, longitude } }
            : {}),
          ...(listed?.distanceKm !== undefined ? { distanceKm: listed.distanceKm } : {}),
          ...(totalPrice !== undefined ? { totalPrice } : {}),
          ...(currency !== undefined ? { currency } : {}),
          ...(roomDescription !== undefined ? { roomDescription } : {}),
          cancellationSupported: false,
          paymentRequired: paymentType !== undefined && paymentType !== 'NONE',
          reservationBlocked: true,
          sourceFreshness,
        },
      ];
    });
  });
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
