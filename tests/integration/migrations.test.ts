/**
 * Migration harness integration evidence (requires PostgreSQL).
 *
 * SUAS-specs ENVIRONMENT.md §3 "Data / persistence", §5, §9;
 * SUAS-specs VERSIONING.md §3.5;
 * SUAS-specs TESTING.md §2 "Migration/restore" layer.
 */

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EXPECTED_SCHEMA_VERSION,
  loadMigrationFiles,
  MIGRATIONS_TABLE,
  readAppliedMigrations,
  readSchemaVersion,
  runMigrations,
  SchemaStateError,
} from '../../src/db/index.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../../src/release/pins.js';
import { migrationsTestDatabaseUrl } from '../helpers/env.js';

const provenance = { specVersion: SPEC_VERSION, releaseManifest: RELEASE_MANIFEST };

/** Every migration version on disk, so these tests stay correct as slices add them. */
async function allMigrationVersions(): Promise<number[]> {
  return (await loadMigrationFiles()).map((file) => file.version);
}
// This suite rebuilds the schema from empty, so it owns a database of its own.
const pool = new Pool({ connectionString: migrationsTestDatabaseUrl(), max: 4 });

/**
 * Return the database to empty. Dropping the whole schema keeps this correct as
 * migrations are added, rather than needing a hand-maintained list of objects.
 */
async function resetDatabase(): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
}

beforeEach(resetDatabase);
afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

describe('apply mode', () => {
  it('applies pending migrations and records the schema version', async () => {
    const versions = await allMigrationVersions();
    const result = await runMigrations(pool, { mode: 'apply', provenance });
    expect(result.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(result.appliedNow).toEqual(versions);

    const applied = await readAppliedMigrations(pool);
    expect(applied).toHaveLength(versions.length);
    expect(applied[0]?.name).toBe('baseline');
  });

  it('is idempotent when re-run', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    const second = await runMigrations(pool, { mode: 'apply', provenance });
    expect(second.appliedNow).toEqual([]);
    expect(second.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
  });

  it('records the released spec stack the schema was built for', async () => {
    const result = await runMigrations(pool, { mode: 'apply', provenance });
    expect(result.schemaProvenance).toEqual({
      specVersion: SPEC_VERSION,
      releaseManifest: RELEASE_MANIFEST,
    });
    expect(result.specStackDrift).toBe(false);
  });

  it('serializes concurrent runs so a migration is applied once', async () => {
    const results = await Promise.all([
      runMigrations(pool, { mode: 'apply', provenance }),
      runMigrations(pool, { mode: 'apply', provenance }),
    ]);
    // Each migration is applied exactly once across both concurrent runs.
    const totalApplied = results.flatMap((result) => result.appliedNow).sort((a, b) => a - b);
    expect(totalApplied).toEqual(await allMigrationVersions());
    expect(await readSchemaVersion(pool)).toBe(EXPECTED_SCHEMA_VERSION);
  });
});

describe('validate mode', () => {
  it('passes against a fully migrated database', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    const result = await runMigrations(pool, { mode: 'validate', provenance });
    expect(result.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(result.appliedNow).toEqual([]);
  });

  it('rejects a database with pending migrations', async () => {
    await expect(runMigrations(pool, { mode: 'validate', provenance })).rejects.toThrow(
      SchemaStateError,
    );
    await expect(runMigrations(pool, { mode: 'validate', provenance })).rejects.toThrow(
      /migration\(s\) are pending/,
    );
  });

  it('never mutates the schema', async () => {
    await runMigrations(pool, { mode: 'validate', provenance }).catch(() => undefined);
    const applied = await readAppliedMigrations(pool);
    expect(applied).toHaveLength(0);
  });
});

describe('ENVIRONMENT.md §9 — reject unsafe schema states', () => {
  it('rejects a migration edited after it was applied', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    await pool.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = 'tampered' WHERE version = 1`);
    await expect(runMigrations(pool, { mode: 'validate', provenance })).rejects.toThrow(
      /was modified after it was applied/,
    );
  });

  it('rejects a database ahead of this build', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    await pool.query(
      `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES (99, 'future_work', 'x')`,
    );
    await expect(runMigrations(pool, { mode: 'validate', provenance })).rejects.toThrow(
      /has no file on disk/,
    );
  });

  it('rejects a schema version the build does not expect', async () => {
    await expect(
      runMigrations(pool, { mode: 'apply', provenance, expectedSchemaVersion: 99 }),
    ).rejects.toThrow(/this build requires 99/);
  });
});

describe('off mode', () => {
  it('performs no database work', async () => {
    const result = await runMigrations(pool, { mode: 'off', provenance });
    expect(result.schemaVersion).toBe(0);
    expect(result.appliedNow).toEqual([]);

    const exists = await pool.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [MIGRATIONS_TABLE],
    );
    expect(exists.rows[0]?.present).toBe(false);
  });
});
