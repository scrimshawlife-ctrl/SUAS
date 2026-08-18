/**
 * Application composition and startup sequence.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §5 (configuration validation runs at runtime startup
 *   and fails closed before serving traffic or running workers)
 * - SUAS-specs ENVIRONMENT.md §8 (build provenance surface)
 * - SUAS-specs ENVIRONMENT.md §9 (a build rejects a schema state it cannot safely
 *   operate against)
 * - SUAS-specs HANDOFF.md §3 (foundation order: config validation, migration
 *   harness, durable job abstraction, build provenance)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { describeConfig, loadConfig, type ConfigSource, type SuasConfig } from './config/index.js';
import { createPool, EXPECTED_SCHEMA_VERSION, runMigrations } from './db/index.js';
import { createJobQueue, type DurableJobQueuePort } from './jobs/index.js';
import { createServer } from './http/server.js';
import { buildInfo, type BuildInfo } from './provenance/build-info.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from './release/pins.js';

export interface StartedApp {
  readonly config: SuasConfig;
  readonly server: FastifyInstance;
  readonly pool: Pool | undefined;
  readonly jobQueue: DurableJobQueuePort;
  readonly buildInfo: BuildInfo;
  close(): Promise<void>;
}

export interface StartAppOptions {
  readonly env: ConfigSource;
  /** Skip listening; used by tests that drive the server through inject(). */
  readonly listen?: boolean;
}

export async function startApp(options: StartAppOptions): Promise<StartedApp> {
  // 1. Configuration validation. Nothing else may run before this succeeds.
  const config = loadConfig(options.env);

  // 2. Persistence and schema-state validation.
  let pool: Pool | undefined;
  let schemaVersion: number | null = null;

  if (config.database.migrationsMode !== 'off') {
    pool = createPool(config);
    const migrationResult = await runMigrations(pool, {
      mode: config.database.migrationsMode,
      provenance: { specVersion: SPEC_VERSION, releaseManifest: RELEASE_MANIFEST },
    });
    schemaVersion = migrationResult.schemaVersion;

    if (migrationResult.specStackDrift) {
      // Reported, not fatal: VERSIONING.md §3 keeps spec stack and schema versions
      // as separate identities.
      console.warn(
        `[suas] schema was created under spec stack ` +
          `${migrationResult.schemaProvenance?.specVersion ?? 'unknown'} but this build pins ${SPEC_VERSION}`,
      );
    }
  }

  // 3. Durable async-work seam.
  const jobQueue = createJobQueue(config);

  // 4. Build provenance.
  const resolveBuildInfo = (): BuildInfo =>
    buildInfo({
      config,
      schemaVersion,
      expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
      env: options.env,
    });

  // 5. HTTP surface.
  const server = createServer({ config, buildInfo: resolveBuildInfo });

  if (options.listen !== false) {
    await server.listen({ host: config.http.host, port: config.http.port });
    server.log.info(
      { build_info: resolveBuildInfo(), configuration: describeConfig(config) },
      'SUAS started',
    );
  }

  return {
    config,
    server,
    pool,
    jobQueue,
    buildInfo: resolveBuildInfo(),
    close: async () => {
      await server.close();
      if (pool !== undefined) await pool.end();
    },
  };
}
