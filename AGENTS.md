# AGENTS.md — SUAS implementation rules

Released stack: `0.1.3`  
Manifest: `RELEASE_MANIFEST-0.1.3.md` in `SUAS-specs`  
Authority: `RELEASED_FOR_IMPLEMENTATION`  
Stage: `SPEC-017`

Read `FABLE_HANDOFF.md` and `CONTEXT.md` first.

## Rules

1. `SUAS-specs` is canonical; draft/unreleased future changes are not authority.
2. Every implementation PR cites released spec file/section, stack version, manifest, and test/readiness contract.
3. Semantic gaps return to specs; do not invent product/domain behavior.
4. Follow released `ENVIRONMENT.md`; LOCAL/TEST/STAGING cannot use real veteran data or real external support effects.
5. Keep canonical terms exact: Support Case, Service Request, Referral, Fulfillment Attempt, Fulfillment, Follow-Up, Settlement, Consent Grant, Support Signal, etc.
6. Provider SDKs/payloads/statuses/webhook schemas stay in adapters. Domain modules use SUAS-owned capability ports.
7. Manual/fake coordination remains valid where real providers are unavailable.
8. Correctness-critical state is shared/persistent, not process-local.
9. Async handlers are replay-safe; at-least-once delivery must not duplicate observable business effects.
10. External mutations use stable idempotency identity; ambiguous outcomes reconcile before risky retry.
11. Tenant isolation covers API, DB, jobs, caches, adapters, reports, and admin.
12. Provider disclosure uses use-time authorization/consent and minimum-necessary projection.
13. Preserve released MVP visual/interaction behavior and truthful degraded/no-availability states.
14. No automated emergency dispatch, diagnosis, suicide prediction, or safety-critical generative behavior.
15. Do not add vendor, capacity, SLO, recovery, legal/compliance, partner, staffing, scoring, crisis-copy, or reporting-threshold assumptions that remain unavailable.
16. Build provenance must expose app commit/version, spec version, manifest, environment, and schema/migration version where applicable.
17. Never commit secrets, `.env`, real contact details, provider credentials, or production data.
18. SPEC-018 evidence is required before any production readiness claim.

## Per-slice record

Each SPEC-017 slice records released spec references, files/packages changed, tests/evidence, migration/environment changes, unavailable/manual-only boundaries touched, and any gap returned to specs.

No code/config change may silently upgrade an `UNAVAILABLE`, `MANUAL_ONLY`, `INFORMATION_ONLY`, or `FUTURE` feature to production-operational behavior.

## Cursor Cloud specific instructions

Standard commands live in `README.md` (command table) and `package.json` scripts; prefer those. The notes below are non-obvious caveats for this cloud environment. The startup update script runs `npm ci` only; everything else below is a per-session/manual step.

- Runtime: Node.js 22 (present) and PostgreSQL 17 (installed from the PGDG apt repo). The `suas` role (password `suas`) and the `suas_local`, `suas_test`, and `suas_migrations_test` databases already exist.
- PostgreSQL is not managed by systemd here. Start it once per fresh VM boot before running migrations, tests, or the dev server: `sudo pg_ctlcluster 17 main start` (check with `pg_lsclusters`). `suas_local` is already migrated to the current schema version.
- The app does NOT auto-load `.env`; it reads `process.env` directly. Before `npm run dev`, `npm run migrate`, or `npm run provenance`, export the file into the shell: `set -a; . ./.env; set +a` (or invoke node/tsx with `--env-file=.env`). Without this, startup fails closed listing every missing variable. `.env` already exists (git-ignored) with a generated `SUAS_SESSION_SECRET`; if missing, recreate it per the README "Local development" block.
- Tests are self-contained: `tests/setup.ts` pins its own `SUAS_ENV=TEST` config and points at `suas_test` / `suas_migrations_test`, so `npm test`, `npm run test:unit`, and `npm run verify` run WITHOUT sourcing `.env` (but PostgreSQL must be running for anything beyond `test:unit`). The shared test DB is migrated automatically by the vitest global setup.
- Dev server listens on `127.0.0.1:3000` (`SUAS_HTTP_HOST`/`SUAS_HTTP_PORT`). Public UI is under `/app`; the JSON API is under `/api/v0`. Authenticated surfaces require an `Authorization: Bearer <session-credential>` header (there is no cookie/UI session), so authenticated pages are not reachable by plain browser navigation.
- In LOCAL/TEST the challenge-delivery channel is fake/sink, so OTP codes are never emitted or retrievable over HTTP; drive full login flows through the integration tests or by minting a session with the domain `createSession` helper against `suas_local` (synthetic data only — ENVIRONMENT.md §2).
