# IMPLEMENTATION_BOOTSTRAP.md — Released v0.1.4 handoff

**Status:** `ACTIVE`  
**Released specification:** `0.1.4`  
**Implementation authority:** `RELEASED_FOR_IMPLEMENTATION`  
**Current stage:** `SPEC-017`

## Canonical source

- Specs release merge: `b4baad3fc39af36e22df9fd3bc3f523392f19a2e`
- Release manifest: `RELEASE_MANIFEST-0.1.4.md`
- Release decision ledger: `RELEASE_DECISIONS-0.1.3.md` (D-018); `RELEASE_DECISIONS-0.1.2.md` (D-017); `RELEASE_DECISIONS-0.1.0.md` otherwise
- Handoff: `HANDOFF.md`
- Environment contract: `ENVIRONMENT.md`

## Implementation sequence

1. Read `FABLE_HANDOFF.md`, `CONTEXT.md`, AGENTS, and SPEC017_PLAN here.
2. Read the released manifest, HANDOFF, ENVIRONMENT, STATUS, PRODUCT, GLOSSARY in specs.
3. Create a change map from every implementation package/file to released spec sections.
4. Execute SPEC-017 slices in order, beginning with Foundation.
5. Establish typed configuration/startup validation, build provenance, schema/migration/test harness before product workflows.
6. Implement persistent idempotency/replay-safe events before externally consequential flows.
7. Implement identity/tenancy/consent/coordination foundations before UI or real integrations.
8. Implement Manual/Fake provider and notification seams before any real provider integration.
9. Continuously run conformance tests and return semantic gaps to `SUAS-specs`.

## Hard boundaries

Do not make operational through code/config defaults:

- production infrastructure or real external effects;
- real veteran data/live pilot;
- production Support Signal scoring;
- official safety/crisis copy;
- real external transportation/shelter/food/peer providers;
- production workload/SLO/RTO/RPO values;
- legal/compliance claims;
- sensitive aggregate reporting.

LOCAL/TEST/STAGING are synthetic-only and real-external-effect forbidden under `ENVIRONMENT.md`.

## Definition of SPEC-017 start

Implementation begins with Slice 1 against v0.1.4 and records conformance evidence per slice. SPEC-017 completion still does not authorize production; SPEC-018 remains the go/no-go stage.
