/**
 * Build provenance CLI.
 *
 * Prints the machine-readable build-info object required by SUAS-specs
 * ENVIRONMENT.md §8 and VERSIONING.md §4, without starting a server. The schema
 * version is read from the database when persistence is configured and reachable;
 * otherwise it is reported as null rather than guessed.
 */

import { loadConfig } from '../config/index.js';
import { createPool, EXPECTED_SCHEMA_VERSION, readSchemaVersion } from '../db/index.js';
import { buildInfo } from '../provenance/build-info.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  let schemaVersion: number | null = null;
  if (config.database.url !== undefined) {
    const pool = createPool(config);
    try {
      schemaVersion = await readSchemaVersion(pool);
    } catch {
      // Provenance must still print when the database is unreachable.
      schemaVersion = null;
    } finally {
      await pool.end();
    }
  }

  console.log(
    JSON.stringify(
      buildInfo({
        config,
        schemaVersion,
        expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
        env: process.env,
      }),
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
