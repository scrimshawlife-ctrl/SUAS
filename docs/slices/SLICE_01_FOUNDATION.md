# Slice 1 — Foundation: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 1 only: toolchain, configuration contract, build
provenance, migration/schema-version harness, test harness, synthetic fixture
boundary, CI skeleton, and the durable-job abstraction seam. No product/domain
workflow, no UI, and no provider integration is implemented here.

## 1. Released spec citations

| Spec                        | Sections relied on                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT.md`            | §2 environments, §3 configuration variables, §4 precedence, §5 startup validation, §6 secret classes, §7 repository files, §8 build provenance, §9 migration/compatibility |
| `HANDOFF.md`                | §2 lifecycle, §3 required implementation sequence, §4 definition of done, §5 repository hygiene, §6 versioning, §7 environment contract                                    |
| `VERSIONING.md`             | §2 semantic versioning, §3 separate version identities, §4 build provenance                                                                                                |
| `ARCHITECTURE.md`           | §3 invariants 1-5 and 11, §8 durable background work, §10 concurrency/idempotency, §13 resilience, §14 observability, §16 non-goals                                        |
| `DATA_MODEL.md`             | §1 conventions, §14 integrity rules (schema conventions only; no domain tables yet)                                                                                        |
| `API.md`                    | §2 version prefix, §4 authorization, §6 error body, §8 correlation                                                                                                         |
| `TESTING.md`                | §2 test layers, §12 fixtures/non-goals                                                                                                                                     |
| `RELEASE_MANIFEST-0.1.1.md` | runtime pins, environment authority, readiness boundary                                                                                                                    |

## 2. Change map — file to spec section

| Path                                          | Implements                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/release/pins.ts`                         | `VERSIONING.md` §3; `RELEASE_MANIFEST-0.1.1.md` runtime pins                  |
| `src/config/schema.ts`                        | `ENVIRONMENT.md` §2, §3, §4, §5, §6                                           |
| `src/config/load.ts`                          | `ENVIRONMENT.md` §5 fail-closed loading; §6 redaction                         |
| `src/db/schema-version.ts`                    | `ENVIRONMENT.md` §9; `VERSIONING.md` §3.5                                     |
| `src/db/migration-files.ts`                   | `ENVIRONMENT.md` §9; `HANDOFF.md` §5                                          |
| `src/db/migrator.ts`                          | `ENVIRONMENT.md` §3 migrations mode, §5, §9; `ARCHITECTURE.md` §3 invariant 1 |
| `src/db/pool.ts`                              | `ARCHITECTURE.md` §3 invariant 2, §13; `ENVIRONMENT.md` §3 bounded pool       |
| `src/jobs/port.ts`                            | `ARCHITECTURE.md` §3 invariants 4-5, §8, §10                                  |
| `src/jobs/in-memory-queue.ts`                 | `HANDOFF.md` §3 fake/test implementation                                      |
| `src/jobs/factory.ts`                         | `ARCHITECTURE.md` §8 (D-022 open), §16; `ENVIRONMENT.md` §4-§5                |
| `src/provenance/build-info.ts`                | `ENVIRONMENT.md` §8; `VERSIONING.md` §3-§4                                    |
| `src/http/server.ts`                          | `API.md` §2, §6, §8; `ENVIRONMENT.md` §8                                      |
| `src/app.ts`, `src/main.ts`                   | `ENVIRONMENT.md` §5; `HANDOFF.md` §3 startup order                            |
| `src/testing/fixture-boundary.ts`             | `ENVIRONMENT.md` §2, §7; `TESTING.md` §12                                     |
| `src/cli/migrate.ts`, `src/cli/provenance.ts` | `ENVIRONMENT.md` §3 migrations control, §8                                    |
| `migrations/0001_baseline.sql`                | `ENVIRONMENT.md` §9; `VERSIONING.md` §3.5                                     |
| `.github/workflows/verify.yml`                | `HANDOFF.md` §5; `TESTING.md` §2                                              |
| `.env.example`                                | `ENVIRONMENT.md` §3, §7                                                       |

## 3. Evidence

`npm run verify` runs format check, lint, typecheck, and 100 tests (8 files).
Integration tests run against PostgreSQL 17.

| Invariant                                                                        | Evidence                                                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Environment class is explicit, never inferred from `NODE_ENV`                    | `tests/unit/config.test.ts` — "environment class is explicit"                                       |
| Spec version / manifest mismatch fails closed                                    | same file — "spec and manifest must match the build"                                                |
| Real external effects rejected in every class, including PRODUCTION              | same file — "real external effects"                                                                 |
| Production deployment refused until SPEC-018                                     | same file — "production deployment is prohibited"                                                   |
| LOCAL/TEST/STAGING cannot point at production data resources                     | same file — "must not point at production data"                                                     |
| Unavailable vendor/scoring/copy/reporting surfaces cannot be enabled             | same file — "unavailable vendor surfaces stay unavailable" (cites D-011, D-012, D-017–D-020, D-025) |
| Secrets never appear in logs, errors, or provenance                              | `config.test.ts` "secret handling"; `build-info.test.ts` "no secrets in provenance"                 |
| Migrations apply once, are idempotent, and survive concurrent instances          | `tests/integration/migrations.test.ts` — apply mode, incl. concurrent run                           |
| Build rejects an unsafe schema state (pending, drifted, orphaned, wrong version) | same file — "reject unsafe schema states"                                                           |
| `validate` never mutates the schema                                              | same file — "never mutates the schema"                                                              |
| Version identities stay separate                                                 | `tests/unit/build-info.test.ts` — "version identities stay separate"                                |
| Provenance completeness is reported, not implied                                 | same file — "marks an unstamped build as incomplete provenance"                                     |
| Durable-work seam refuses to hand a non-durable queue to STAGING/PRODUCTION      | `tests/unit/jobs.test.ts`                                                                           |
| Job idempotency identity is tenant-scoped                                        | same file                                                                                           |
| Fixtures are refused outside synthetic environments                              | `tests/unit/fixture-boundary.test.ts`                                                               |
| Fixture contact data is fictitious by construction                               | same file; `tests/unit/repository-hygiene.test.ts`                                                  |
| `.env.example` documents every variable the build reads                          | `tests/unit/repository-hygiene.test.ts`                                                             |
| No `.env`, key material, or routable contact data in the repository              | same file                                                                                           |
| `/api/v0` is the sole version selector; released error body shape                | `tests/integration/http.test.ts`                                                                    |
| Correlation ids propagate without PII                                            | same file                                                                                           |
| Startup fails closed before serving traffic                                      | same file — "startup sequence"                                                                      |

## 4. Environment and configuration changes

`.env.example` now also documents `SUAS_HTTP_HOST`, `SUAS_HTTP_PORT`,
`SUAS_LOG_LEVEL`, `SUAS_BUILD_COMMIT`, and `SUAS_BUILD_TIMESTAMP`. The first three
are implementation-owned mechanism; the last two are build-provenance stamps
normally set by CI. All released `ENVIRONMENT.md` §3 variables are unchanged in
name and allowed values.

A repository test fails if a configuration variable the build reads is missing
from `.env.example`.

## 5. Migration notes

`migrations/0001_baseline.sql` is additive and introduces no domain tables. It
creates `suas_schema_metadata`, which records the released spec stack and manifest
the physical schema was built under.

Bookkeeping lives in `suas_schema_migrations`, owned by the runner and created
idempotently outside the numbered set. Schema version is the highest applied
migration; the build's required version is `EXPECTED_SCHEMA_VERSION`, stated
explicitly rather than inferred from the application version.

Rollback/forward-fix: this migration has no destructive step. Editing an applied
migration is detected as checksum drift and rejected; corrections require a new
numbered migration.

## 6. Idempotency and failure behavior

- Each migration and its bookkeeping row commit in one transaction, so a crash cannot record a migration that did not fully apply.
- `apply` holds a PostgreSQL advisory lock, so concurrent instances produce one application (test: two concurrent runs, one applied version).
- `validate` performs no DDL.
- The job port carries a stable logical identity so duplicate enqueues do not multiply effects; the in-memory implementation demonstrates the contract and declares itself non-durable.
- Configuration and schema-state failures abort startup with a non-zero exit and an itemized list of violated invariants; no partially-started process serves traffic.

## 7. Security and privacy impact

- No secret value is written to logs, errors, provenance, or fixtures; connection-string credentials are never echoed (tested).
- Log redaction covers `authorization`, `cookie`, and `idempotency-key` headers.
- Correlation ids are opaque; a supplied `x-request-id` is accepted only if it matches a restricted character set, otherwise a UUID replaces it.
- 5xx responses return a non-sensitive message; details stay in logs.
- No veteran data of any kind exists in this slice.

## 8. Availability boundaries preserved

No `UNAVAILABLE`, `MANUAL_ONLY`, `INFORMATION_ONLY`, or `FUTURE` feature is made
operational. Specifically, configuration cannot enable: real external effects in
any environment class; production Support Signal scoring (D-011); official safety
copy (D-012); real transportation/shelter/food/peer adapters (D-017–D-020);
sensitive aggregate reporting (D-025); production email/SMS vendors; or a durable
production queue vendor (D-022). Each rejection names the owning decision.

`build-info` reports `production_readiness: NOT_READY` and
`implementation_stage: SPEC-017`.

## 9. Semantic gaps returned to `SUAS-specs`

These are implementation-mechanism choices made under `HANDOFF.md` §11 where the
released text is silent. Each is documented in code and should be confirmed or
corrected by a specs patch. None of them changes a released product/domain rule.

1. **Production-data detection mechanism.** `ENVIRONMENT.md` §5 requires failing closed when LOCAL/TEST/STAGING "points at known production data resources" but names no mechanism. Implemented as a host/database-name marker deny-list (`prod`, `production`, `live`), documented as a safety net rather than authority. A released explicit resource-class label would be stronger than name matching.
2. **Build-info exposure and authorization.** `ENVIRONMENT.md` §8 permits an "admin/debug build-info surface", but `API.md` §3 lists no build-info resource prefix and §4 requires an authenticated session for non-auth requests. Implemented as `GET /api/v0/admin/build-info`, registered only outside PRODUCTION until admin authorization exists in Slice 3. Specs should state whether this is an authenticated admin resource, an unauthenticated operations endpoint, or non-HTTP only.
3. **Liveness endpoint is not in the released API contract.** `GET /api/v0/health` was added as deployment mechanism. Confirm whether health/readiness endpoints belong in the released API surface and what they may disclose.
4. **Refusing to boot in `SUAS_ENV=PRODUCTION`.** `HANDOFF.md` §2 states production deployment is prohibited, while `ENVIRONMENT.md` §2 lists PRODUCTION as a valid class whose real effects are separately gated. Implemented as a hard startup refusal gated on a single `SPEC_018_PRODUCTION_AUTHORIZED` flag. Confirm this is the intended reading rather than allowing a PRODUCTION deployment with all effects disabled.
5. **Session-secret requirement scope.** `ENVIRONMENT.md` §3 requires a session secret "where the chosen implementation requires one" and §5 requires secrets for an enabled capability. Sessions do not exist until Slice 3, so the secret is currently optional in LOCAL/TEST, required in STAGING, and validated for length (≥32) wherever supplied. Confirm the intended floor.
6. **Spec-stack drift on a restored database.** A schema created under a different released spec stack is reported, not fatal, because `VERSIONING.md` §3 keeps spec-stack and schema versions as separate identities. Confirm that a spec patch which changes no schema must not block startup.
7. **`DATABASE_POOL_MAX` default.** `ENVIRONMENT.md` §3 leaves the production value to release/operations evidence. A local default of 5 with a 1-100 bound is used; no production value is implied.

## 10. Readiness statement

This slice provides foundation evidence only. It does not advance any
`TESTING.md` §11 readiness gate, does not authorize a pilot, and does not
authorize production operation. SPEC-018 remains the only path to go-live.
