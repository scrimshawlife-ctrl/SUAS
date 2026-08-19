import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JsonObject } from '../jobs/index.js';
import type {
  AdapterHealth,
  FulfillmentAdapter,
  FulfillmentMode,
  FulfillmentOutcome,
  FulfillmentRequest,
  IntegrationMode,
} from './port.js';

export interface UberGuestRidesConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly tokenUrl?: string;
  readonly apiBaseUrl?: string;
  readonly webhookSecret?: string;
}

export const UBER_GUEST_RIDES_DEFAULT_TOKEN_URL = 'https://auth.uber.com/oauth/v2/token';
export const UBER_GUEST_RIDES_DEFAULT_API_BASE_URL = 'https://api.uber.com';

export interface FetchTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface OAuthTokenProvider {
  accessToken(): Promise<string>;
}

interface TokenCache {
  token: string;
  expiresAtMs: number;
}

export class UberGuestRidesOAuthTokenProvider implements OAuthTokenProvider {
  private cache: TokenCache | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly config: Pick<UberGuestRidesConfig, 'clientId' | 'clientSecret' | 'tokenUrl'>,
    private readonly transport: FetchTransport = globalFetchTransport,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async accessToken(): Promise<string> {
    if (this.cache !== undefined && this.cache.expiresAtMs - 30_000 > this.now())
      return this.cache.token;
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
      throw new UberGuestRidesProviderError('oauth_credentials_missing');
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: 'guests.trips',
    });
    const response = await this.transport.fetch(
      this.config.tokenUrl ?? UBER_GUEST_RIDES_DEFAULT_TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
    if (!response.ok) throw new UberGuestRidesProviderError('oauth_token_failed', response.status);
    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new UberGuestRidesProviderError('oauth_token_missing', response.status);
    }
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 300;
    this.cache = { token: payload.access_token, expiresAtMs: this.now() + expiresIn * 1000 };
    return payload.access_token;
  }
}

export class UberGuestRidesProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'UberGuestRidesProviderError';
  }
}

export interface UberRideProjection {
  readonly rider: {
    readonly firstName: string;
    readonly lastName: string;
    readonly phoneNumber: string;
  };
  readonly pickup: {
    readonly latitude: number;
    readonly longitude: number;
    readonly address?: string;
  };
  readonly dropoff: {
    readonly latitude: number;
    readonly longitude: number;
    readonly address?: string;
  };
  readonly productId?: string;
  readonly noteForDriver?: string;
}

export interface UberTripDto {
  readonly guest: {
    readonly first_name: string;
    readonly last_name: string;
    readonly phone_number: string;
  };
  readonly pickup: {
    readonly latitude: number;
    readonly longitude: number;
    readonly address?: string;
  };
  readonly dropoff: {
    readonly latitude: number;
    readonly longitude: number;
    readonly address?: string;
  };
  readonly product_id?: string;
  readonly note_for_driver?: string;
}

const globalFetchTransport: FetchTransport = {
  fetch(url, init) {
    return fetch(url, init);
  },
};

export function projectionToUberTripDto(projection: JsonObject): UberTripDto {
  const candidate = projection as unknown as Partial<UberRideProjection>;
  if (!isRider(candidate.rider) || !isPoint(candidate.pickup) || !isPoint(candidate.dropoff)) {
    throw new UberGuestRidesProviderError('invalid_transportation_projection');
  }
  return {
    guest: {
      first_name: candidate.rider.firstName,
      last_name: candidate.rider.lastName,
      phone_number: candidate.rider.phoneNumber,
    },
    pickup: pointToDto(candidate.pickup),
    dropoff: pointToDto(candidate.dropoff),
    ...(typeof candidate.productId === 'string' ? { product_id: candidate.productId } : {}),
    ...(typeof candidate.noteForDriver === 'string'
      ? { note_for_driver: candidate.noteForDriver }
      : {}),
  };
}

function isRider(value: unknown): value is UberRideProjection['rider'] {
  const rider = value as Partial<UberRideProjection['rider']> | undefined;
  return (
    rider !== undefined &&
    typeof rider.firstName === 'string' &&
    typeof rider.lastName === 'string' &&
    typeof rider.phoneNumber === 'string'
  );
}

function isPoint(value: unknown): value is UberRideProjection['pickup'] {
  const point = value as Partial<UberRideProjection['pickup']> | undefined;
  return (
    point !== undefined && typeof point.latitude === 'number' && typeof point.longitude === 'number'
  );
}

function pointToDto(point: UberRideProjection['pickup']): UberTripDto['pickup'] {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    ...(typeof point.address === 'string' ? { address: point.address } : {}),
  };
}

export function normalizeUberRideStatus(status: string | undefined): FulfillmentOutcome {
  const label = status ?? 'unknown';
  const normalized = label.toLowerCase();
  const statusMap: Record<string, FulfillmentOutcome['status']> = {
    processing: 'PROVIDER_PENDING',
    pending: 'PROVIDER_PENDING',
    accepted: 'PROVIDER_ACCEPTED',
    scheduled: 'PROVIDER_ACCEPTED',
    arriving: 'PROVIDER_IN_PROGRESS',
    in_progress: 'PROVIDER_IN_PROGRESS',
    driver_redispatched: 'PROVIDER_PENDING',
    upfront_driver_assigned: 'PROVIDER_ACCEPTED',
    completed: 'PROVIDER_COMPLETED',
    failed: 'PROVIDER_FAILED',
    canceled: 'PROVIDER_CANCELLED',
    cancelled: 'PROVIDER_CANCELLED',
    no_drivers_available: 'PROVIDER_DECLINED',
    driver_canceled: 'PROVIDER_CANCELLED',
    rider_canceled: 'PROVIDER_CANCELLED',
  };
  return {
    status: statusMap[normalized] ?? 'PROVIDER_UNKNOWN',
    fulfillmentMode: fulfillmentModeFor(statusMap[normalized]),
    lastProviderStatus: label,
  };
}

function fulfillmentModeFor(status: FulfillmentOutcome['status'] | undefined): FulfillmentMode {
  if (status === 'PROVIDER_COMPLETED') return 'DIRECT_BOOKING';
  if (status === 'PROVIDER_DECLINED' || status === 'PROVIDER_FAILED') return 'UNAVAILABLE';
  return 'PROVIDER_CONFIRMATION';
}

export class UberGuestRidesAdapter implements FulfillmentAdapter {
  readonly adapterId: string;
  readonly integrationMode: IntegrationMode = 'API';
  readonly capabilities = ['TRANSPORTATION'] as const;
  readonly transmitsExternally = true;

  constructor(
    private readonly config: UberGuestRidesConfig,
    private readonly tokenProvider: OAuthTokenProvider = new UberGuestRidesOAuthTokenProvider(
      config,
    ),
    private readonly transport: FetchTransport = globalFetchTransport,
    adapterId = 'transportation-api',
  ) {
    this.adapterId = adapterId;
  }

  async health(): Promise<AdapterHealth> {
    try {
      await this.tokenProvider.accessToken();
      return 'HEALTHY';
    } catch (error) {
      if (error instanceof UberGuestRidesProviderError) {
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

  async quote(request: FulfillmentRequest): Promise<JsonObject> {
    const dto = projectionToUberTripDto(request.projection);
    return this.requestJson('/v1/guests/trips/estimates', 'POST', dto);
  }

  async create(request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    const dto = projectionToUberTripDto(request.projection);
    const payload = await this.requestJson('/v1/guests/trips', 'POST', dto);
    return outcomeFromPayload(payload);
  }

  async get(externalReference: string): Promise<FulfillmentOutcome> {
    const payload = await this.requestJson(
      `/v1/guests/trips/${encodeURIComponent(externalReference)}`,
      'GET',
    );
    return outcomeFromPayload(payload);
  }

  async cancel(externalReference: string): Promise<FulfillmentOutcome> {
    const payload = await this.requestJson(
      `/v1/guests/trips/${encodeURIComponent(externalReference)}`,
      'DELETE',
    );
    return outcomeFromPayload(payload, 'canceled');
  }

  async receipt(externalReference: string): Promise<JsonObject> {
    return this.requestJson(
      `/v1/guests/trips/${encodeURIComponent(externalReference)}/receipt`,
      'GET',
    );
  }

  initiate(request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    return this.create(request);
  }

  reconcile(request: FulfillmentRequest): Promise<FulfillmentOutcome> {
    // The port does not carry a provider reference during unknown reconciliation.
    // Return UNKNOWN so router keeps the attempt blocked until an operator or poller
    // supplies the reference-bearing state rather than risking a duplicate ride.
    void request;
    return Promise.resolve({
      status: 'PROVIDER_UNKNOWN',
      fulfillmentMode: 'PROVIDER_CONFIRMATION',
      lastProviderStatus: 'reference_missing',
    });
  }

  private async requestJson(path: string, method: string, body?: unknown): Promise<JsonObject> {
    const token = await this.tokenProvider.accessToken();
    const response = await this.transport.fetch(
      `${this.config.apiBaseUrl ?? UBER_GUEST_RIDES_DEFAULT_API_BASE_URL}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok)
      throw new UberGuestRidesProviderError('provider_request_failed', response.status);
    return (await response.json()) as JsonObject;
  }
}

function outcomeFromPayload(payload: JsonObject, fallbackStatus?: string): FulfillmentOutcome {
  const status = typeof payload.status === 'string' ? payload.status : fallbackStatus;
  const outcome = normalizeUberRideStatus(status);
  const externalReference = typeof payload.request_id === 'string' ? payload.request_id : undefined;
  return {
    ...outcome,
    ...(externalReference !== undefined ? { externalReference } : {}),
    metadata: boundedMetadata(payload),
  };
}

function boundedMetadata(payload: JsonObject): JsonObject {
  const metadata: JsonObject = {};
  for (const key of ['eta', 'product_id', 'receipt_url']) {
    const value = payload[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      metadata[key] = value;
  }
  return metadata;
}

export function verifyUberWebhookHmac(rawBody: string, signature: string, secret: string): boolean {
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = Buffer.from(digest, 'hex');
  const actualHex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const actual = Buffer.from(actualHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function translateUberWebhookPayload(payload: JsonObject): FulfillmentOutcome {
  const meta = isJsonObject(payload.meta) ? payload.meta : undefined;
  const status = typeof meta?.status === 'string' ? meta.status : undefined;
  const externalReference = typeof meta?.resource_id === 'string' ? meta.resource_id : undefined;
  const outcome = normalizeUberRideStatus(status);
  return {
    ...outcome,
    ...(externalReference !== undefined ? { externalReference } : {}),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
