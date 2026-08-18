# SUAS

Shut Up and Serve (SUAS) is the implementation repository for the consent-governed veteran support coordination platform specified in [`scrimshawlife-ctrl/SUAS-specs`](https://github.com/scrimshawlife-ctrl/SUAS-specs).

## Start here

**Fable:** read [FABLE_HANDOFF.md](FABLE_HANDOFF.md), then [CONTEXT.md](CONTEXT.md), [AGENTS.md](AGENTS.md), and [SPEC017_PLAN.md](SPEC017_PLAN.md).

Canonical released specs:

- specification stack: `0.1.1`
- specs merge: `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
- manifest: `RELEASE_MANIFEST-0.1.1.md`
- current stage: `SPEC-017` implementation conformance
- implementation authority: `RELEASED_FOR_IMPLEMENTATION`
- pilot readiness: `NOT_READY`
- production readiness: `NOT_READY`

## Environment

`.env.example` maps the released [SUAS-specs `ENVIRONMENT.md`](https://github.com/scrimshawlife-ctrl/SUAS-specs/blob/main/ENVIRONMENT.md) contract.

Logical classes are `LOCAL`, `TEST`, `STAGING`, `PRODUCTION`. LOCAL/TEST/STAGING must not use real veteran data or real external support effects. Invalid environment/feature combinations must fail closed at startup.

## Release boundary

v0.1.1 authorizes implementation but not production operation.

Production-unavailable until later decision/evidence closure:

- production infrastructure and real veteran data/live pilot;
- production Support Signal scoring;
- official safety/crisis copy;
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