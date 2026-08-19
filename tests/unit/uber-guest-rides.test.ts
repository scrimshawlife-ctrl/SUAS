import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import type { FetchTransport, OAuthTokenProvider } from '../../src/fulfillment/index.js';
import {
  createFulfillmentAdapterRegistry,
  normalizeUberRideStatus,
  projectionToUberTripDto,
  translateUberWebhookPayload,
  UberGuestRidesAdapter,
  UberGuestRidesOAuthTokenProvider,
  verifyUberWebhookHmac,
} from '../../src/fulfillment/index.js';
import { validEnv } from '../helpers/env.js';

const projection = {
  rider: { firstName: 'Synthetic', lastName: 'Rider', phoneNumber: '+15555550100' },
  pickup: { latitude: 37.775, longitude: -122.418, address: 'Synthetic pickup' },
  dropoff: { latitude: 37.785, longitude: -122.408, address: 'Synthetic dropoff' },
  productId: 'synthetic-product',
  noteForDriver: 'Synthetic test ride',
};

class StaticTokenProvider implements OAuthTokenProvider {
  accessToken(): Promise<string> {
    return Promise.resolve('token');
  }
}

class ScriptedTransport implements FetchTransport {
  readonly calls: { url: string; init: RequestInit }[] = [];

  constructor(private readonly payloads: unknown[]) {}

  fetch(url: string, init: RequestInit): Promise<Response> {
    this.calls.push({ url, init });
    const payload = this.payloads.shift() ?? {};
    return Promise.resolve(Response.json(payload));
  }
}

describe('Uber Guest Rides adapter', () => {
  it('strictly translates a minimum transportation projection to an Uber-local DTO', () => {
    expect(projectionToUberTripDto(projection)).toEqual({
      guest: { first_name: 'Synthetic', last_name: 'Rider', phone_number: '+15555550100' },
      pickup: { latitude: 37.775, longitude: -122.418, address: 'Synthetic pickup' },
      dropoff: { latitude: 37.785, longitude: -122.408, address: 'Synthetic dropoff' },
      product_id: 'synthetic-product',
      note_for_driver: 'Synthetic test ride',
    });
  });

  it('normalizes provider statuses without making vendor statuses canonical', () => {
    expect(normalizeUberRideStatus('accepted').status).toBe('PROVIDER_ACCEPTED');
    expect(normalizeUberRideStatus('arriving').status).toBe('PROVIDER_IN_PROGRESS');
    expect(normalizeUberRideStatus('completed').status).toBe('PROVIDER_COMPLETED');
    expect(normalizeUberRideStatus('no_drivers_available').status).toBe('PROVIDER_DECLINED');
    expect(normalizeUberRideStatus('surprising_new_status').status).toBe('PROVIDER_UNKNOWN');
  });

  it('creates a ride using request_id without provider-native idempotency claims', async () => {
    const transport = new ScriptedTransport([
      { request_id: 'request-1', status: 'accepted', eta: 5, raw: { ignored: true } },
    ]);
    const adapter = new UberGuestRidesAdapter(
      {
        clientId: 'client',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.test/token',
        apiBaseUrl: 'https://api.test',
      },
      new StaticTokenProvider(),
      transport,
    );

    const outcome = await adapter.initiate({
      serviceRequestId: 'sr-1',
      capability: 'TRANSPORTATION',
      idempotencyKey: 'attempt-key',
      projection,
    });

    expect(outcome).toMatchObject({
      status: 'PROVIDER_ACCEPTED',
      fulfillmentMode: 'PROVIDER_CONFIRMATION',
      externalReference: 'request-1',
      lastProviderStatus: 'accepted',
      metadata: { eta: 5 },
    });
    expect(transport.calls[0]?.url).toBe('https://api.test/v1/guests/trips');
    const headers = transport.calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer token');
    expect(headers).not.toHaveProperty('idempotency-key');
    expect(headers).not.toHaveProperty('x-suas-fulfillment-attempt-key');
  });

  it('uses confirmed estimates and cancel paths', async () => {
    const transport = new ScriptedTransport([
      { estimate: 'ok' },
      { request_id: 'request-1', status: 'canceled' },
    ]);
    const adapter = new UberGuestRidesAdapter(
      {
        clientId: 'client',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.test/token',
        apiBaseUrl: 'https://api.test',
      },
      new StaticTokenProvider(),
      transport,
    );

    await adapter.quote({
      serviceRequestId: 'sr-1',
      capability: 'TRANSPORTATION',
      idempotencyKey: 'k',
      projection,
    });
    await adapter.cancel('request-1');

    expect(transport.calls[0]).toMatchObject({ url: 'https://api.test/v1/guests/trips/estimates' });
    expect(transport.calls[0]?.init.method).toBe('POST');
    expect(transport.calls[1]).toMatchObject({ url: 'https://api.test/v1/guests/trips/request-1' });
    expect(transport.calls[1]?.init.method).toBe('DELETE');
  });

  it('keeps unknown reconciliation blocked when the port lacks provider reference', async () => {
    const adapter = new UberGuestRidesAdapter(
      {
        clientId: 'client',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.test/token',
        apiBaseUrl: 'https://api.test',
      },
      new StaticTokenProvider(),
      new ScriptedTransport([]),
    );
    await expect(
      adapter.reconcile({
        serviceRequestId: 'sr-1',
        capability: 'TRANSPORTATION',
        idempotencyKey: 'attempt-key',
        projection,
      }),
    ).resolves.toMatchObject({
      status: 'PROVIDER_UNKNOWN',
      lastProviderStatus: 'reference_missing',
    });
  });

  it('verifies webhook HMACs and translates payloads without mounting ingress', () => {
    const raw = JSON.stringify({
      request_id: 'request-1',
      status: 'completed',
      receipt_url: 'https://receipt.test/r',
    });
    const signature = createHmac('sha256', 'webhook-secret').update(raw).digest('hex');

    expect(verifyUberWebhookHmac(raw, signature, 'webhook-secret')).toBe(true);
    expect(verifyUberWebhookHmac(raw, signature, 'wrong-secret')).toBe(false);
    expect(translateUberWebhookPayload(JSON.parse(raw))).toMatchObject({
      status: 'PROVIDER_COMPLETED',
      externalReference: 'request-1',
      metadata: { receipt_url: 'https://receipt.test/r' },
    });
  });

  it('caches OAuth client credentials tokens deterministically', async () => {
    let now = 1_000;
    const transport = new ScriptedTransport([{ access_token: 'token-1', expires_in: 120 }]);
    const provider = new UberGuestRidesOAuthTokenProvider(
      { clientId: 'client', clientSecret: 'secret', tokenUrl: 'https://auth.test/token' },
      transport,
      () => now,
    );

    await expect(provider.accessToken()).resolves.toBe('token-1');
    now += 10_000;
    await expect(provider.accessToken()).resolves.toBe('token-1');
    expect(transport.calls).toHaveLength(1);
    const body = transport.calls[0]?.init.body as URLSearchParams;
    expect(body.get('scope')).toBe('guests.trips');
    expect(transport.calls[0]?.url).toBe('https://auth.test/token');
  });

  it('registers Uber only for transportation while preserving manual and fake adapters', () => {
    const config = loadConfig(
      validEnv({
        SUAS_TRANSPORTATION_ADAPTER_MODE: 'uber_guest_rides',
        SUAS_SHELTER_ADAPTER_MODE: 'manual',
        SUAS_FOOD_ADAPTER_MODE: 'fake',
        SUAS_PEER_SUPPORT_ADAPTER_MODE: 'disabled',
        SUAS_UBER_GUEST_RIDES_CLIENT_ID: 'client',
        SUAS_UBER_GUEST_RIDES_CLIENT_SECRET: 'secret',
        SUAS_UBER_GUEST_RIDES_TOKEN_URL: 'https://auth.test/token',
        SUAS_UBER_GUEST_RIDES_API_BASE_URL: 'https://api.test',
      }),
    );
    const registry = createFulfillmentAdapterRegistry(config);

    expect(registry.get('transportation')).toBeUndefined();
    expect(registry.get('transportation-api')?.capabilities).toEqual(['TRANSPORTATION']);
    expect(registry.get('transportation-manual')?.integrationMode).toBe('MANUAL_COORDINATION');
    expect(registry.get('shelter')?.integrationMode).toBe('MANUAL_COORDINATION');
    expect(registry.get('food')?.integrationMode).toBe('API');
    expect(registry.get('peer-support')?.integrationMode).toBe('NONE');
  });

  it('registers a misconfigured Uber adapter plus manual fallback when credentials are missing', async () => {
    const config = loadConfig(validEnv({ SUAS_TRANSPORTATION_ADAPTER_MODE: 'uber_guest_rides' }));
    const registry = createFulfillmentAdapterRegistry(config);

    await expect(registry.get('transportation-api')?.health()).resolves.toBe('MISCONFIGURED');
    expect(registry.get('transportation-manual')?.integrationMode).toBe('MANUAL_COORDINATION');
  });
});
