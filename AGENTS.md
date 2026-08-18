# AGENTS.md — SUAS implementation rules

This repository implements released contracts from `scrimshawlife-ctrl/SUAS-specs`.

## Authority

- `SUAS-specs` is canonical.
- Draft or accepted-but-unreleased specs are design inputs, not shipping authority.
- A released SPEC-016 manifest defines what this repository may implement as canonical product behavior.
- Undocumented implementation behavior is not canonical.

## Required implementation discipline

1. Every implementation PR cites the released spec file, section, stack version, lifecycle, and relevant artifact versions.
2. Gaps return to `SUAS-specs`; do not invent product/domain rules in code.
3. Preserve canonical names for Support Case, Service Request, Referral, Fulfillment Attempt, Fulfillment, Follow-Up, Settlement, Consent Grant, Support Signal, and other released terms.
4. Provider-specific SDKs, payloads, statuses, and webhook schemas stay inside adapters. Domain modules use SUAS-owned capability ports.
5. Manual coordination remains a valid fulfillment path when released specs require it.
6. Correctness-critical state is not process-local. Sessions, idempotency, jobs, locks/claims, consent, provider attempts, and workflow state must survive horizontal application scaling as released.
7. Production-critical asynchronous work is durable and replay-safe. At-least-once delivery must not duplicate observable business effects.
8. External mutations use stable idempotency identities. Ambiguous provider outcomes reconcile before risky retry.
9. Tenant isolation applies across API, database, jobs, caches, adapters, reports, and admin paths.
10. Provider disclosure uses use-time authorization/consent basis and minimum-necessary projection.
11. Preserve the released MVP visual/interaction reference; do not silently redesign the product into a generic dashboard.
12. No automated emergency dispatch, diagnosis, suicide prediction, or safety-critical generative model behavior.
13. Do not add vendor, capacity, SLO, recovery, legal/compliance, partner, or staffing assumptions that are still `DECISION_PENDING` in the released manifest.

## Pre-release state

Until SPEC-016 is released:

- application scaffolding that would encode product/domain decisions is blocked;
- production provider integrations are blocked;
- schema migrations that imply unreleased domain semantics are blocked;
- visual implementation is blocked as canonical product work;
- documentation, tooling plans, and non-product repo hygiene may proceed if they do not create hidden product authority.
