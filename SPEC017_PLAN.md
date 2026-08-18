# SPEC017_PLAN.md — Implementation conformance plan for SUAS v0.1.0

**Released spec:** `0.1.0`  
**Status:** `READY_TO_BEGIN`  
**Implementation repository:** `scrimshawlife-ctrl/SUAS`  
**Canonical spec repository:** `scrimshawlife-ctrl/SUAS-specs`

## Objective

Build SUAS against the released v0.1.0 contracts and continuously prove conformance without upgrading any production-unavailable release feature by implication.

## Conformance slices

### Slice 1 — Foundation

Implement project/tooling structure, configuration validation, PostgreSQL logical schema/migration harness, test harness, and repository quality checks.

Must cite: ARCHITECTURE, DATA_MODEL, VERSIONING, RELEASE_MANIFEST.

### Slice 2 — Event/idempotency kernel

Implement persistent command idempotency, event envelope, replay-safe publication/outbox-equivalent semantics, correlation/causation, and duplicate-delivery tests.

Must cite: API, EVENT_MODEL, DATA_MODEL, RESILIENCE.

### Slice 3 — Identity / tenancy / authorization

Implement User, Organization, Membership, passwordless auth abstraction, shared session revocation semantics, privileged MFA boundary, tenant isolation, and role + tenant + row + consent authorization.

Production auth/email/SMS providers remain unavailable; use fakes/test adapters only.

### Slice 4 — Consent and privacy kernel

Implement Consent Grants, use-time evaluation, revocation, minimum-necessary projection, Trusted Circle visibility, and audit paths.

### Slice 5 — Coordination kernel

Implement Support Case, CaseAssignment, Service Request, responder one-winner claim/reassignment, Contact Attempt, and explicit transition commands.

### Slice 6 — Follow-Up / Settlement

Implement stale-job schedule identity, blocking/carry-forward semantics, multi-cycle Settlement history, idempotent resolve, and reopen behavior.

### Slice 7 — Resources / fulfillment

Implement Resource, Referral, ServiceProvider, ProviderAdapterConfiguration, FulfillmentAttempt, ServiceFulfillment, Provider Router, and Manual/Fake adapters.

Real external providers remain unavailable/manual-only.

### Slice 8 — Notifications

Implement logical-send dedupe, durable-job abstraction, consent re-check before external send, fake email/SMS adapters, and IN_APP path.

### Slice 9 — Check-In / Support Signal interface

Implement Questionnaire/Check-In/versioning and deterministic Support Signal engine interface. Use clearly labeled unreleased fixtures only; production scoring remains unavailable until D-011 closes.

### Slice 10 — MVP-reference UI

Implement veteran, responder/QRF, resource, chat, and admin surfaces against MVP_REFERENCE with truthful pending/no-availability states, WCAG target, and deterministic visual fixtures.

### Slice 11 — Scale / resilience harness

Add horizontal-instance, duplicate delivery, stale-work, concurrency, provider-timeout, queue-backlog, event-recovery, session-revoke, and restore simulation tests. No production numeric SLO/RTO/RPO is invented.

## Per-slice definition of done

Each slice must provide:

- released spec references;
- changed files/packages;
- unit/domain/integration/E2E evidence as applicable;
- migration/data invariants where applicable;
- release-manifest availability boundary verification;
- unresolved gaps returned to `SUAS-specs`;
- no readiness claim beyond evidence.

## SPEC-017 completion

SPEC-017 completes only when the built implementation is audited against the entire released v0.1.0 cut and all material gaps are resolved or returned to specs.

SPEC-018 is still required before any real pilot or production operation.
