# AGENTS.md — SUAS implementation rules

This repository implements released contracts from `scrimshawlife-ctrl/SUAS-specs`.

## Authority

- Released stack: `0.1.0`.
- Release manifest: `RELEASE_MANIFEST-0.1.0.md` in `SUAS-specs`.
- Implementation authority: `RELEASED_FOR_IMPLEMENTATION`.
- Current stage: `SPEC-017` implementation conformance.
- Draft/accepted-but-unreleased future changes are not implementation authority.
- Undocumented implementation behavior is not canonical.

## Required implementation discipline

1. Every implementation PR cites released spec file, section, stack version, lifecycle, and relevant artifact/release-manifest boundary.
2. Gaps return to `SUAS-specs`; do not invent product/domain rules in code.
3. Preserve canonical names for Support Case, Service Request, Referral, Fulfillment Attempt, Fulfillment, Follow-Up, Settlement, Consent Grant, Support Signal, and other released terms.
4. Provider-specific SDKs, payloads, statuses, and webhook schemas stay inside adapters. Domain modules use SUAS-owned capability ports.
5. Manual/fake coordination remains valid where the v0.1.0 manifest marks real providers unavailable/manual-only.
6. Correctness-critical state is not process-local. Sessions, idempotency, jobs, locks/claims, consent, provider attempts, and workflow state must satisfy horizontal-instance semantics.
7. Async handlers are replay-safe and must not duplicate observable business effects under at-least-once delivery.
8. External mutations use stable idempotency identities. Ambiguous provider outcomes reconcile before risky retry.
9. Tenant isolation applies across API, database, jobs, caches, adapters, reports, and admin paths.
10. Provider disclosure uses use-time authorization/consent basis and minimum-necessary projection.
11. Preserve the released MVP visual/interaction reference; do not silently redesign the product into a generic dashboard.
12. No automated emergency dispatch, diagnosis, suicide prediction, or safety-critical generative behavior.
13. Do not add provider, capacity, SLO, recovery, legal/compliance, partner, staffing, scoring, crisis-copy, or reporting-threshold assumptions that remain unavailable in the v0.1.0 manifest.
14. Production readiness cannot be claimed from implementation completion; SPEC-018 evidence is required.

## v0.1.0 production-unavailable surfaces

Implementation may scaffold/test these only within the released boundary; it must not make them operational by default:

- real production hosting/auth/email/SMS/database/job infrastructure;
- real veteran data/live pilot;
- production Support Signal thresholds;
- official safety/crisis copy;
- real external transportation/shelter/food/peer adapters;
- production workload/SLO/RTO/RPO values;
- small/sensitive aggregate reporting.

## SPEC-017 rule

Implementation work should be organized as conformance slices. Each slice records:

- released spec references;
- implementation files changed;
- tests proving the released invariant;
- any release-manifest unavailable/manual-only boundary touched;
- unresolved gap returned to specs, if any.

No code change may silently upgrade a `UNAVAILABLE`, `MANUAL_ONLY`, `INFORMATION_ONLY`, or `FUTURE` release feature to production-operational behavior.
