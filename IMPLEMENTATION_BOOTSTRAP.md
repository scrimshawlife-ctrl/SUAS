# IMPLEMENTATION_BOOTSTRAP.md — Pre-release handoff

**Status:** planning only  
**Implementation authority:** `NOT_YET_RELEASED`

## Purpose

Prepare the implementation repository so work can begin immediately after the first released specification cut without allowing draft specs to become hidden product authority.

## Current canonical source

The latest production-hardening preflight is merged into `scrimshawlife-ctrl/SUAS-specs/main` at:

`96631dc1cf09768a8fe5550e620e3e1bde5377c9`

That commit is provenance for the current design discussion only. It remains `draft` until the owner completes the staged acceptance path and SPEC-016 releases a named contract.

## Release-triggered bootstrap sequence

When SPEC-016 becomes `RELEASED_FOR_IMPLEMENTATION`, implementation should proceed in this order:

1. Read the SPEC-016 release manifest and pinned decisions/artifact versions.
2. Create an implementation change map that maps every first-slice file/package to released spec sections.
3. Scaffold the modular monolith without embedding provider brands into domain modules.
4. Establish shared PostgreSQL logical schema/migrations for released entities and constraints.
5. Implement persistent command idempotency and replay-safe event publication before externally consequential workflows.
6. Implement auth/session revocation and tenant isolation foundations.
7. Implement Case, Service Request, Consent, Follow-Up, Settlement, Notification, and Fulfillment state machines with their critical suites.
8. Implement provider capability ports plus fake/manual adapters before real vendor adapters.
9. Implement MVP-reference veteran/responder/admin surfaces with deterministic visual fixtures.
10. Add durable workers for released asynchronous workloads.
11. Add scale/resilience observability and failure drills.
12. Run SPEC-017 implementation conformance against the released manifest before claiming completion.

## First implementation slices after release

The expected order is:

- Foundation: project/tooling, config validation, database connection, migration harness, test harness
- Identity/tenancy: User, Organization, Membership, Session, MFA boundaries
- Event/idempotency kernel: command dedupe, event envelope, outbox-equivalent publication
- Consent/privacy authorization kernel
- Case/Service Request state machines and responder claim queue
- Follow-Up and Settlement cycle semantics
- Resource/Referral/FulfillmentAttempt/Fulfillment domain
- Notification jobs and channel adapters
- Provider Router + Manual/Fake adapters
- Check-In + Support Signal engine once released scoring fixtures exist
- Veteran/responder/admin UI against the released MVP reference
- External provider adapters enabled only by released decisions

## Hard blocks until release

Do not guess or hard-code:

- cloud/database/auth/SMS/email/queue vendors;
- transportation, room/shelter, food, or external peer-support vendors;
- Support Signal scoring weights;
- approved safety copy;
- production capacity or SLO values;
- RTO/RPO;
- legal/HIPAA classification;
- pilot partner/staffing facts;
- reporting privacy threshold/policy.

## Definition of implementation start

Implementation begins only when a released SPEC-016 manifest identifies:

- released stack/version;
- source commit;
- applicable artifact versions;
- decision ledger;
- enabled/manual-only/unavailable feature states;
- implementation authority = `RELEASED_FOR_IMPLEMENTATION`.
