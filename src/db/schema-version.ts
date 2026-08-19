/**
 * Explicit database schema/migration version.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §9 "Migration and compatibility rules"
 * - SUAS-specs VERSIONING.md §3.5 "Database migration/schema version"
 *
 * VERSIONING.md §3 requires this identity to stay separate from the application
 * version and the specification stack version. ENVIRONMENT.md §9 forbids inferring
 * schema compatibility from the application version, so the value below is the
 * build's explicit statement of the schema it can operate against.
 */

/** Highest migration version this build requires to be applied. */
export const EXPECTED_SCHEMA_VERSION = 8;

/** Table owned by the migration runner itself, outside the numbered migration set. */
export const MIGRATIONS_TABLE = 'suas_schema_migrations';

/**
 * PostgreSQL advisory-lock key serializing migration runs across the stateless
 * instances of ARCHITECTURE.md §3 invariant 1. Arbitrary but stable.
 */
export const MIGRATION_LOCK_KEY = 8_150_017;
