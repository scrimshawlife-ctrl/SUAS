# SPEC_DESIGN_GAPS.md — SUAS-specs design-gap triage

**Released spec stack:** `0.1.3`
**Release manifest:** `RELEASE_MANIFEST-0.1.3.md`
**Specs merge:** `33c6f1925a8f8eb7ea1f52e77a102b28a249430f`
**Stage:** `SPEC-017` implementation conformance
**Pilot / production readiness:** `NOT_READY` (unchanged by this document)

## Purpose and governance

This is a **triage catalog of design gaps in the canonical `scrimshawlife-ctrl/SUAS-specs`**
stack `0.1.3`, surfaced while implementing SUAS. It exists to satisfy `AGENTS.md`
rule 3 ("semantic gaps return to specs; do not invent product/domain behavior")
by giving those returns a single tracked home.

It is **not** implementation authority and it **does not**:

- redefine any released product/domain rule (`AGENTS.md` rule 1);
- make, propose values for, or close any owner decision (`AGENTS.md` rules 3, 14, 15);
- upgrade any `UNAVAILABLE` / `MANUAL_ONLY` / `INFORMATION_ONLY` / `FUTURE` surface.

Where an entry notes how the implementation currently behaves, that behavior is
the documented mechanism choice already recorded in the relevant slice
conformance record (`docs/slices/`) — repeated here only as a triage pointer, not
asserted as spec authority.

## How to use this document

Each gap has a stable ID and sits in one of three buckets, chosen by **who can
close it**:

| Bucket                             | Meaning                                                                                                                                                                       | Closable by               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **III — Contradiction**            | Two released authorities conflict, or a release contradicts an accepted decision. Resolve first.                                                                              | Owner reconciliation      |
| **I — Editorial / underspecified** | A field/state/rule is named but not defined deterministically, or authorities are mislabeled. No new product decision is required.                                            | Spec patch (no decision)  |
| **II — Owner decision**            | A named or implied `D-0xx` decision, or a value the release explicitly forbids inventing (vendor, capacity, SLO, recovery, legal, scoring, crisis copy, reporting threshold). | Owner decision + evidence |

Suggested triage columns to add per row when this becomes an issue set: `owner`,
`target release`, `status`.

Method and confidence are described at the end. Section numbers are indicative;
the authoritative locus is the named spec file.

---

## Bucket III — Contradictions / tensions (resolve first)

### G-III-1 — Hardcoded 988 / Veterans Crisis Line (draft) vs D-012 crisis copy forbidden (released) — SAFETY-CRITICAL — RESOLVED BY D-012 (pending release)

- **Status:** **Resolved by the owner's D-012 decision**, encoded in canonical spec PR [scrimshawlife-ctrl/SUAS-specs#8](https://github.com/scrimshawlife-ctrl/SUAS-specs/pull/8) (0.1.5): approved crisis copy is released in `SAFETY_COPY.md` with authorized destinations **911** and **988** (call/text; Veterans via 988). This removes the contradiction — the approved copy _does_ present specific national crisis destinations, so draft Rev 3 and released `SAFETY.md` no longer conflict. Awaiting owner merge/ratification of 0.1.5; until then the implementation still renders the placeholder (an unreleased spec is not authority).
- **Refs:** draft `ISLANDS.md` §4, `SURFACES.md`, `FENCE_POSTS.md` G8 vs released `SAFETY.md` §2/§3.1/§9 + new `SAFETY_COPY.md`, `ONBOARDING.md`, `COMPLIANCE.md`; `GLOSSARY.md` "Island".
- **Conflict (historical):** Draft Rev 3 requires _always_ presenting specific national crisis destinations on the crisis path (including when island config is absent); released `SAFETY.md` previously kept approved crisis copy `D-012 DECISION_PENDING`, forbade presenting invented crisis wording as official, and expected a placeholder/empty slot. `FRICTION.md` §5.3 proposed a narrow close but was not accepted; D-012 now supersedes it.
- **Follow-up:** After 0.1.5 releases, the implementation renders `SAFETY_COPY.md` behind `SUAS_SAFETY_COPY_MODE=approved`, and draft **D-026** (island_id scope) remains separately open.

### G-III-2 — D-015 / D-016 `DECIDED` in the register but "open" in domain text

- **Refs:** `DECISIONS.md` D-015/D-016 (`DECIDED`) vs `CASES.md`, `PRODUCT.md`, `ONBOARDING.md`, `PILOT.md`, `PRIVACY.md` (still "open" / `INFERRED`).
- **Impact:** Implementers cannot tell whether veteran Case-Note visibility (D-015) and enrollment proofing (D-016) are settled defaults or still open.

### G-III-3 — SPEC acceptance references an undefined target (effective Support Signal projection)

- **Refs:** SPEC-003 accepts "effective projection as defined in SPEC-006"; SPEC-006 / `DATA_MODEL.md` / `CASES.md` do not define the selection rule; `SUPPORT_SIGNALS.md` §7 defers it.
- **Impact:** An accepted decision points at a rule that no released file specifies (see G-I-24).

### G-III-4 — Released manifest/acceptance vs per-file `draft` headers (authority meta-gap)

- **Refs:** `RELEASE_MANIFEST-0.1.3.md` + SPEC-010/011/013/014 acceptance vs `draft` / `dependency-blocked` headers still on `DOMAIN_MODEL.md`, `DATA_MODEL.md`, `EVENT_MODEL.md`, `CASES.md`, `DISPATCH.md`, `FULFILLMENT.md`, `RESILIENCE.md`, `OPERATIONS.md`, `PRODUCT.md`, `GLOSSARY.md`, and others; SPEC acceptance records still pinned to stack `0.1.0`.
- **Impact:** "Which text is binding" cannot be answered from a file's own header; every read must re-derive authority from the manifest. Pervasive; low-effort to fix.

---

## Bucket I — Editorial / underspecified (fixable via spec patch; no new decision)

### Vocabulary alignment

- **G-I-1 — Capability naming is four parallel schemes, never mapped.** Category `SHELTER` vs capability id `TEMPORARY_SHELTER_FULFILLMENT` vs port `TemporaryShelterPort` vs `FulfillmentAttempt.capability`. Refs: `DISPATCH.md` §7, `ARCHITECTURE.md` §11, `FULFILLMENT.md`, `APIS.md`, `DOMAIN_MODEL.md`. Impl maps these explicitly in `src/fulfillment/port.ts` (Slice 7 §10 item 2).
- **G-I-2 — Mode enums unrelated.** `integration_mode` (attempt) vs `integration_modes` (resource) vs `fulfillment_mode` (offer). Refs: `FULFILLMENT.md`, `RESOURCES.md`, `PROVIDER_INTEGRATIONS.md`.
- **G-I-3 — Follow-Up counter name mismatch.** `coordination_attempt_count` (`DATA_MODEL.md`) vs `retry_count` (`FOLLOWUP.md`).
- **G-I-4 — `ServiceOffer` (catalog) vs `ProviderOffer` (live) have no join/supersession rule.** Refs: `DOMAIN_MODEL.md`, `PROVIDER_INTEGRATIONS.md` §6, `DISPATCH.md` §5.
- **G-I-5 — Manual adapter naming (generic vs capability-specific) with no required-adapter registry.** Refs: `ARCHITECTURE.md`, `PROVIDER_INTEGRATIONS.md`, `FULFILLMENT.md`.

### State machines — undefined or contradictory edges

- **G-I-6 — `ServiceFulfillment.PARTIAL` has no entry trigger** and dispatch requires `COMPLETED` evidence for request `FULFILLED`. Refs: `FULFILLMENT.md`, `DISPATCH.md` §4. (Slice 7 §10 item 3.)
- **G-I-7 — `ServiceFulfillment.DISPUTED` has no transition table** (source states, actors, exits). Refs: `FULFILLMENT.md`.
- **G-I-8 — Fulfillment `FAILED` → request outcome is a non-deterministic disjunction** ("typically `UNFULFILLABLE` or remain actionable"). Refs: `FULFILLMENT.md` §5/§7.
- **G-I-9 — Request `ESCALATED` source set not closed-listed; exit target (`TRIAGED` or `MATCHING`) has no selection rule.** Refs: `DISPATCH.md` §2/§4.
- **G-I-10 — Cancellation/expiry "allowed non-terminal" states described in prose, not enumerated** (both `DISPATCH.md` §4 and `REFERRALS.md` §3).
- **G-I-11 — Follow-Up `RESCHEDULED` / `OVERDUE` / `ESCALATED` transitions + events undefined.** Refs: `FOLLOWUP.md` §2/§7/§9, `EVENT_MODEL.md` §3. Impl returns `RESCHEDULED` to `SCHEDULED` deliberately (Slice 6 §10 items 1, 3).
- **G-I-12 — Case reopen documented only from `CLOSED`, not `RESOLVED`,** despite multi-cycle settlement narrative. Refs: `CASES.md` §4.2, `SETTLEMENT.md` §3.
- **G-I-13 — "Blocking Service Request" for case resolve is never defined** (which request states block?). Refs: `CASES.md` §4/§7. Impl treats any non-terminal request as blocking (Slice 5 §10 item 1).
- **G-I-14 — `ACTIVATE` (`ASSIGNED → ACTIVE`) is implementation-named; qualifying-work trigger undefined.** Refs: `CASES.md` §4. (Slice 5 §10 item 2.)
- **G-I-15 — `SERVICE_FAILED` event emit conditions undefined;** most request transitions (submit, triage, matching, start, confirm, close, cancel, decline, expire, escalate) have **no Domain Event** in the catalog. Refs: `DISPATCH.md` §4, `EVENT_MODEL.md` §3.

### Joins and field shapes

- **G-I-16 — `notifications` has no reference to Case / Service Request / Referral / triggering event.** This makes MVP `RESPONDER_NOTIFIED` unreachable. Refs: `DATA_MODEL.md` §9, `NOTIFICATIONS.md` §3. (Slice 10 §10 item 1; Slice 8 §10 items 3-4.)
- **G-I-17 — `contact_method` / `referral_method` (`RESOURCES.md`) and referral `destination type/id` are unstructured** (no scheme discriminator), so direct actions and validation are not implementable. (Slice 10 §10 item 2; Slice 7 §10.)
- **G-I-18 — Follow-Up `responsible_type` / `referral_id` not modeled/enumerated in the logical schema.** Refs: `FOLLOWUP.md` §3, `DATA_MODEL.md` §6. (Slice 6 §10 item 4.)
- **G-I-19 — Settlement summary field shapes undefined** (structured references vs free text). Refs: `SETTLEMENT.md` §2, `DATA_MODEL.md` §8. (Slice 6 §10 item 6.)
- **G-I-20 — Service Request "required details" per category undefined** (submit validation references them). Refs: `DISPATCH.md` §4, `API.md`.
- **G-I-21 — Current-assignment projection algorithm for a Service Request unspecified** ("deterministic from history" with no rule). Refs: `DISPATCH.md` §6.
- **G-I-22 — `FulfillmentAttempt` reconciliation sub-state appears in `RESILIENCE.md` but not in `DATA_MODEL.md`; ServiceFulfillment cardinality per request undefined.** Refs: `RESILIENCE.md`, `DATA_MODEL.md` §7, `FULFILLMENT.md` §3.

### Consent mechanics

- **G-I-23 — No closed registry of `consent_basis` / system-basis codes.** Many paths allow action on a "documented system basis" with no enumeration. Refs: `CONSENT.md` §3.5/§3.6, `NOTIFICATIONS.md`, `REFERRALS.md`. Impl closes the list to `SYSTEM_INTERNAL_PROCESSING`, `RESPONDER_CASE_ASSIGNMENT` (Slice 4 §10 item 3).
- **G-I-24 — Effective-signal selection rule is defined nowhere** (override chains, multiple primaries, tie-break; must be deterministic, not insertion-order). Refs: `SUPPORT_SIGNALS.md` §7 (defers), `DATA_MODEL.md` §4. Impl uses most-recent `computed_at`, tie-break by id desc, overrides supersede (Slice 9 §10 item 2). Definable now, independent of D-011 thresholds.
- **G-I-25 — `grantee_type` / `grantee_id` typing per grantee not specified** (what does the id reference for TRUSTED_CONTACT / RESPONDER / ORGANIZATION / SERVICE_PROVIDER?). Refs: `CONSENT.md` §2. (Slice 4 §10 item 2.)
- **G-I-26 — Purpose-matching is prose, not a comparison rule.** Refs: `CONSENT.md` §3.4. (Slice 4 §10 item 5.)
- **G-I-27 — Permission/scope vocabulary is illustrative ("e.g."), not closed;** unknown-pair accept/reject undefined. Refs: `CONSENT.md` §2.1. Impl closes it via `PERMITTED_SCOPES`.
- **G-I-28 — `priority_signal_level` and the "signal-driven case open/update" action are referenced but not modeled** in `CASES.md` / `DATA_MODEL.md`; no named command. Refs: `SAFETY.md` §3.2, `RESPONDER_WORKFLOWS.md` §4, `CASES.md` §3. (Slice 5 §10 item 4; Slice 9 §10 item 7.)

### MVP UI ↔ domain mapping

- **G-I-29 — QRF UI labels have no normative mapping table to Case/Request/notification facts.** Refs: `MVP_REFERENCE.md` §7.2, `DISPATCH.md` §2.
- **G-I-30 — Responder on-duty/availability has no state machine, events, or matching tie-in** (`active_for_queue` only, with "optional" unspecified fields). Refs: `MVP_REFERENCE.md` §9, `RESPONDER_WORKFLOWS.md` §10, `ADMIN.md` §4. (Slice 10 §10 item 3.)
- **G-I-31 — Chat / persistent messaging is UI-required with no domain entity** (thread/message store, consent scope, API). Refs: `MVP_REFERENCE.md` §5. (Slice 10 §10 item 4.)
- **G-I-32 — Four responder dashboard metrics have no definitions/data sources.** Refs: `MVP_REFERENCE.md` §9. (Slice 10 §10 item 6.)
- **G-I-33 — "Quick Resource Share" is named with no domain action / consent rule.** Refs: `MVP_REFERENCE.md` §9.

### Auth constants and versioning clarity

- **G-I-34 — Challenge TTL, session idle/absolute timeout, MFA elevation TTL, rate-limit bounds all `INFERRED`/unset;** cross-instance revocation "security window" undefined. Refs: `AUTH.md` §3/§5, `SECURITY.md` §2. Impl gathers all as labelled `INFERRED` constants (Slice 3 §10 item 3).
- **G-I-35 — Tenant resolution at sign-in for a passwordless contact undefined** (challenge endpoints take a client-supplied `tenant_id`; pre-tenant vs post-enrollment binding gap). Refs: `AUTH.md` §2, `DATA_MODEL.md` §2, `ONBOARDING.md` §7.1. (Slice 3 §10 item 1.)
- **G-I-36 — SUAS-admin global role has no released representation** (roles modeled only on org memberships). Refs: `AUTH.md` §6, `DATA_MODEL.md` §2. Impl uses an auditable `suas_admin_grants` table (Slice 3 §10 item 2).
- **G-I-37 — Notification template rendering contract and policy vocabulary (event → recipient/channel/dedupe) not enumerated;** webhook auth/retry bounds qualitative. Refs: `NOTIFICATIONS.md` §1/§5/§6/§8. (Slice 8 §10 items 2-6.)
- **G-I-38 — Consent-template publication is required for grants but absent from bootstrap hard-gates and admin APIs.** Refs: `CONSENT.md` §6, `ADMIN.md` §2, `ONBOARDING.md`, `APIS.md`. (Slice 4 §10 item 8.)
- **G-I-39 — Five parallel version identities + unset runtime-content versions; DB schema-version mechanism format unspecified.** Refs: `VERSIONING.md` §3, `RELEASE_MANIFEST-0.1.3.md`, `ENVIRONMENT.md` §9. (Slice 1 §10 item 6.)

---

## Bucket II — Owner decisions (cannot be invented)

These require an owner decision and/or external evidence; the release forbids
inventing them (`AGENTS.md` rule 15; `DECISIONS.md` "Do not invent signal
weights, crisis copy, legal status, capacity/SLO/RTO/RPO numbers, or reporting
privacy thresholds"). Deferral is safe today only because the corresponding
production surface is `UNAVAILABLE` / manual-only.

| ID                | Decision                                                                                                                                                                   | Status                                                                       | Blocks                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **D-001**         | Production hosting/cloud                                                                                                                                                   | `DECISION_PENDING`                                                           | production/staging deploy shape                                                                                              |
| **D-002/003/004** | Auth / SMS / email providers                                                                                                                                               | `DECISION_PENDING`                                                           | real channels; MFA factor taxonomy; webhook signature schemes                                                                |
| **D-005**         | Production DB hosting                                                                                                                                                      | `DECISION_PENDING`                                                           | production DB HA/backup ops                                                                                                  |
| **D-006**         | Legal/HIPAA classification                                                                                                                                                 | `DECISION_PENDING`                                                           | breach deadlines; incident-severity timing                                                                                   |
| **D-007**         | Retention/deletion durations                                                                                                                                               | `DECISION_PENDING`                                                           | idempotency/event/consent retention; archive strategy                                                                        |
| **D-008**         | Pilot partner organizations                                                                                                                                                | `DECISION_PENDING`                                                           | pilot launch; tenant/org model realism                                                                                       |
| **D-009**         | Responder staffing / coverage hours                                                                                                                                        | `DECISION_PENDING`                                                           | on-duty ops; red-state coverage; OPERATIONS gate; several dashboard metrics                                                  |
| **D-010**         | Service funding / payment architecture                                                                                                                                     | `FUTURE` / `DECISION_PENDING`                                                | Amadeus reservation (`BLOCKED_BY_PAYMENT_ARCHITECTURE`), Uber payment auth, `who_pays`/`funding_rails` enforcement, Medi-Cal |
| **D-011**         | Production Support Signal scoring rules/thresholds + golden vectors                                                                                                        | `DECISION_PENDING`                                                           | all production scoring; incomplete-input semantics; SAFETY/COORDINATION gates                                                |
| **D-012**         | Approved production safety/crisis copy                                                                                                                                     | `DECIDED` (v0.1.5, spec PR #8; 911/988 in `SAFETY_COPY.md`; pending release) | veteran crisis surface; G-III-1 (resolved); yellow/orange copy                                                               |
| **D-013**         | Counsel review of compliance register                                                                                                                                      | `DECISION_PENDING`                                                           | pilot gate                                                                                                                   |
| **D-014**         | Production geocoding/maps                                                                                                                                                  | `DECISION_PENDING`                                                           | proximity/"near you"; location basis                                                                                         |
| **D-017**         | Production transportation adapter                                                                                                                                          | `DECIDED` (v0.1.2, Uber)                                                     | — (implemented; payment still D-010)                                                                                         |
| **D-018**         | Production shelter adapter                                                                                                                                                 | `DECIDED` (v0.1.3, Amadeus)                                                  | reservation still `BLOCKED_BY_PAYMENT_ARCHITECTURE` (D-010)                                                                  |
| **D-019**         | Production food adapter + projection                                                                                                                                       | `DECISION_PENDING`                                                           | FOOD API-backed fulfillment + disclosure contract (manual only)                                                              |
| **D-020**         | External peer-support adapter + projection                                                                                                                                 | `DECISION_PENDING`                                                           | PEER_SUPPORT external fulfillment + disclosure (manual/QRF only)                                                             |
| **D-021**         | Production workload/capacity envelope                                                                                                                                      | `DECISION_PENDING`                                                           | SCALE gate; load-profile pass/fail; tenant-fairness parameters                                                               |
| **D-022**         | Production durable job/queue product                                                                                                                                       | `DECISION_PENDING`                                                           | production async claim (durable seam refuses non-durable in STAGING/PROD)                                                    |
| **D-023**         | Production SLOs / alert thresholds                                                                                                                                         | `DECISION_PENDING`                                                           | RESILIENCE/OPERATIONS gates; timeout/retry canonical values; auth security window                                            |
| **D-024**         | Production RTO/RPO + backup-restore objectives                                                                                                                             | `DECISION_PENDING`                                                           | RESILIENCE gate; restore-drill acceptance; runbook numbers                                                                   |
| **D-025**         | Aggregate reporting privacy / small-cell policy                                                                                                                            | `DECISION_PENDING`                                                           | REPORTING gate; production percentiles/small slices                                                                          |
| **D-026–D-032**   | Draft Rev 3: island_id↔tenant_id, dispatcher routing, resource curation, reporting vs minimization, dual-enrollment/minors, contracting entity, volunteer-driver screening | `DECISION_PENDING` (draft)                                                   | any island / rides / anonymous-front-door work; G-III-1                                                                      |

Un-numbered but owner-owned: encryption key management (`SECURITY.md`), Follow-Up
coordination retry ceiling (`FOLLOWUP.md` §4), Trusted Contact `relationship_label`
enum (`TRUSTED_CIRCLE.md` §4), veteran lost-all-channel recovery and SUAS-admin
break-glass/dual-control (`AUTH.md` §7), abandoned Check-In idle timeout
(`CHECKINS.md` §4.2).

---

## Notable structural observations

- **Analytics is better off than it looks.** `ANALYTICS.md` §3 operational metrics
  (enrollment, check-in completion, case/request distributions, time-to-assignment,
  fulfillment/confirmation separation) are defined and computable on synthetic
  data; only production aggregate/small-cell reporting and percentiles are
  D-025-blocked, and §4 metrics are intentionally `NOT_COMPUTABLE`.
- **The implementation is a de-facto gap tracker.** Every Bucket I item was hit
  while building and carries a documented, tested mechanism choice in the slice
  records. Ratifying those into spec patches is the cheapest way to close Bucket I.
- **Draft Rev 3 files are non-authoritative** (`README.md`, file headers;
  `FRICTION.md` states its proposals are not accepted), yet `GLOSSARY.md` (released)
  references the draft "Island" contract — the one place draft leaks into released
  terminology (G-III-1, G-III-4).

## Cross-references

- Per-slice returned-gap detail: `docs/slices/SLICE_01_FOUNDATION.md` … `docs/slices/SLICE_11_RESILIENCE_HARNESS.md` (each `## 10` section).
- Built-implementation conformance snapshot: `docs/SPEC017_COMPLETION_AUDIT.md`.
- Runtime spec pins this triage is filed against: `src/release/pins.ts`.

## Method and confidence

Built from (a) a direct read of the released `SUAS-specs` `0.1.3` cut and
(b) the implementation's own returned-to-specs records in `docs/slices/`. Items
that also appear in a slice record carry a `(Slice N §10 item M)` pointer and are
high-confidence (independently surfaced by building against the spec). Section
numbers are indicative; the authoritative locus is the named spec file. This
document makes no readiness claim and closes no decision.
