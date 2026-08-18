-- 0001_baseline.sql — schema baseline and provenance
--
-- Released contract implemented:
-- - SUAS-specs ENVIRONMENT.md §9 "Migration and compatibility rules": migrations cite
--   the released contract they implement; a build must reject a schema state it cannot
--   safely operate against; schema compatibility uses an explicit migration/schema
--   version mechanism rather than the application version.
-- - SUAS-specs VERSIONING.md §3.5 "Database migration/schema version".
--
-- This baseline introduces no domain tables. Domain schema arrives with the slices
-- that own it (SPEC017_PLAN.md Slices 2-9), each citing DATA_MODEL.md.
--
-- Destructive-change note (ENVIRONMENT.md §9): this migration is additive only and
-- has no destructive step; forward-fix is a later numbered migration.

-- Records which released specification stack the physical schema was created under.
-- Bookkeeping of applied migrations lives in suas_schema_migrations, which the
-- migration runner owns; this table carries release provenance for restore checks.
CREATE TABLE IF NOT EXISTS suas_schema_metadata (
    singleton     boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
    spec_version  text        NOT NULL,
    release_manifest text     NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE suas_schema_metadata IS
    'Released spec stack and manifest the physical schema was built for (ENVIRONMENT.md §9).';
