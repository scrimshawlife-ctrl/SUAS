/**
 * PostgreSQL migration and schema-version harness.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §3 "Data / persistence" (SUAS_MIGRATIONS_MODE)
 * - SUAS-specs ENVIRONMENT.md §5 (startup validation fails closed)
 * - SUAS-specs ENVIRONMENT.md §9 "Migration and compatibility rules"
 * - SUAS-specs VERSIONING.md §3.5 (explicit schema/migration version identity)
 * - SUAS-specs ARCHITECTURE.md §3 invariant 1 (many stateless instances)
 */

import type { Pool, PoolClient } from 'pg';
import type { MigrationsMode } from '../config/index.js';
import { loadMigrationFiles, type MigrationFile } from './migration-files.js';
import { EXPECTED_SCHEMA_VERSION, MIGRATION_LOCK_KEY, MIGRATIONS_TABLE } from './schema-version.js';

/** Raised when the database schema state is one this build cannot safely operate against. */
export class SchemaStateError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Database schema state rejected (SUAS-specs ENVIRONMENT.md §9).\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'SchemaStateError';
    this.issues = issues;
  }
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationPlan {
  /** Files not yet recorded as applied, in ascending version order. */
  readonly pending: readonly MigrationFile[];
  /** Applied migrations whose recorded checksum no longer matches the file. */
  readonly drifted: readonly { version: number; name: string }[];
  /** Applied migrations with no corresponding file on disk. */
  readonly orphaned: readonly AppliedMigration[];
}

/**
 * Compare on-disk migrations against applied history.
 * Pure so the failure modes are unit-testable without a database.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const fileVersions = new Set(files.map((file) => file.version));

  const pending: MigrationFile[] = [];
  const drifted: { version: number; name: string }[] = [];

  for (const file of files) {
    const record = appliedByVersion.get(file.version);
    if (record === undefined) {
      pending.push(file);
    } else if (record.checksum !== file.checksum) {
      drifted.push({ version: file.version, name: file.name });
    }
  }

  const orphaned = applied.filter((row) => !fileVersions.has(row.version));

  return { pending, drifted, orphaned };
}

function describePlanProblems(plan: MigrationPlan): string[] {
  const issues: string[] = [];
  for (const item of plan.drifted) {
    issues.push(
      `Migration ${String(item.version).padStart(4, '0')}_${item.name} was modified after it was ` +
        `applied; edit history is not a substitute for a forward-fix migration (ENVIRONMENT.md §9).`,
    );
  }
  for (const item of plan.orphaned) {
    issues.push(
      `Applied migration ${String(item.version).padStart(4, '0')}_${item.name} has no file on disk; ` +
        `the database is ahead of, or diverged from, this build.`,
    );
  }
  return issues;
}

/** Create the runner-owned bookkeeping table. Idempotent, outside the numbered set. */
export async function ensureMigrationsTable(db: Pick<Pool, 'query'> | PoolClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version    integer     PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function readAppliedMigrations(
  db: Pick<Pool, 'query'> | PoolClient,
): Promise<AppliedMigration[]> {
  const result = await db.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
  }>(`SELECT version, name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version ASC`);
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

/** Current schema version: the highest applied migration, or 0 for an empty database. */
export async function readSchemaVersion(db: Pick<Pool, 'query'> | PoolClient): Promise<number> {
  const applied = await readAppliedMigrations(db);
  return applied.reduce((max, row) => Math.max(max, row.version), 0);
}

export interface SchemaProvenance {
  readonly specVersion: string;
  readonly releaseManifest: string;
}

async function readSchemaProvenance(
  db: Pick<Pool, 'query'> | PoolClient,
): Promise<SchemaProvenance | undefined> {
  const exists = await db.query<{ present: boolean }>(
    `SELECT to_regclass('suas_schema_metadata') IS NOT NULL AS present`,
  );
  if (exists.rows[0]?.present !== true) return undefined;

  const result = await db.query<{ spec_version: string; release_manifest: string }>(
    `SELECT spec_version, release_manifest FROM suas_schema_metadata WHERE singleton`,
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : { specVersion: row.spec_version, releaseManifest: row.release_manifest };
}

async function writeSchemaProvenance(db: PoolClient, provenance: SchemaProvenance): Promise<void> {
  await db.query(
    `INSERT INTO suas_schema_metadata (singleton, spec_version, release_manifest)
     VALUES (true, $1, $2)
     ON CONFLICT (singleton) DO UPDATE
       SET spec_version = EXCLUDED.spec_version,
           release_manifest = EXCLUDED.release_manifest,
           updated_at = now()`,
    [provenance.specVersion, provenance.releaseManifest],
  );
}

export interface MigrationRunOptions {
  readonly mode: MigrationsMode;
  readonly expectedSchemaVersion?: number;
  readonly provenance: SchemaProvenance;
  readonly migrationsDir?: string;
}

export interface MigrationRunResult {
  readonly mode: MigrationsMode;
  readonly schemaVersion: number;
  readonly expectedSchemaVersion: number;
  readonly appliedNow: readonly number[];
  /**
   * True when the schema was created under a different released spec stack than
   * this build pins. Reported, not fatal: VERSIONING.md §3 keeps the specification
   * stack version and the schema version as separate identities, so a spec patch
   * that changes no schema must not block startup.
   */
  readonly specStackDrift: boolean;
  readonly schemaProvenance: SchemaProvenance | undefined;
}

/**
 * Run the migration harness in the configured mode.
 *
 * - `off`: no database work at all.
 * - `validate`: verify applied history matches the on-disk set and the expected
 *   schema version; never mutate the schema.
 * - `apply`: apply pending migrations under an advisory lock, then validate.
 */
export async function runMigrations(
  pool: Pool,
  options: MigrationRunOptions,
): Promise<MigrationRunResult> {
  const expectedSchemaVersion = options.expectedSchemaVersion ?? EXPECTED_SCHEMA_VERSION;

  if (options.mode === 'off') {
    return {
      mode: 'off',
      schemaVersion: 0,
      expectedSchemaVersion,
      appliedNow: [],
      specStackDrift: false,
      schemaProvenance: undefined,
    };
  }

  const files = await loadMigrationFiles(options.migrationsDir);
  const client = await pool.connect();
  const appliedNow: number[] = [];

  try {
    if (options.mode === 'apply') {
      // Serialize concurrent instances; the lock is released with the session.
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    }

    await ensureMigrationsTable(client);
    const plan = planMigrations(files, await readAppliedMigrations(client));

    // Drift and orphans are unsafe in every mode, including `apply`.
    const problems = describePlanProblems(plan);
    if (problems.length > 0) {
      throw new SchemaStateError(problems);
    }

    if (options.mode === 'validate' && plan.pending.length > 0) {
      throw new SchemaStateError([
        `${plan.pending.length} migration(s) are pending (${plan.pending
          .map((file) => file.fileName)
          .join(', ')}) while SUAS_MIGRATIONS_MODE=validate. ` +
          `This build cannot safely operate against the current schema state.`,
      ]);
    }

    if (options.mode === 'apply') {
      for (const file of plan.pending) {
        // Each migration and its bookkeeping row commit together, so a crash
        // cannot record a migration that did not fully apply.
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
            [file.version, file.name, file.checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new SchemaStateError([
            `Migration ${file.fileName} failed and was rolled back: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ]);
        }
        appliedNow.push(file.version);
      }
    }

    const schemaVersion = await readSchemaVersion(client);
    if (schemaVersion !== expectedSchemaVersion) {
      throw new SchemaStateError([
        `Database schema version is ${schemaVersion} but this build requires ` +
          `${expectedSchemaVersion}. Schema compatibility is not inferred from the application ` +
          `version (ENVIRONMENT.md §9).`,
      ]);
    }

    if (options.mode === 'apply') {
      await writeSchemaProvenance(client, options.provenance);
    }

    const schemaProvenance = await readSchemaProvenance(client);
    const specStackDrift =
      schemaProvenance !== undefined &&
      schemaProvenance.specVersion !== options.provenance.specVersion;

    return {
      mode: options.mode,
      schemaVersion,
      expectedSchemaVersion,
      appliedNow,
      specStackDrift,
      schemaProvenance,
    };
  } finally {
    if (options.mode === 'apply') {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {
        // The lock is released with the session regardless; swallow teardown noise.
      });
    }
    client.release();
  }
}
