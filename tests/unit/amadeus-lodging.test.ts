import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  AmadeusLodgingAdapter,
  AmadeusLodgingOAuthTokenProvider,
  createFulfillmentAdapterRegistry,
  normalizeAmadeusHotelOffers,
  rankTemporaryShelterOffers,
  type AmadeusFetchTransport,
  type AmadeusTokenProvider,
  type TemporaryShelterSearchContext,
} from '../../src/fulfillment/index.js';
import { projectForProvider } from '../../src/privacy/index.js';
import { validEnv } from '../helpers/env.js';

class StaticTokenProvider implements AmadeusTokenProvider {
  accessToken(): Promise<string> {
    return Promise.resolve('token');
  }
}

class ScriptedTransport implements AmadeusFetchTransport {
  readonly calls: { url: string; init: RequestInit }[] = [];
  constructor(private readonly responses: Response[]) {}
  fetch(url: string, init: RequestInit): Promise<Response> {
    this.calls.push({ url, init });
    const response = this.responses.shift() ?? Response.json({});
    return Promise.resolve(response);
  }
}

const context: TemporaryShelterSearchContext = {
  serviceRequestId: 'sr-shelter-1',
  location: { latitude: 38.9, longitude: -77.03, radiusKm: 10 },
  stay: { checkInDate: '2026-09-01', checkOutDate: '2026-09-02' },
  occupancy: { adults: 1, rooms: 1 },
};

describe('Amadeus lodging adapter', () => {
  it('caches OAuth client_credentials tokens with single-flight refresh', async () => {
    let now = 1_000;
    const transport = new ScriptedTransport([
      Response.json({ access_token: 'token-1', expires_in: 300 }),
    ]);
    const provider = new AmadeusLodgingOAuthTokenProvider(
      { clientId: 'client', clientSecret: 'secret', tokenUrl: 'https://auth.test/token' },
      transport,
      () => now,
    );

    await expect(Promise.all([provider.accessToken(), provider.accessToken()])).resolves.toEqual([
      'token-1',
      'token-1',
    ]);
    expect(transport.calls).toHaveLength(1);
    now += 10_000;
    await expect(provider.accessToken()).resolves.toBe('token-1');
    expect(transport.calls).toHaveLength(1);
  });

  it('reports missing credentials as misconfigured while preserving app operability', async () => {
    const adapter = new AmadeusLodgingAdapter({});
    await expect(adapter.health()).resolves.toBe('MISCONFIGURED');
  });

  it('uses only safe Hotel List and Hotel Search endpoints and normalizes offers', async () => {
    const transport = new ScriptedTransport([
      Response.json({
        data: [
          {
            hotelId: 'HOTEL1',
            name: 'Synthetic Shelter Hotel',
            geoCode: { latitude: 38.91, longitude: -77.02 },
            ignored: { raw: true },
          },
        ],
      }),
      Response.json({
        data: [
          {
            available: true,
            hotel: { hotelId: 'HOTEL1', name: 'Synthetic Shelter Hotel', ignored: true },
            offers: [
              {
                id: 'OFFER1',
                checkInDate: '2026-09-01',
                checkOutDate: '2026-09-02',
                price: { total: '100.00', currency: 'USD' },
                policies: { paymentType: 'GUARANTEE' },
                unexpected: 'ignored',
              },
            ],
          },
        ],
      }),
    ]);
    const adapter = new AmadeusLodgingAdapter(
      { apiBaseUrl: 'https://api.test' },
      new StaticTokenProvider(),
      transport,
      'shelter-api',
      () => new Date('2026-08-19T00:00:00.000Z'),
    );

    const offers = await adapter.searchAvailability(context);

    expect(transport.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/reference-data/locations/hotels/by-geocode',
      '/v3/shopping/hotel-offers',
    ]);
    expect(offers[0]).toMatchObject({
      offerId: 'OFFER1',
      providerRef: 'HOTEL1',
      capability: 'SHELTER',
      totalPrice: '100.00',
      currency: 'USD',
      paymentRequired: true,
      reservationBlocked: true,
      sourceFreshness: '2026-08-19T00:00:00.000Z',
    });
    expect(JSON.stringify(offers[0])).not.toContain('unexpected');
    expect(JSON.stringify(offers[0])).not.toContain('ignored');
  });

  it('maps provider rate limit and outage failures without creating inventory', async () => {
    const rateLimited = new AmadeusLodgingAdapter(
      { apiBaseUrl: 'https://api.test' },
      new StaticTokenProvider(),
      new ScriptedTransport([Response.json({ errors: [] }, { status: 429 })]),
    );
    await expect(rateLimited.searchAvailability(context)).rejects.toMatchObject({
      statusCode: 429,
    });

    const outage = new AmadeusLodgingAdapter(
      { apiBaseUrl: 'https://api.test' },
      new StaticTokenProvider(),
      new ScriptedTransport([Response.json({ errors: [] }, { status: 503 })]),
    );
    await expect(outage.searchAvailability(context)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('returns no inventory and deterministic explainable rankings', async () => {
    const noInventory = new AmadeusLodgingAdapter(
      { apiBaseUrl: 'https://api.test' },
      new StaticTokenProvider(),
      new ScriptedTransport([Response.json({ data: [] })]),
    );
    await expect(noInventory.searchAvailability(context)).resolves.toEqual([]);

    const ranked = rankTemporaryShelterOffers([
      {
        offerId: 'B',
        providerRef: 'P2',
        adapterRef: 'shelter-api',
        capability: 'SHELTER',
        serviceRequestId: 'sr',
        accommodationName: 'Far',
        availabilityStatus: 'AVAILABLE',
        fulfillmentMode: 'INFORMATION_ONLY',
        checkInDate: '2026-09-01',
        checkOutDate: '2026-09-02',
        distanceKm: 10,
        cancellationSupported: false,
        paymentRequired: true,
        reservationBlocked: true,
        sourceFreshness: 'now',
      },
      {
        offerId: 'A',
        providerRef: 'P1',
        adapterRef: 'shelter-api',
        capability: 'SHELTER',
        serviceRequestId: 'sr',
        accommodationName: 'Near',
        availabilityStatus: 'AVAILABLE',
        fulfillmentMode: 'INFORMATION_ONLY',
        checkInDate: '2026-09-01',
        checkOutDate: '2026-09-02',
        distanceKm: 1,
        cancellationSupported: false,
        paymentRequired: true,
        reservationBlocked: true,
        sourceFreshness: 'now',
      },
    ]);
    expect(ranked.map((entry) => entry.offer.offerId)).toEqual(['A', 'B']);
    expect(ranked[0]?.explanation.summary).toContain('Ordered by availability');
  });

  it('keeps reservation mutations truthfully payment-blocked and generic initiate non-mutating', async () => {
    const adapter = new AmadeusLodgingAdapter({}, new StaticTokenProvider());
    await expect(
      adapter.reserve({ offer: {} as never, idempotencyKey: 'k' }),
    ).resolves.toMatchObject({
      status: 'PAYMENT_BLOCKED',
    });
    await expect(
      adapter.initiate({
        serviceRequestId: 'sr',
        capability: 'SHELTER',
        idempotencyKey: 'k',
        projection: {},
      }),
    ).resolves.toMatchObject({
      status: 'PROVIDER_FAILED',
      fulfillmentMode: 'INFORMATION_ONLY',
    });
  });

  it('registers shelter-api and mandatory shelter-manual fallback and allows only shelter projection fields', () => {
    const config = loadConfig({
      ...validEnv(),
      SUAS_SHELTER_ADAPTER_MODE: 'amadeus_lodging',
      SUAS_AMADEUS_LODGING_CLIENT_ID: 'client',
      SUAS_AMADEUS_LODGING_CLIENT_SECRET: 'secret',
    });
    const registry = createFulfillmentAdapterRegistry(config);
    expect(registry.get('shelter-api')).toBeInstanceOf(AmadeusLodgingAdapter);
    expect(registry.get('shelter-manual')).toBeDefined();

    const projection = projectForProvider('TEMPORARY_SHELTER', {
      location: context.location,
      stay: context.stay,
      adults: 1,
      roomQuantity: 1,
      ignored: 'not disclosed',
    });
    expect(projection.fields).toEqual({
      location: context.location,
      stay: context.stay,
      adults: 1,
      roomQuantity: 1,
    });
  });

  it('normalizes payloads directly while ignoring unknown fields', () => {
    const offers = normalizeAmadeusHotelOffers(
      { data: [{ hotel: { hotelId: 'H' }, offers: [{ id: 'O' }], noisy: true }] },
      context,
      [{ hotelId: 'H', name: 'Listed' }],
      'shelter-api',
      'fresh',
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]?.accommodationName).toBe('Listed');
  });
});
