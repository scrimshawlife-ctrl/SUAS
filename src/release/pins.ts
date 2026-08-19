/**
 * Released-specification pins for this build.
 *
 * Spec citations:
 * - SUAS-specs VERSIONING.md §3 "Version identities must stay separate"
 * - SUAS-specs RELEASE_MANIFEST-0.1.3.md "Runtime pins"
 * - SUAS-specs ENVIRONMENT.md §3 (SUAS_SPEC_VERSION / SUAS_RELEASE_MANIFEST rules 1-2)
 *
 * These values are the specification identities this build claims to implement.
 * They are deliberately separate from the application version (package.json) and
 * from the database schema version (src/db/schema-version.ts).
 */

/** Specification stack version this build implements. VERSIONING.md §2. */
export const SPEC_VERSION = '0.1.3' as const;

/** Release manifest identifier this build claims. RELEASE_MANIFEST-0.1.3.md. */
export const RELEASE_MANIFEST = 'RELEASE_MANIFEST-0.1.3.md' as const;

/**
 * Specs repository merge commit for the pinned release.
 * VERSIONING.md §2: a git SHA is provenance, not the specification version.
 */
export const SPECS_COMMIT = '75338182bf4ead1adb61dfbc146d0a033ac89dc7' as const;

/** Canonical API version selector. API.md §2; unchanged by v0.1.3. */
export const API_VERSION = 'v0' as const;

/** Path prefix for all v0 routes. API.md §2. */
export const API_PREFIX = '/api/v0' as const;

/** Domain event schema version. VERSIONING.md §3.4; unchanged by v0.1.3. */
export const EVENT_SCHEMA_VERSION = '0.1.0' as const;

/**
 * Implementation stage and readiness, restated from the released manifest so that
 * runtime provenance cannot silently drift from the release boundary.
 * RELEASE_MANIFEST-0.1.3.md "Readiness boundary"; HANDOFF.md §2.
 */
export const IMPLEMENTATION_STAGE = 'SPEC-017' as const;
export const PRODUCTION_READINESS = 'NOT_READY' as const;

/**
 * Production operation is authorized only by SPEC-018.
 * HANDOFF.md §2, §12; ENVIRONMENT.md §3 rule 4; RELEASE_MANIFEST-0.1.3.md.
 *
 * While this is false, real external effects fail closed in every environment
 * class, including PRODUCTION.
 */
export const SPEC_018_PRODUCTION_AUTHORIZED = false as const;
