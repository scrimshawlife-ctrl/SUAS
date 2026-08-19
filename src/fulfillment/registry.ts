import type { SuasConfig } from '../config/index.js';
import { AdapterRegistry } from './router.js';
import { FakeAdapter, InformationOnlyAdapter, ManualAdapter } from './adapters.js';
import { AmadeusLodgingAdapter } from './amadeus-lodging.js';
import { UberGuestRidesAdapter } from './uber-guest-rides.js';

export function createFulfillmentAdapterRegistry(config: SuasConfig): AdapterRegistry {
  const registry = new AdapterRegistry();
  registerMode(
    registry,
    'transportation',
    config.adapters.transportation,
    ['TRANSPORTATION'],
    config,
  );
  // Provider-backed transportation never removes the first-class manual path.
  if (config.adapters.transportation === 'uber_guest_rides') {
    registry.register(new ManualAdapter('transportation-manual'));
  }
  registerMode(registry, 'shelter', config.adapters.shelter, ['SHELTER'], config);
  if (config.adapters.shelter === 'amadeus_lodging') {
    registry.register(new ManualAdapter('shelter-manual'));
  }
  registerMode(registry, 'food', config.adapters.food, ['FOOD'], config);
  registerMode(registry, 'peer-support', config.adapters.peerSupport, ['PEER_SUPPORT'], config);
  return registry;
}

function registerMode(
  registry: AdapterRegistry,
  adapterId: string,
  mode: SuasConfig['adapters']['transportation'],
  capabilities: ConstructorParameters<typeof FakeAdapter>[1],
  config: SuasConfig,
): void {
  if (mode === 'manual') registry.register(new ManualAdapter(adapterId));
  if (mode === 'fake') registry.register(new FakeAdapter(adapterId, capabilities));
  if (mode === 'disabled') registry.register(new InformationOnlyAdapter(adapterId));
  if (mode === 'uber_guest_rides') {
    if (adapterId !== 'transportation') {
      registry.register(new InformationOnlyAdapter(adapterId));
      return;
    }
    const uberConfig = config.adapters.uberGuestRides;
    registry.register(
      new UberGuestRidesAdapter(
        {
          ...(uberConfig.clientId !== undefined ? { clientId: uberConfig.clientId } : {}),
          ...(uberConfig.clientSecret !== undefined
            ? { clientSecret: uberConfig.clientSecret }
            : {}),
          ...(uberConfig.tokenUrl !== undefined ? { tokenUrl: uberConfig.tokenUrl } : {}),
          ...(uberConfig.apiBaseUrl !== undefined ? { apiBaseUrl: uberConfig.apiBaseUrl } : {}),
          ...(uberConfig.webhookSecret !== undefined
            ? { webhookSecret: uberConfig.webhookSecret }
            : {}),
        },
        undefined,
        undefined,
        'transportation-api',
      ),
    );
  }
  if (mode === 'amadeus_lodging') {
    if (adapterId !== 'shelter') {
      registry.register(new InformationOnlyAdapter(adapterId));
      return;
    }
    const lodgingConfig = config.adapters.amadeusLodging;
    registry.register(
      new AmadeusLodgingAdapter(
        {
          ...(lodgingConfig.clientId !== undefined ? { clientId: lodgingConfig.clientId } : {}),
          ...(lodgingConfig.clientSecret !== undefined
            ? { clientSecret: lodgingConfig.clientSecret }
            : {}),
          ...(lodgingConfig.tokenUrl !== undefined ? { tokenUrl: lodgingConfig.tokenUrl } : {}),
          ...(lodgingConfig.apiBaseUrl !== undefined
            ? { apiBaseUrl: lodgingConfig.apiBaseUrl }
            : {}),
        },
        undefined,
        undefined,
        'shelter-api',
      ),
    );
  }
}
