# SPEC_GAP_PROPOSALS.md — Bucket I spec gap proposals (owner-accepted; encoded as 0.1.4 patch)

**Status:** `OWNER_ACCEPTED` — encoded into a proposed `SUAS-specs` **0.1.4** conformance-codification release.
**Delivery:** `docs/spec-patches/SUAS-specs-0.1.4-conformance-codification.patch` (git `am`-applyable, 4 commits, verified to apply cleanly on `SUAS-specs@main` `33c6f19`). The Cloud Agent token is **read-only** on `scrimshawlife-ctrl/SUAS-specs`, so the patch could not be pushed as a branch/PR; the owner applies it and the merge/tag ratifies the 0.1.4 release (`SUAS-specs` lifecycle is owner-controlled).
**Released spec stack:** `0.1.3` today → `0.1.4` once the patch is ratified (`RELEASE_MANIFEST-0.1.4.md` in the patch).
**Implementation status:** P-12 and P-13 are already implemented, tested, and merged in this repo (PRs #32, #34). The build pin stays at `0.1.3` and MUST NOT bump to `0.1.4` until the `SUAS-specs` 0.1.4 release is actually cut (rule 1: unreleased spec is not authority).
**Companion:** `docs/SPEC_DESIGN_GAPS.md` (gap IDs referenced below)
**Readiness:** `NOT_READY` (unchanged)

> The sections below are the source proposals. All P-1..P-23 are carried verbatim
> in the attached 0.1.4 patch; the `**Owner confirm:**` caveats were accepted by
> the owner ("all gap proposals accepted and authorized") and codified as the
> implementation encodes them. The "Not proposed here" list at the end remains
> owner-only and is explicitly **out** of the 0.1.4 patch.

## What this is, and what it is not

This document proposes adoptable specification language for the **Bucket I**
(editorial / underspecified) gaps catalogued in `docs/SPEC_DESIGN_GAPS.md`, for
**owner review and possible ratification into `scrimshawlife-ctrl/SUAS-specs`**.

Every proposal here does exactly one of:

- **(a)** codifies a mechanism the implementation already runs and tests (cited by
  file + slice record), or
- **(b)** is a pure editorial clarification (authority labeling, a mapping table,
  or an enumeration already closed in code).

It therefore **invents no new product/domain behavior** (`AGENTS.md` rules 1, 3).
It **makes and closes no owner decision** (rules 14, 15): Bucket II (`D-0xx`) and
Bucket III (contradictions) are deliberately **out of scope** and listed at the
end as "not proposed here." Nothing here is authority until the owner accepts it
into a released `SUAS-specs` cut; this file does not change runtime behavior.

Each proposal gives: **Target** (spec file the language belongs in), **Proposal**
(the rule/enumeration to adopt), and **Basis** (the implemented + tested source,
and the released clause that requires the missing rule).

---

## A. Editorial / authority clarifications

### P-1 (G-III-4) — Reconcile per-file lifecycle headers with the manifest

- **Target:** every spec file header; `VERSIONING.md`.
- **Proposal:** Make each file's header state its authority **as of the current
  manifest** (e.g. `released via RELEASE_MANIFEST-0.1.3.md`), or add one line to
  `VERSIONING.md` stating that the manifest's released-artifact set overrides any
  stale inline `draft` / `dependency-blocked` header. Re-issue the SPEC-0xx
  acceptance records' `Stack version` from `0.1.0` to the current stack.
- **Basis:** `RELEASE_MANIFEST-0.1.3.md` released-artifact set vs `draft` headers
  still on `DOMAIN_MODEL.md`, `DATA_MODEL.md`, `EVENT_MODEL.md`, `CASES.md`,
  `DISPATCH.md`, `FULFILLMENT.md`, `RESILIENCE.md`, `OPERATIONS.md`, `PRODUCT.md`,
  `GLOSSARY.md`. Pure editorial; no behavior.

### P-2 (G-I-3) — Single name for the Follow-Up coordination counter

- **Target:** `FOLLOWUP.md` §4.
- **Proposal:** Rename `FollowUp.retry_count` to `coordination_attempt_count` to
  match the released logical schema.
- **Basis:** `DATA_MODEL.md` §6 already names it `coordination_attempt_count`;
  `src/settlement/follow-ups.ts` implements that column. Naming only.

### P-3 (G-I-39) — Record the version-identity set and schema-version mechanism

- **Target:** `VERSIONING.md` §3; `ENVIRONMENT.md` §9.
- **Proposal:** Add a table of the five parallel identities (spec stack, app
  version, API selector `v0`, event schema `0.1.0`, DB schema version) and state
  the DB schema-version mechanism: a monotonic integer = highest applied numbered
  migration, recorded in a runner-owned bookkeeping table, with the build's
  required value stated explicitly (not inferred from app version).
- **Basis:** `src/db/schema-version.ts`, `src/db/migrator.ts`,
  `migrations/0001_baseline.sql` (`suas_schema_metadata`,
  `suas_schema_migrations`); Slice 1 §10 item 6. Documents existing mechanism.

---

## B. Vocabulary alignment

### P-4 (G-I-1) — Canonical capability ↔ category ↔ port mapping

- **Target:** `ARCHITECTURE.md` §11 / `FULFILLMENT.md` §4 (add a mapping table);
  referenced from `DISPATCH.md` §7 and `APIS.md`.
- **Proposal:** Publish one table mapping each MVP category
  (`FOOD`, `TRANSPORTATION`, `SHELTER`, `PEER_SUPPORT`) to its capability id, its
  provider-neutral port name, and the value stored in
  `FulfillmentAttempt.capability`, and state that persistence/routing/consent use
  the category value as the canonical key.
- **Basis:** `src/fulfillment/port.ts` (`capabilityForCategory`,
  `CAPABILITY_FOR_CATEGORY`) already holds this mapping; Slice 7 §10 item 2. No
  new names — just publishes the equivalence the four schemes already imply.

### P-5 (G-I-2) — State how the three "mode" concepts relate

- **Target:** `PROVIDER_INTEGRATIONS.md` §3 (cross-linked from `FULFILLMENT.md`,
  `RESOURCES.md`).
- **Proposal:** State explicitly that `Resource.integration_modes` (catalog
  capability set), `FulfillmentAttempt.integration_mode` (the mode of one attempt),
  and `ProviderOffer.fulfillment_mode` are independent concepts drawn from the
  released integration-mode enum, and that no subset/implication relationship
  exists between them.
- **Basis:** editorial reconciliation of `FULFILLMENT.md`, `RESOURCES.md`,
  `PROVIDER_INTEGRATIONS.md`. Clarification only.

### P-6 (G-I-5) — Required-adapter naming and registry

- **Target:** `PROVIDER_INTEGRATIONS.md` §4.
- **Proposal:** State that each capability has a mandatory `Manual<Capability>Adapter`
  and that adapters are addressed through a per-capability registry keyed by
  capability + adapter id; use the capability-specific names consistently
  (`ManualShelterAdapter`, etc.) rather than a bare "Manual Adapter".
- **Basis:** `src/fulfillment/registry.ts`, `src/fulfillment/adapters.ts`.
  Documents the registry the implementation already uses.

---

## C. State machines (codify the implemented deterministic tables)

### P-7 (G-I-9, G-I-10) — Close the Service Request transition, cancel, and expiry sets

- **Target:** `DISPATCH.md` §4.
- **Proposal:** Adopt the enumerated edge set the implementation encodes, in
  particular: cancellation is allowed only from
  `{CREATED, SUBMITTED, TRIAGED, MATCHING, ASSIGNED, ACCEPTED, IN_PROGRESS}`;
  expiry only from `{CREATED, SUBMITTED, TRIAGED, MATCHING, ASSIGNED}`; escalation
  only from `{TRIAGED, MATCHING, ASSIGNED, ACCEPTED, IN_PROGRESS}`; and
  `RETURN_FROM_ESCALATION` has two documented targets (`TRIAGED`, `MATCHING`) with
  the caller naming the intended one.
- **Basis:** `src/coordination/request-transitions.ts`
  (`SERVICE_REQUEST_TRANSITIONS`), exercised by `tests/unit/coordination-transitions.test.ts`.
  Replaces prose ("allowed non-terminal states") with the closed list already tested.

### P-8 (G-I-13) — Define "blocking" Service Request for Case resolution

- **Target:** `CASES.md` §7.
- **Proposal:** A Service Request blocks Case resolution iff its status is not one
  of the terminal statuses `{CLOSED, CANCELLED, EXPIRED, UNFULFILLABLE}`.
- **Basis:** `src/settlement/resolve.ts` (`TERMINAL_REQUEST_STATUSES`); Slice 5
  §10 item 1. **Owner confirm:** whether `CONFIRMED` (non-terminal here) should
  also count as settled.

### P-9 (G-I-14) — Name the `ASSIGNED → ACTIVE` command

- **Target:** `CASES.md` §4.
- **Proposal:** Add `ACTIVATE` to the case command list as the explicit-only
  transition `ASSIGNED → ACTIVE`; no work action implicitly activates a Case.
- **Basis:** `src/coordination/case-transitions.ts` (`CASE_COMMANDS` includes
  `ACTIVATE`); Slice 5 §10 item 2.

### P-10 (G-I-11) — Follow-Up `RESCHEDULED` / `OVERDUE` handling

- **Target:** `FOLLOWUP.md` §6, §9.
- **Proposal:** State that reschedule returns status to `SCHEDULED` with a bumped
  `schedule_version` (the `RESCHEDULED` value is retained for schema fidelity but
  is not a resting status, so a due-sweep selecting `SCHEDULED` still finds it),
  and that `OVERDUE` is recorded via Audit Event only (no Domain Event added
  without catalog reconciliation).
- **Basis:** `src/settlement/follow-ups.ts` (`rescheduleFollowUp`,
  `markFollowUpOverdue`); Slice 6 §10 items 1, 3. **Owner confirm:** the
  `RESCHEDULED`-as-non-resting reading.

### P-11 (G-I-12) — Case reopen source

- **Target:** `CASES.md` §4.2.
- **Proposal:** State that the reopen edge is `CLOSED → OPEN` only (a `RESOLVED`
  Case is closed before it can be reopened into a new resolution cycle).
- **Basis:** `src/coordination/case-transitions.ts` reopen edge. **Owner confirm.**

---

## D. Data-model joins and field shapes (additive)

### P-12 (G-I-16) — Subject reference on notifications

- **Target:** `DATA_MODEL.md` §9; `NOTIFICATIONS.md` §3.
- **Proposal:** Add an optional subject reference (`subject_type` +
  `subject_id`, covering Support Case / Service Request / Referral) to the
  `notifications` row so a delivery can be linked to the workflow entity it was
  sent for. This is what MVP `RESPONDER_NOTIFIED` requires to be truthfully
  reachable.
- **Basis:** Slice 10 §10 item 1; Slice 8 §10 items 3-4 (the implementation
  states this reference is the missing piece and refuses to infer it). Additive
  schema; no behavior change until a policy uses it.

### P-13 (G-I-17) — Structured contact / referral methods

- **Target:** `RESOURCES.md` §2; `REFERRALS.md` §2.
- **Proposal:** Give `contact_method` / `referral_method` a scheme discriminator
  (e.g. `kind` ∈ {phone, email, url, freeform} + value), and give referral
  `destination` a typed `{type, id}` where `type` is an enum over
  {Resource, ServiceProvider, Organization, external}.
- **Basis:** Slice 10 §10 item 2; Slice 7 §10. The implementation renders the raw
  value and offers no direct action precisely because the shape is unspecified.

### P-14 (G-I-18) — Follow-Up `responsible_type` enum and `referral_id`

- **Target:** `DATA_MODEL.md` §6; `FOLLOWUP.md` §3.
- **Proposal:** Enumerate `responsible_type` as `{RESPONDER, VETERAN, ORG_ADMIN,
SYSTEM}`, and document the optional `referral_id` FK on `follow_ups`.
- **Basis:** `src/settlement/follow-ups.ts` (`RESPONSIBLE_TYPES`); Slice 6 §10
  item 4; `REFERRALS.md` links a Follow-Up when a check-back is needed.

### P-15 (G-I-36) — SUAS-admin global-role representation

- **Target:** `DATA_MODEL.md` §2; `AUTH.md` §6.
- **Proposal:** Represent the global SUAS-admin role as an auditable grant record
  (grant id, user id, granted_by, revoked_by, timestamps, status) rather than a
  boolean on the user row, so "who made this person a SUAS admin, and when" is
  answerable.
- **Basis:** `src/identity/admins.ts` (`suas_admin_grants`); Slice 3 §10 item 2.

### P-16 (G-I-21, G-I-22) — Assignment projection and reconciliation fields

- **Target:** `DISPATCH.md` §6; `DATA_MODEL.md` §7.
- **Proposal:** State the current-assignment projection rule (the single row with
  `status = ACTIVE`, one active assignment per Case), document that a Service
  Request has at most one `ServiceFulfillment` with many `FulfillmentAttempt`s, and
  add the reconciliation sub-state fields `FulfillmentAttempt` needs to carry
  `PROVIDER_UNKNOWN` until reconciled (already required by `RESILIENCE.md`).
- **Basis:** `src/coordination/cases.ts` (`findActiveAssignment`),
  `src/fulfillment/attempts.ts` / `router.ts` (`reconcileAttempt`). Codifies
  implemented behavior; **owner confirm** the cardinality reading.

---

## E. Consent mechanics (close the enumerations already closed in code)

### P-17 (G-I-23) — Closed `consent_basis` / system-basis registry

- **Target:** `CONSENT.md` §3.5-§3.6.
- **Proposal:** Enumerate the documented system bases as exactly
  `{SYSTEM_INTERNAL_PROCESSING, RESPONDER_CASE_ASSIGNMENT}` and state that any
  other basis denies; `consent_basis` on an access Audit Event is one of these or
  `CONSENT_GRANT`.
- **Basis:** `src/consent/vocabulary.ts` (`SYSTEM_BASES`); Slice 4 §10 item 3.
  **Owner confirm:** whether additional bases exist.

### P-18 (G-I-25) — `grantee_id` typing per `grantee_type`

- **Target:** `CONSENT.md` §2.
- **Proposal:** State what `grantee_id` references for each `grantee_type`:
  TRUSTED_CONTACT → trusted-contact id, RESPONDER → user id, ORGANIZATION →
  organization id, SERVICE_PROVIDER → provider/adapter id, SYSTEM → basis code.
- **Basis:** Slice 4 §10 item 2 (the implementation treats `grantee_id` as opaque
  text keyed this way). **Owner confirm:** the trusted-contact keying.

### P-19 (G-I-27) — Close the permission/scope pairing

- **Target:** `CONSENT.md` §2.1.
- **Proposal:** Publish the pairing as a closed table and reject unlisted pairs:
  `can_receive` → `{YELLOW, ORANGE, RED}`; `can_view` →
  `{support_signal, checkin_answers, current_requests, location}`; `can_share` →
  `{service_request_fulfillment}`.
- **Basis:** `src/consent/vocabulary.ts` (`PERMITTED_SCOPES`,
  `assertPermissionScope`). Turns the "e.g." examples into the closed set already
  enforced.

### P-20 (G-I-26) — Purpose-matching mechanics (interim)

- **Target:** `CONSENT.md` §3.4.
- **Proposal:** State the interim deterministic rule: an evaluation matches on
  `permission` + `scope` + grantee tuple; `purpose` is recorded on the grant, the
  ConsentEvent, and the Audit Event but is **not** mechanically compared until a
  released purpose vocabulary exists.
- **Basis:** `src/consent/evaluate.ts`, `grants.ts`; Slice 4 §10 item 5. **Owner
  confirm:** a released purpose vocabulary would make §3.4 enforceable (that
  vocabulary itself is an owner decision, not proposed here).

---

## F. Support Signal (non-threshold) and effective-signal selection

### P-21 (G-I-24) — Deterministic effective-signal selection rule

- **Target:** `SUPPORT_SIGNALS.md` §7 (reconciled into `DATA_MODEL.md` §4).
- **Proposal:** Adopt the deterministic, non-insertion-order rule: the effective
  signal is the most recent by `computed_at`, ties broken by `support_signal_id`
  descending, with an override superseding the signal it overrides.
- **Basis:** `src/signals/*` (implemented + tested); Slice 9 §10 item 2.
  Independent of D-011 thresholds — this is selection, not scoring. **Owner
  confirm:** behavior when two overrides target the same signal.

### P-22 (G-I-28, partial) — Model `priority_signal_level` on the Case

- **Target:** `CASES.md` §3; `DATA_MODEL.md` §6.
- **Proposal:** Document the `priority_signal_level` column on `support_cases`
  (nullable; values track the effective Support Signal level) as a queue-filter
  fact.
- **Basis:** the column exists and is filterable in the implementation; Slice 5
  §10 item 4. **Not proposed here:** the _action/command_ that writes it from a
  signal change — that connecting rule is undefined and is an owner clarification
  (see "not proposed" list).

---

## G. MVP UI ↔ domain mapping

### P-23 (G-I-29) — QRF label → canonical fact mapping table

- **Target:** `MVP_REFERENCE.md` §7.2.
- **Proposal:** Publish the table mapping each QRF UI label
  (`REQUESTED`, `SEARCHING`, `RESPONDER_NOTIFIED`, …) to the Case/Service
  Request/notification fact that backs it, including that `RESPONDER_NOTIFIED`
  requires a recorded delivery linked to the request (depends on P-12) and that
  absent that link the surface rests on `SEARCHING`.
- **Basis:** `src/ui/qrf.ts`, `src/ui/read.ts`; Slice 10 §10 item 1 and its tests.
  Documents the truthful mapping the implementation already renders.

---

## Not proposed here (require an owner decision — see `docs/SPEC_DESIGN_GAPS.md`)

These Bucket I items cannot be closed without a genuine product/policy choice, so
this DRAFT deliberately proposes **no** value or rule for them:

- **G-I-6** who declares `PARTIAL` fulfillment and on what evidence.
- **G-I-7** the full `DISPUTED` transition table (actors/exits beyond the implemented dispute edge).
- **G-I-8** the deterministic rule mapping fulfillment `FAILED` to a request outcome.
- **G-I-15** whether the un-evented request transitions gain Domain Events (catalog reconciliation) or stay audit-only.
- **G-I-19** the structured shape of Settlement summaries.
- **G-I-20** category-specific "required details" for Service Request submit.
- **G-I-28 (action)** the signal-driven case open/update command.
- **G-I-30 / G-I-31 / G-I-32 / G-I-33** responder on-duty store, chat/thread domain, dashboard metric definitions, Quick Resource Share contract.
- **G-I-34** auth timing constants and rate-limit bounds (`INFERRED` today; values are owner-owned).
- **G-I-35** tenant resolution at sign-in.
- **G-I-37** notification template-rendering contract and policy vocabulary.
- **G-I-38** consent-template publication surface as a released admin command (the mechanism exists in code; exposing/gating it in bootstrap + API is a released-surface decision).

All Bucket II (`D-0xx`) and Bucket III (contradictions) items remain owner-only and
are not addressed here.
