/**
 * Test harness setup.
 *
 * SUAS-specs ENVIRONMENT.md §2: TEST forbids real veteran data and real external
 * side effects. SUAS-specs TESTING.md §12: synthetic fixtures only.
 *
 * The suite pins SUAS_ENV=TEST explicitly rather than inferring it, per
 * ENVIRONMENT.md §2 ("never inferred from ... NODE_ENV").
 */

process.env.SUAS_ENV = 'TEST';
process.env.SUAS_SPEC_VERSION ??= '0.1.1';
process.env.SUAS_RELEASE_MANIFEST ??= 'RELEASE_MANIFEST-0.1.1.md';
process.env.SUAS_ALLOW_REAL_EXTERNAL_EFFECTS = 'false';
process.env.SUAS_MIGRATIONS_MODE ??= 'apply';
process.env.SUAS_EMAIL_MODE ??= 'fake';
process.env.SUAS_SMS_MODE ??= 'fake';
process.env.SUAS_TRANSPORTATION_ADAPTER_MODE ??= 'fake';
process.env.SUAS_SHELTER_ADAPTER_MODE ??= 'fake';
process.env.SUAS_FOOD_ADAPTER_MODE ??= 'fake';
process.env.SUAS_PEER_SUPPORT_ADAPTER_MODE ??= 'manual';
process.env.SUAS_SUPPORT_SIGNAL_MODE ??= 'fixture';
process.env.SUAS_SAFETY_COPY_MODE ??= 'placeholder_test_only';
process.env.SUAS_SENSITIVE_AGGREGATE_REPORTING ??= 'disabled';
process.env.TEST_DATABASE_URL ??= 'postgresql://suas:suas@localhost:5432/suas_test';
