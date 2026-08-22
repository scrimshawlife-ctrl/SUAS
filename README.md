# SUAS

Shut Up and Serve (SUAS) is the implementation repository for the consent-governed veteran support coordination platform specified in [`scrimshawlife-ctrl/SUAS-specs`](https://github.com/scrimshawlife-ctrl/SUAS-specs).

Public site: https://scrimshawlife-ctrl.github.io/SUAS/

## Start here

**Fable:** read [FABLE_HANDOFF.md](FABLE_HANDOFF.md), then [CONTEXT.md](CONTEXT.md), [AGENTS.md](AGENTS.md), and [SPEC017_PLAN.md](SPEC017_PLAN.md).

Canonical released specs:

- specification stack: `0.1.6`
- specs merge: `5074812eff61e22f8932de4c1460bc6d6d37f747`
- manifest: `RELEASE_MANIFEST-0.1.6.md`
- current stage: `SPEC-017` implementation conformance
- implementation authority: `RELEASED_FOR_IMPLEMENTATION`
- pilot readiness: `NOT_READY`
- production readiness: `NOT_READY`

## Local development

Requirements: Node.js 22+ and a reachable PostgreSQL 17 instance.

```bash
npm ci
cp .env.example .env
echo "SUAS_SESSION_SECRET=$(openssl rand -hex 32)" >> .env
createdb suas_local
npm run migrate -- apply
npm run dev
```

`SUAS_SESSION_SECRET` is required in every environment class and startup fails
closed without it. It ships empty in `.env.example` and must never be committed.

Commands:

| Command                       | Purpose                                                |
| ----------------------------- | ------------------------------------------------------ |
| `npm run verify`              | format check, lint, typecheck, and the full test suite |
| `npm run build`               | compile to `dist/`                                     |
| `npm start`                   | run the compiled build                                 |
| `npm run dev`                 | run from source with reload                            |
| `npm test`                    | full suite (integration tests need PostgreSQL)         |
| `npm run test:unit`           | unit tests only, no database required                  |
| `npm run migrate -- status`   | applied, pending, drifted, and orphaned migrations     |
| `npm run migrate -- apply`    | apply pending migrations under an advisory lock        |
| `npm run migrate -- validate` | verify schema state without mutating it                |
| `npm run provenance`          | print the build-info object                            |

Integration tests use two databases, created once:

```bash
createdb suas_test
createdb suas_migrations_test
```

`suas_test` is shared by the suites and is migrated automatically before the run. The
migration-harness tests rebuild a schema from empty, so they own `suas_migrations_test`
separately. Override either with `TEST_DATABASE_URL` and `TEST_MIGRATIONS_DATABASE_URL`.

HTTP surface so far:

| Endpoint                                           | Authorization                         |
| -------------------------------------------------- | ------------------------------------- |
| `GET /api/v0/health`                               | none; liveness only                   |
| `POST /api/v0/auth/challenges`                     | none; issues a passwordless challenge |
| `POST /api/v0/auth/challenges/commands/verify`     | none; exchanges a code for a session  |
| `POST /api/v0/auth/mfa/challenges`                 | session                               |
| `POST /api/v0/auth/mfa/challenges/commands/verify` | session; elevates it                  |
| `POST /api/v0/auth/sessions/commands/logout`       | session                               |
| `GET /api/v0/admin/build-info`                     | SUAS admin, MFA-elevated              |

## Environment

`.env.example` maps the released [SUAS-specs `ENVIRONMENT.md`](https://github.com/scrimshawlife-ctrl/SUAS-specs/blob/main/ENVIRONMENT.md) contract.

Logical classes are `LOCAL`, `TEST`, `STAGING`, `PRODUCTION`. LOCAL/TEST/STAGING must not use real veteran data or real external support effects. Invalid environment/feature combinations must fail closed at startup.

## Release boundary

v0.1.6 authorizes implementation but not production operation.

Production-unavailable until later decision/evidence closure:

- production infrastructure and real veteran data/live pilot;
- production Support Signal scoring;
- real transportation/shelter/food/external peer providers;
- production workload/SLO/RTO/RPO targets;
- sensitive aggregate reporting.

Manual/fake/test adapters are valid where the release permits them.

## Governing rules

1. `SUAS-specs` is canonical; code does not redefine it.
2. Every implementation PR cites released spec file/section, stack version, manifest, and relevant test/readiness contract.
3. Semantic gaps return to specs rather than becoming implementation defaults.
4. Preserve the MVP visual/interaction identity and required truthful degraded/no-availability states.
5. Provider SDKs/statuses/payloads stay behind adapters; domain modules use SUAS-owned ports.
6. Preserve stateless/shared correctness state, durable async-work semantics, persistent idempotency, tenant isolation, replay-safe events, and bounded access paths.
7. No automated emergency dispatch, diagnosis, suicidality determination, or safety-critical generative AI.
8. Do not claim HIPAA compliance or production readiness from release/implementation alone.

See [FABLE_HANDOFF.md](FABLE_HANDOFF.md), [CONTEXT.md](CONTEXT.md), [AGENTS.md](AGENTS.md), [IMPLEMENTATION_BOOTSTRAP.md](IMPLEMENTATION_BOOTSTRAP.md), and [SPEC017_PLAN.md](SPEC017_PLAN.md).
