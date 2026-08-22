# SPEC017_PLAN.md — Implementation conformance plan for SUAS v0.1.1

**Released spec:** `0.1.3` (plan opened against `0.1.1`; the runtime now pins `0.1.3` — `src/release/pins.ts`, `RELEASE_MANIFEST-0.1.3.md`)  
**Status:** `IN_PROGRESS`  
**Implementation repository:** `scrimshawlife-ctrl/SUAS`  
**Canonical specs:** `scrimshawlife-ctrl/SUAS-specs`

## Progress

| Slice                                   | Status                         | Record                                                                                         |
| --------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1 — Foundation                          | `IMPLEMENTED`                  | [docs/slices/SLICE_01_FOUNDATION.md](docs/slices/SLICE_01_FOUNDATION.md)                       |
| 2 — Event/idempotency kernel            | `IMPLEMENTED`                  | [docs/slices/SLICE_02_EVENT_IDEMPOTENCY.md](docs/slices/SLICE_02_EVENT_IDEMPOTENCY.md)         |
| 3 — Identity / tenancy / authorization  | `IMPLEMENTED`                  | [docs/slices/SLICE_03_IDENTITY_TENANCY.md](docs/slices/SLICE_03_IDENTITY_TENANCY.md)           |
| 4 — Consent and privacy kernel          | `IMPLEMENTED`                  | [docs/slices/SLICE_04_CONSENT_PRIVACY.md](docs/slices/SLICE_04_CONSENT_PRIVACY.md)             |
| 5 — Coordination kernel                 | `IMPLEMENTED`                  | [docs/slices/SLICE_05_COORDINATION.md](docs/slices/SLICE_05_COORDINATION.md)                   |
| 6 — Follow-Up / Settlement              | `IMPLEMENTED`                  | [docs/slices/SLICE_06_FOLLOWUP_SETTLEMENT.md](docs/slices/SLICE_06_FOLLOWUP_SETTLEMENT.md)     |
| 7 — Resources / fulfillment             | `IMPLEMENTED (manual paths)`   | [docs/slices/SLICE_07_RESOURCES_FULFILLMENT.md](docs/slices/SLICE_07_RESOURCES_FULFILLMENT.md) |
| 8 — Notifications                       | `IMPLEMENTED`                  | [docs/slices/SLICE_08_NOTIFICATIONS.md](docs/slices/SLICE_08_NOTIFICATIONS.md)                 |
| 9 — Check-In / Support Signal interface | `IMPLEMENTED (interface only)` | [docs/slices/SLICE_09_CHECKINS_SIGNALS.md](docs/slices/SLICE_09_CHECKINS_SIGNALS.md)           |
| 10 — MVP-reference UI                   | `IMPLEMENTED`                  | [docs/slices/SLICE_10_MVP_UI.md](docs/slices/SLICE_10_MVP_UI.md)                               |
| 11 — Scale / resilience harness         | `IMPLEMENTED (drills only)`    | [docs/slices/SLICE_11_RESILIENCE_HARNESS.md](docs/slices/SLICE_11_RESILIENCE_HARNESS.md)       |

Slices 1-11 each returned semantic/mechanism questions to specs; see the gaps section
of each record. Each slice has closed the seam the previous one left, except one.
No readiness gate has advanced, and production remains blocked until SPEC-018.

**The load-bearing gap is now D-011.** It blocks all Support Signal scoring: the
engine contract, versioning, determinism, and settlement are built and tested
against a labelled unreleased fixture, and the registry ships empty (Slice 9 §10
item 1). D-012 (approved safety/crisis copy) likewise stays `DECISION_PENDING`, so
the veteran-facing crisis slot renders a labelled placeholder only.

Per-capability provider disclosure is no longer globally absent. v0.1.2 closed
D-017 (Uber selected behind `TransportationPort`) and v0.1.3 closed D-018 (Amadeus
selected behind `TemporaryShelterPort`); both ship as adapter-local realizations
with released field-level disclosure projections, deterministic ranking, provider
health/fallback, and SUAS-side idempotency, and both keep their manual adapters
mandatory (`RELEASE_DECISIONS-0.1.2.md`, `RELEASE_DECISIONS-0.1.3.md`). Amadeus
reservation remains `BLOCKED_BY_PAYMENT_ARCHITECTURE`. D-019 (food) and D-020
(external peer support) stay `DECISION_PENDING`, so those capabilities remain
manual/fake only.

Manual coordination — which the release makes first-class — works end to end, and
every real-external-effect path still fails closed until SPEC-018, proven by test.
No readiness gate has advanced, and production remains blocked until SPEC-018.

## Objective

Build SUAS against the released v0.1.3 contracts and continuously prove conformance without upgrading any production-unavailable release feature by implication.

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

SPEC-017 completes only when the built implementation is audited against the entire released v0.1.3 cut and all material gaps are fixed or returned to specs. SPEC-018 remains required before any real pilot or production operation.
