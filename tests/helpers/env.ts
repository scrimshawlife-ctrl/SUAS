/**
 * Configuration-source helpers for tests.
 *
 * Tests build explicit environment records rather than mutating process.env, so
 * each fail-closed case is isolated and deterministic (SUAS-specs ENVIRONMENT.md §5:
 * configuration validation runs in tests as well as at runtime startup).
 */

import type { ConfigSource } from '../../src/config/index.js';

/** A configuration source that satisfies every released invariant. */
export function validEnv(overrides: ConfigSource = {}): ConfigSource {
  return {
    SUAS_ENV: 'TEST',
    SUAS_SPEC_VERSION: '0.1.4',
    SUAS_RELEASE_MANIFEST: 'RELEASE_MANIFEST-0.1.4.md',
    SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'false',
    DATABASE_URL: 'postgresql://suas:suas@localhost:5432/suas_test',
    DATABASE_POOL_MAX: '5',
    SUAS_MIGRATIONS_MODE: 'validate',
    SUAS_EMAIL_MODE: 'fake',
    SUAS_SMS_MODE: 'fake',
    SUAS_TRANSPORTATION_ADAPTER_MODE: 'fake',
    SUAS_SHELTER_ADAPTER_MODE: 'fake',
    SUAS_FOOD_ADAPTER_MODE: 'fake',
    SUAS_PEER_SUPPORT_ADAPTER_MODE: 'manual',
    SUAS_SUPPORT_SIGNAL_MODE: 'fixture',
    SUAS_SAFETY_COPY_MODE: 'placeholder_test_only',
    SUAS_SENSITIVE_AGGREGATE_REPORTING: 'disabled',
    SUAS_SESSION_SECRET: 'test-session-secret-please-do-not-use-outside-tests',
    ...overrides,
  };
}

/** Synthetic session secret used by the suite. Never a real secret. */
export const TEST_SESSION_SECRET = 'test-session-secret-please-do-not-use-outside-tests';

/** Database URL for integration tests, pinned to the synthetic test database. */
export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? 'postgresql://suas:suas@localhost:5432/suas_test';
}

/**
 * Separate database for migration-harness tests. Those tests drop and rebuild the
 * schema, which would otherwise pull it out from under the other suites.
 */
export function migrationsTestDatabaseUrl(): string {
  return (
    process.env.TEST_MIGRATIONS_DATABASE_URL ??
    'postgresql://suas:suas@localhost:5432/suas_migrations_test'
  );
}
