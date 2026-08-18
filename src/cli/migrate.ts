/**
 * Migration CLI.
 *
 * Usage:
 *   npm run migrate            # uses SUAS_MIGRATIONS_MODE
 *   npm run migrate -- apply   # explicit override for this invocation
 *   npm run migrate -- validate
 *   npm run migrate -- status
 *
 * SUAS-specs ENVIRONMENT.md §3 "Data / persistence": SUAS_MIGRATIONS_MODE is an
 * implementation control; production automatic-migration policy must be explicit
 * in deployment runbooks rather than implied by application startup.
 */

import { loadConfig, type MigrationsMode } from '../config/index.js';
import {
  createPool,
  ensureMigrationsTable,
  loadMigrationFiles,
  planMigrations,
  readAppliedMigrations,
  runMigrations,
} from '../db/index.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../release/pins.js';

const MODES: readonly string[] = ['off', 'validate', 'apply', 'status'];

async function main(): Promise<void> {
  const requested = process.argv[2];
  if (requested !== undefined && !MODES.includes(requested)) {
    throw new Error(
      `Unknown migration command "${requested}". Expected one of ${MODES.join(', ')}.`,
    );
  }

  const config = loadConfig(process.env);
  const pool = createPool(config);

  try {
    if (requested === 'status') {
      await ensureMigrationsTable(pool);
      const [files, applied] = await Promise.all([
        loadMigrationFiles(),
        readAppliedMigrations(pool),
      ]);
      const plan = planMigrations(files, applied);
      console.log(
        JSON.stringify(
          {
            environment: config.environment,
            applied: applied.map((row) => ({
              version: row.version,
              name: row.name,
              applied_at: row.appliedAt.toISOString(),
            })),
            pending: plan.pending.map((file) => file.fileName),
            drifted: plan.drifted,
            orphaned: plan.orphaned.map((row) => ({ version: row.version, name: row.name })),
          },
          null,
          2,
        ),
      );
      return;
    }

    const mode = (requested ?? config.database.migrationsMode) as MigrationsMode;
    const result = await runMigrations(pool, {
      mode,
      provenance: { specVersion: SPEC_VERSION, releaseManifest: RELEASE_MANIFEST },
    });
    console.log(
      JSON.stringify(
        {
          mode: result.mode,
          environment: config.environment,
          schema_version: result.schemaVersion,
          expected_schema_version: result.expectedSchemaVersion,
          applied_now: result.appliedNow,
          spec_stack_drift: result.specStackDrift,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
