# SPEC017_PLAN.md — Implementation conformance plan for SUAS v0.1.1

**Released spec:** `0.1.1`  
**Status:** `IN_PROGRESS`  
**Implementation repository:** `scrimshawlife-ctrl/SUAS`  
**Canonical specs:** `scrimshawlife-ctrl/SUAS-specs`

## Progress

| Slice                                   | Status        | Record                                                                   |
| --------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| 1 — Foundation                          | `IMPLEMENTED` | [docs/slices/SLICE_01_FOUNDATION.md](docs/slices/SLICE_01_FOUNDATION.md) |
| 2 — Event/idempotency kernel            | `NOT_STARTED` | —                                                                        |
| 3 — Identity / tenancy / authorization  | `NOT_STARTED` | —                                                                        |
| 4 — Consent and privacy kernel          | `NOT_STARTED` | —                                                                        |
| 5 — Coordination kernel                 | `NOT_STARTED` | —                                                                        |
| 6 — Follow-Up / Settlement              | `NOT_STARTED` | —                                                                        |
| 7 — Resources / fulfillment             | `NOT_STARTED` | —                                                                        |
| 8 — Notifications                       | `NOT_STARTED` | —                                                                        |
| 9 — Check-In / Support Signal interface | `NOT_STARTED` | —                                                                        |
| 10 — MVP-reference UI                   | `NOT_STARTED` | —                                                                        |
| 11 — Scale / resilience harness         | `NOT_STARTED` | —                                                                        |

Slice 1 returned seven semantic/mechanism questions to specs; see §9 of its record.
No readiness gate has advanced, and production remains blocked until SPEC-018.

## Objective

Build SUAS against the released v0.1.1 contracts and continuously prove conformance without upgrading any production-unavailable release feature by implication.

## Slice 1 — Foundation

Implement project/tooling structure, lockfiles, deterministic install/build/lint/typecheck/test commands, typed configuration validation, `.env.example`, build provenance/version surface, PostgreSQL migration/schema-version harness, test harness, synthetic-fixture boundary, CI skeleton, and durable-job abstraction seam.

Must cite: `HANDOFF.md`, `ENVIRONMENT.md`, ARCHITECTURE, DATA_MODEL, VERSIONING, RELEASE_MANIFEST.

No real external effects.

## Slice 2 — Event/idempotency kernel

Persistent command idempotency, event envelope, replay-safe publication/outbox-equivalent semantics, correlation/causation, duplicate-delivery tests.

## Slice 3 — Identity / tenancy / authorization

User, Organization, Membership, passwordless auth abstraction, shared session revocation semantics, privileged MFA boundary, tenant isolation, role + tenant + row + consent authorization. Production auth/email/SMS providers remain unavailable; use fakes/test seams.

## Slice 4 — Consent and privacy kernel

Consent Grants, use-time evaluation, revocation, minimum-necessary projection, Trusted Circle visibility, audit paths.

## Slice 5 — Coordination kernel

Support Case, CaseAssignment, Service Request, responder one-winner claim/reassignment, Contact Attempt, explicit transition commands.

## Slice 6 — Follow-Up / Settlement

Stale-job schedule identity, blocking/carry-forward, multi-cycle Settlement history, idempotent resolve, reopen behavior.

## Slice 7 — Resources / fulfillment

Resource, Referral, ServiceProvider, ProviderAdapterConfiguration, FulfillmentAttempt, ServiceFulfillment, Provider Router, Manual/Fake adapters. Real providers remain unavailable/manual-only.

## Slice 8 — Notifications

Logical-send dedupe, durable-job abstraction, consent re-check, fake email/SMS, IN_APP path.

## Slice 9 — Check-In / Support Signal interface

Questionnaire/Check-In/versioning and deterministic engine interface. Use clearly labeled unreleased fixtures only; production scoring remains unavailable.

## Slice 10 — MVP-reference UI

Veteran, responder/QRF, resource, chat, admin surfaces with truthful pending/no-availability states, WCAG target, deterministic visual fixtures.

## Slice 11 — Scale / resilience harness

Horizontal-instance, duplicate delivery, stale-work, concurrency, provider-timeout, queue-backlog, event-recovery, session-revoke, migration/restore simulation. No production numeric SLO/RTO/RPO is invented.

## Per-slice definition of done

Each slice includes:

- released spec references;
- changed files/packages;
- unit/domain/integration/E2E evidence as applicable;
- migration/data invariants;
- environment/config changes and `.env.example` updates;
- release-manifest availability-boundary verification;
- security/privacy/failure/idempotency notes where relevant;
- unresolved semantic gaps returned to `SUAS-specs`;
- no readiness claim beyond evidence.

## SPEC-017 completion

SPEC-017 completes only when the built implementation is audited against the entire released v0.1.1 cut and all material gaps are fixed or returned to specs. SPEC-018 remains required before any real pilot or production operation.
