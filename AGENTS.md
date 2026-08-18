# AGENTS.md — SUAS implementation rules

Released stack: `0.1.1`  
Manifest: `RELEASE_MANIFEST-0.1.1.md` in `SUAS-specs`  
Authority: `RELEASED_FOR_IMPLEMENTATION`  
Stage: `SPEC-017`

Read `FABLE_HANDOFF.md` and `CONTEXT.md` first.

## Rules

1. `SUAS-specs` is canonical; draft/unreleased future changes are not authority.
2. Every implementation PR cites released spec file/section, stack version, manifest, and test/readiness contract.
3. Semantic gaps return to specs; do not invent product/domain behavior.
4. Follow released `ENVIRONMENT.md`; LOCAL/TEST/STAGING cannot use real veteran data or real external support effects.
5. Keep canonical terms exact: Support Case, Service Request, Referral, Fulfillment Attempt, Fulfillment, Follow-Up, Settlement, Consent Grant, Support Signal, etc.
6. Provider SDKs/payloads/statuses/webhook schemas stay in adapters. Domain modules use SUAS-owned capability ports.
7. Manual/fake coordination remains valid where real providers are unavailable.
8. Correctness-critical state is shared/persistent, not process-local.
9. Async handlers are replay-safe; at-least-once delivery must not duplicate observable business effects.
10. External mutations use stable idempotency identity; ambiguous outcomes reconcile before risky retry.
11. Tenant isolation covers API, DB, jobs, caches, adapters, reports, and admin.
12. Provider disclosure uses use-time authorization/consent and minimum-necessary projection.
13. Preserve released MVP visual/interaction behavior and truthful degraded/no-availability states.
14. No automated emergency dispatch, diagnosis, suicide prediction, or safety-critical generative behavior.
15. Do not add vendor, capacity, SLO, recovery, legal/compliance, partner, staffing, scoring, crisis-copy, or reporting-threshold assumptions that remain unavailable.
16. Build provenance must expose app commit/version, spec version, manifest, environment, and schema/migration version where applicable.
17. Never commit secrets, `.env`, real contact details, provider credentials, or production data.
18. SPEC-018 evidence is required before any production readiness claim.

## Per-slice record

Each SPEC-017 slice records released spec references, files/packages changed, tests/evidence, migration/environment changes, unavailable/manual-only boundaries touched, and any gap returned to specs.

No code/config change may silently upgrade an `UNAVAILABLE`, `MANUAL_ONLY`, `INFORMATION_ONLY`, or `FUTURE` feature to production-operational behavior.