# SUAS

Shut Up and Serve (SUAS) is the implementation repository for the consent-governed veteran support coordination platform specified in [`scrimshawlife-ctrl/SUAS-specs`](https://github.com/scrimshawlife-ctrl/SUAS-specs).

## Current implementation status

- Application code: not yet started
- Released specification: `0.1.0`
- Specification lifecycle: `released`
- Implementation authority: `RELEASED_FOR_IMPLEMENTATION`
- Current stage: `SPEC-017` implementation conformance
- Pilot readiness: `NOT_READY`
- Production readiness: `NOT_READY`

Canonical release source:

- `SUAS-specs/main` release merge: `25babc95538a9492cc4c6c26c3f188b4873e2110`
- Release manifest: `RELEASE_MANIFEST-0.1.0.md`
- Release decision ledger: `RELEASE_DECISIONS-0.1.0.md`

## Release boundary

The v0.1.0 release authorizes implementation but **not** production operation.

Production-unavailable until later decisions/evidence close:

- production hosting/auth/email/SMS/database/job infrastructure;
- real veteran data and live pilot operation;
- production Support Signal scoring;
- official safety/crisis copy;
- real transportation/shelter/food/external peer providers;
- production workload/SLO/RTO/RPO targets;
- small/sensitive aggregate reporting.

Manual/fake/test adapters are valid where the release manifest permits them.

## Governing rules

1. `SUAS-specs` is canonical. This repository implements released contracts; it does not redefine them.
2. Every implementation PR cites released spec file, section, stack version, lifecycle, and release manifest.
3. If code needs an unstated rule, return the gap to `SUAS-specs` rather than inventing behavior here.
4. Preserve the released MVP visual/interaction model, including action-first veteran and responder/QRF flows and truthful degraded/no-availability states.
5. Keep rides, temporary shelter/rooms, food, and peer-support integrations provider-neutral. Vendor SDKs stay behind adapters.
6. Preserve stateless horizontal application semantics, durable async-work contracts, command/provider idempotency, tenant isolation, and replay-safe events.
7. No automated emergency dispatch, diagnosis, suicidality determination, or safety-critical generative AI.
8. Do not claim HIPAA compliance or production readiness from release alone.

See [AGENTS.md](AGENTS.md), [IMPLEMENTATION_BOOTSTRAP.md](IMPLEMENTATION_BOOTSTRAP.md), and [SPEC017_PLAN.md](SPEC017_PLAN.md).
