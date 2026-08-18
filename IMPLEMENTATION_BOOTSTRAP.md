# IMPLEMENTATION_BOOTSTRAP.md — Released v0.1.0 handoff

**Status:** `ACTIVE`  
**Released specification:** `0.1.0`  
**Implementation authority:** `RELEASED_FOR_IMPLEMENTATION`  
**Current stage:** `SPEC-017`

## Canonical source

- Specs release merge: `25babc95538a9492cc4c6c26c3f188b4873e2110`
- Release manifest: `RELEASE_MANIFEST-0.1.0.md`
- Release decision ledger: `RELEASE_DECISIONS-0.1.0.md`

## Implementation sequence

Proceed in this order unless a released spec change explicitly changes the dependency graph:

1. Read the v0.1.0 release manifest and feature-availability boundaries.
2. Create a change map that maps every implementation package/file to released spec sections.
3. Scaffold the modular monolith without provider brands in domain modules.
4. Establish PostgreSQL logical schema/migration/test harness for released entities and constraints.
5. Implement persistent command idempotency and replay-safe event publication before externally consequential workflows.
6. Implement auth/session revocation, tenant isolation, and authorization foundations.
7. Implement Consent, Case, Service Request, Follow-Up, Settlement, Notification, and Fulfillment state machines with critical suites.
8. Implement provider capability ports plus fake/manual adapters before any real provider adapter.
9. Implement Check-In and Support Signal engine interface; production scoring remains unavailable until D-011 closes.
10. Implement MVP-reference veteran/responder/admin surfaces with deterministic visual fixtures and truthful degraded states.
11. Implement durable worker abstractions and test/fake execution paths without selecting an unapproved production queue vendor.
12. Add scale/resilience observability and failure-test harnesses.
13. Run SPEC-017 conformance continuously and return every contract gap to `SUAS-specs`.

## First implementation slices

- Foundation: project/tooling, config validation, DB/migration/test harness
- Identity/tenancy: User, Organization, Membership, Session, MFA boundaries
- Event/idempotency kernel
- Consent/privacy authorization kernel
- Case/Service Request state machines and responder claim queue
- Follow-Up and multi-cycle Settlement semantics
- Resource/Referral/FulfillmentAttempt/Fulfillment domain
- Notification logical-send jobs and fake channel adapters
- Provider Router + Manual/Fake adapters
- Check-In + Support Signal interface with unreleased test fixtures only
- Veteran/responder/admin UI against MVP_REFERENCE

## Production-unavailable boundaries

Do not make these operational merely because implementation can be written:

- production cloud/database/auth/SMS/email/queue vendors;
- real external transportation/room/food/peer vendors;
- real veteran data or live pilot operation;
- production Support Signal scoring weights;
- official safety/crisis copy;
- production workload/SLO values;
- RTO/RPO;
- legal/HIPAA classification or compliance claims;
- pilot partner/staffing facts;
- small/sensitive aggregate-reporting threshold/policy.

Manual/fake/test implementations are allowed only where the release manifest permits them.

## Definition of SPEC-017 start

SPEC-017 begins when implementation work cites the released v0.1.0 artifacts and records conformance evidence per slice. It completes only when the implementation has been compared against the released cut and all identified gaps have either been fixed or returned to specs.

SPEC-017 completion still does not authorize production; SPEC-018 remains the go/no-go stage.
