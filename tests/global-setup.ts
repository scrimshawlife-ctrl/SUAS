/**
 * One-time test-suite setup.
 *
 * Brings the shared TEST database to the schema version this build requires, so
 * `npm test` works against a fresh database without depending on which test file
 * happens to run first.
 *
 * SUAS-specs ENVIRONMENT.md §2 (TEST is synthetic-only), §5 (configuration
 * validation runs in tests), §9 (a build rejects a schema state it cannot operate
 * against).
 */

import { Pool } from 'pg';
import { runMigrations } from '../src/db/index.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../src/release/pins.js';

export default async function setup(): Promise<void> {
  const connectionString =
    process.env.TEST_DATABASE_URL ?? 'postgresql://suas:suas@localhost:5432/suas_test';
  const pool = new Pool({ connectionString, max: 2 });
  try {
    await runMigrations(pool, {
      mode: 'apply',
      provenance: { specVersion: SPEC_VERSION, releaseManifest: RELEASE_MANIFEST },
    });
  } finally {
    await pool.end();
  }
}
