export { createPool, DatabaseNotConfiguredError } from './pool.js';
export {
  ensureMigrationsTable,
  planMigrations,
  readAppliedMigrations,
  readSchemaVersion,
  runMigrations,
  SchemaStateError,
  type AppliedMigration,
  type MigrationPlan,
  type MigrationRunOptions,
  type MigrationRunResult,
  type SchemaProvenance,
} from './migrator.js';
export {
  checksumOf,
  loadMigrationFiles,
  MIGRATIONS_DIR,
  type MigrationFile,
} from './migration-files.js';
export { EXPECTED_SCHEMA_VERSION, MIGRATION_LOCK_KEY, MIGRATIONS_TABLE } from './schema-version.js';
