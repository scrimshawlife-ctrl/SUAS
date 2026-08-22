# SPEC_GAP_PLAN.md — Remaining spec-gap close sequence

**Status:** `PLAN` (not implementation authority)
**Against:** released `SUAS-specs` **0.1.5** (`e8a7d4cc`) and implementation pin `src/release/pins.ts`
**Companion:** `docs/SPEC_DESIGN_GAPS.md` (catalog), `docs/SPEC_GAP_PROPOSALS.md` (P-1..P-23, already ratified in 0.1.4)
**Readiness:** `NOT_READY` (unchanged). Nothing here authorizes production, real veteran data, or SPEC-018.

This plan sequences the **remaining** gaps after:

- **0.1.4** — Bucket I proposals P-1..P-23 ratified (`RELEASE_MANIFEST-0.1.4.md`).
- **0.1.5** — D-012 / G-III-1 closed (`SAFETY_COPY.md`).

It does **not** invent scoring, crisis copy, legal status, vendor, capacity, SLO, RTO/RPO, or reporting-threshold values (`AGENTS.md` rules 3, 14, 15).

---

## 0. Current state

| Layer | State |
| --- | --- |
| Implementation slices 1–11 | Built; SPEC-017 evidence in `docs/SPEC017_COMPLETION_AUDIT.md` |
| Codified Bucket I | P-1..P-23 in specs 0.1.4; P-12/P-13 implemented in this repo |
| Safety copy | D-012 `DECIDED`; UI gated by `SUAS_SAFETY_COPY_MODE` |
| Production scoring | D-011 `DECISION_PENDING`; engine registry empty |
| Pilot / production | Blocked on SPEC-018 + remaining Bucket II |

**Close shape** (repeat for every wave that needs a spec release):

1. Owner accepts the values or editorial text (this plan names *what* must be decided, not *which* value).
2. Canonical patch in `SUAS-specs`: artifact + `RELEASE_DECISIONS-0.1.x.md` (if a D-0xx) + `RELEASE_MANIFEST-0.1.x.md` + `DECISIONS.md` / `CHANGELOG.md` / lineage.
3. Owner merges the specs PR (lifecycle is owner-controlled).
4. Implementation re-pins and implements only what that release authorized.

---

## 1. What is already closed (do not re-open)

### 1.1 Bucket I ratified as 0.1.4 (P-1..P-23)

| Proposal | Gap | Outcome |
| --- | --- | --- |
| P-1 | G-III-4 (partial) | Manifest overrides stale `draft` headers |
| P-2 | G-I-3 | Follow-Up counter = `coordination_attempt_count` |
| P-3 | G-I-39 | Version-identity table + schema-version mechanism |
| P-4 | G-I-1 | Category ↔ capability ↔ port map |
| P-5 | G-I-2 | Mode-concept relationship |
| P-6 | G-I-5 | Mandatory manual adapter + registry |
| P-7 | G-I-9, G-I-10 | Closed cancel/expiry/escalation sets |
| P-8 | G-I-13 | Blocking Service Request = any non-terminal |
| P-9 | G-I-14 | `ACTIVATE` command |
| P-10 | G-I-11 | `RESCHEDULED` → `SCHEDULED` |
| P-11 | G-I-12 | Reopen `CLOSED` → `OPEN` |
| P-12 | G-I-16 | Notification `subject_type` / `subject_id` |
| P-13 | G-I-17 | `contact_method_kind` / typed destination |
| P-14 | G-I-18 | Follow-Up `responsible_type` + `referral_id` |
| P-15 | G-I-36 | `suas_admin_grants` |
| P-16 | G-I-21, G-I-22 | Current-assignment projection + reconciliation / cardinality |
| P-17 | G-I-23 | System-basis registry |
| P-18 | G-I-25 | `grantee_id` typing |
| P-19 | G-I-27 | Permission/scope pairing |
| P-20 | G-I-26 | Purpose recorded, not compared |
| P-21 | G-I-24 | Effective-signal selection (not scoring) |
| P-22 | G-I-28 *field only* | `priority_signal_level` on the Case |
| P-23 | G-I-29 | QRF label → fact table |

### 1.2 Owner decisions already closed

| ID | Release | What closed | What did *not* close |
| --- | --- | --- | --- |
| D-012 | 0.1.5 | Crisis copy + 911/988 + 5-state truthfulness | Production operation |
| D-017 | 0.1.2 | Uber as first transportation adapter | Payment / SPEC-018 |
| D-018 | 0.1.3 | Amadeus as first shelter search adapter | Reservation (D-010) / SPEC-018 |
| D-015 | 0.1.0 | Full Case Notes are not veteran-visible | Domain-file wording (Wave A) |
| D-016 | 0.1.0 | No VA/DD-214/in-person proofing for MVP | Domain-file wording (Wave A) |

---

## 2. Remaining work, in waves

Waves are sequential for *authority* (later waves may start in parallel once their inputs exist). Do not skip Wave B if the goal is live Check-In → Case.

```text
Wave A  hygiene (no new product value)
   ↓
Wave B  D-011 scoring contract          ← load-bearing
   ↓
Wave C  leftover Bucket I product rules
   ↓
Wave D  remaining capability adapters
   ↓
Wave E  SPEC-018 / pilot cluster
   ↓
Wave F  draft Rev 3 (islands)           ← defer
```

---

### Wave A — Spec hygiene (no new product decision) — **IN FLIGHT**

**Goal:** Make already-decided rules readable in the files implementers open first. Target: a small `0.1.6` editorial release.

**Drafted** on `SUAS-specs` `cursor/spec-0.1.6-wave-a-hygiene-1036` as `RELEASE_MANIFEST-0.1.6.md`. Lifecycle is owner-controlled: **do not re-pin** `src/release/pins.ts` until that specs PR is merged. G-I-4 is **not** in the draft (no `ServiceOffer`/`ProviderOffer` join exists in this repo to transcribe).

| ID | Close | Spec files | Owner input needed? |
| --- | --- | --- | --- |
| **G-III-2** | Replace “D-015/D-016 open / `INFERRED`” prose with the 0.1.0 decided defaults | `CASES.md` §8.1 (still titled “D-015 open”); `AUTH.md` (D-016 `INFERRED`); `PRODUCT.md`, `ONBOARDING.md`, `PILOT.md`, `PRIVACY.md` if they still say open | **No.** Values are already in `DECISIONS.md` / `RELEASE_DECISIONS-0.1.0.md`. |
| **G-III-3** | Point SPEC-003 / leftover “undefined projection” text at the 0.1.4 selection rule | `SPEC-003.md`, any leftover deferral in `SUPPORT_SIGNALS.md` §7 | **Confirm only:** two overrides targeting the same signal (P-21 caveat). If unstated, keep current impl (override supersedes its target; newest `computed_at` wins). |
| **G-III-4 leftover** | Per-file headers still say `draft` / `0.1.0` (e.g. `CASES.md`, `SUPPORT_SIGNALS.md`) even though P-1 made the manifest win | Same files P-1 listed | **No.** Either stamp `released via RELEASE_MANIFEST-0.1.5.md` or leave the P-1 override sentence and add a one-line “stale header is not authority” on each high-traffic file. |
| **G-I-4** | `ServiceOffer` (catalog) vs `ProviderOffer` (live) join/supersession | `DOMAIN_MODEL.md`, `PROVIDER_INTEGRATIONS.md` §6, `DISPATCH.md` §5 | **Only if** no current impl rule can be transcribed. First pass: document whatever the router already does; do not invent a new offer lifecycle. |

**Exit:** An implementer reading `CASES.md` / `AUTH.md` / `SUPPORT_SIGNALS.md` does not see a contradiction with `DECISIONS.md`.

---

### Wave B — D-011 Support Signal scoring (load-bearing)

**Goal:** Released scoring contract so a Check-In can produce a production `GREEN|YELLOW|ORANGE|RED` without inventing weights.

**Already built (do not redo):** engine interface, computation identity, settlement, override rows, empty registry, `SUAS_SUPPORT_SIGNAL_MODE=disabled|fixture`, free text excluded from canonical input (`src/signals/*`, Slice 9).

**Owner must supply all of the following** (see prior D-011 brief). A close that omits any row is not implementable:

| # | Decide | Released home | Bound |
| --- | --- | --- | --- |
| B1 | Questionnaire content: questions, closed options, required flags, option weights for `sleep`, `connection`, `stress`, `basic_needs`, `coping`, `safety` | New artifact (e.g. `SIGNAL_SCORING.md` or a published `QuestionnaireVersion` record) | `CHECKINS.md` §3 — no invented clinical instrument / psychometric claim |
| B2 | Deterministic scoring: canonical answers + `signal_version` + questionnaire version → `level` + inspectable `basis` | Same artifact | `SUPPORT_SIGNALS.md` §2 — no generative primary signal |
| B3 | Incomplete-input rule: refuse (today) **or** a deterministic missing-input function | Same artifact + `CHECKINS.md` §4.1 | Until closed, production compute from `INCOMPLETE` stays forbidden |
| B4 | Golden vectors: fixed inputs → expected `level` + `basis` for that version | `TESTING.md` §3.1 / §12 | Stay `UNRELEASED_FIXTURE` until this table is released |
| B5 | Immutable `signal_version` id (+ matching questionnaire version) | `VERSIONING.md` runtime-content identities; admin publish path | New version writes new rows; never mutates history |

**Also decide with D-011 or immediately after (depends on scores existing):**

| ID | Why it rides with D-011 |
| --- | --- |
| **G-I-28 action** | `SAFETY.md` §3.2 says `RED` must open/update a Support Case. P-22 modeled `priority_signal_level` but **not** the command that writes it. Need: command name, idempotency identity, which levels open vs update, what happens if a case is already `CLOSED`. |

**Not D-011:** effective-signal *selection* (P-21), abandoned Check-In idle timeout (`CHECKINS.md` §4.2), island/crisis numbers (D-026).

**Close shape:** `RELEASE_DECISIONS-0.1.x.md` + scoring artifact + golden vectors + `DECISIONS.md` D-011 → `DECIDED`. Then implementation registers one `released: true` engine and keeps TEST default on fixture unless the owner also authorizes `approved`-style env for scoring.

**Exit:** A completed synthetic Check-In can settle a Support Signal under a released version; CHECK-IN gate evidence can cite golden vectors. Still not SPEC-018.

---

### Wave C — Leftover Bucket I that needs a product/policy choice

These were **intentionally excluded** from P-1..P-23 (`SPEC_GAP_PROPOSALS.md` “Not proposed here”). Each needs a rule, not just a header fix.

Do **C1** before more fulfillment-adapter work. Do **C2** before claiming event-catalog completeness. **C3–C5** unblock UI/auth completeness; they can proceed in parallel with Wave D.

#### C1 — Fulfillment outcomes (correctness-critical)

| ID | Decision the owner must make | Why it cannot be inferred |
| --- | --- | --- |
| **G-I-6** | Who may declare `ServiceFulfillment.PARTIAL`, on what evidence, and whether a request may become `FULFILLED` from partial work | Dispatch currently wants `COMPLETED` evidence for `FULFILLED` |
| **G-I-7** | Full `DISPUTED` table: legal source states, who may dispute, exits besides “never back to `CONFIRMED`” (already implemented) | Only the dispute *edge* is specified |
| **G-I-8** | Deterministic map: fulfillment `FAILED` → request `UNFULFILLABLE` **or** remain actionable (and when) | Spec today is a disjunction |

#### C2 — Events and settlement shape

| ID | Decision |
| --- | --- |
| **G-I-15** | Which currently audit-only Service Request transitions become Domain Events (`SERVICE_FAILED` emit conditions + the un-evented submit/triage/match/start/confirm/close/cancel/decline/expire/escalate set) |
| **G-I-19** | Settlement summary: structured references vs free text (field list) |
| **G-I-20** | Per-category “required details” on Service Request submit (`FOOD` / `TRANSPORTATION` / `SHELTER` / `PEER_SUPPORT`) |

#### C3 — Responder / MVP surfaces (UI-required, domain-absent)

| ID | Decision | Blocked surface |
| --- | --- | --- |
| **G-I-30** | On-duty / availability state machine, events, matching tie-in (D-009 supplies *hours*, not the machine) | Live QRF matching, dashboard on-duty |
| **G-I-31** | Chat/thread domain: entities, consent scope, API, retention | Persistent messaging (today: truthful UNAVAILABLE) |
| **G-I-32** | Definitions + data sources for the four responder dashboard metrics | Showing numbers (today: omitted) |
| **G-I-33** | Quick Resource Share: domain action + consent rule | Share control |

#### C4 — Auth / tenancy

| ID | Decision |
| --- | --- |
| **G-I-34** | Challenge TTL, session idle/absolute timeout, MFA elevation TTL, rate-limit bounds, cross-instance revocation window (today: labelled `INFERRED` constants) |
| **G-I-35** | How a passwordless contact binds to `tenant_id` at challenge time (client-supplied today) |

#### C5 — Notifications / consent templates

| ID | Decision |
| --- | --- |
| **G-I-37** | Event → recipient/channel/dedupe/template vocabulary; webhook auth/retry bounds as numbers |
| **G-I-38** | Whether consent-template publication is a released admin API / bootstrap hard-gate (mechanism exists in code) |

**Exit:** Each accepted item becomes a 0.1.x spec patch in the P-n style (codify if impl already has a tested rule; otherwise owner writes the rule first).

---

### Wave D — Remaining capability adapters

| ID | Status | What to decide | Unblocks |
| --- | --- | --- | --- |
| **D-019** | Pending | Production food adapter family + field-level disclosure projection (or explicit “manual-only through pilot”) | FOOD API path |
| **D-020** | Pending | External peer-support adapter + projection (or explicit “manual/QRF only through pilot”) | External PEER_SUPPORT |
| **D-010** | Future / pending | Who pays; reservation/payment architecture | Amadeus reservation; Uber payment auth |

D-017/D-018 stay decided. Wave D does not require D-011 unless the adapter path is signal-triggered.

---

### Wave E — SPEC-018 / pilot cluster (do not start for “more product”)

These close **readiness**, not SPEC-017 conformance. Group for one owner sitting if possible.

| Cluster | IDs | Decide |
| --- | --- | --- |
| Comms / identity | D-002, D-003, D-004 | Auth, SMS, email providers (and MFA factor taxonomy) |
| Infra | D-001, D-005, D-022 | Hosting, production DB, durable job product |
| Legal / data | D-006, D-007, D-013 | HIPAA classification, retention/deletion, counsel review |
| Pilot ops | D-008, D-009 | Partner orgs, responder coverage hours |
| Maps | D-014 | Production geocoding / “near you” |
| Envelopes | D-021, D-023, D-024 | Capacity, SLOs/alerts, RTO/RPO |
| Reporting | D-025 | Small-cell / aggregate privacy |

**Un-numbered, same wave when touched:** encryption key management; Follow-Up retry ceiling; Trusted Contact `relationship_label` enum; lost-all-channel recovery; SUAS-admin break-glass/dual-control; abandoned Check-In idle timeout.

**Exit:** SPEC-018 evidence can be collected. Still a separate stage from this plan.

---

### Wave F — Draft Rev 3 (defer)

**D-026–D-032** (island_id vs tenant, dispatcher routing, resource curation, reporting vs minimization, dual-enrollment/minors, contracting entity, volunteer-driver screening).

Draft files are not authority. Do not implement islands, anonymous front door, or extra crisis numbers. G-III-1 leftover (“Island” in `GLOSSARY.md`) is editorial-only until D-026.

---

## 3. Recommended owner order

Smallest set that unblocks the most *product* (not hosting):

| Priority | Item | Why this next |
| --- | --- | --- |
| 1 | **Wave A** (G-III-2, leftover headers) | **Drafted** as specs `0.1.6` (`cursor/spec-0.1.6-wave-a-hygiene-1036`). Owner merge required before re-pin. |
| 2 | **Wave B — D-011** (+ G-I-28 action) | Only remaining load-bearing SPEC-017 gap |
| 3 | **Wave C1** (G-I-6/7/8) | Stops fulfillment edge-case invention |
| 4 | **Wave D — D-019/D-020** (or “manual through pilot”) | Completes capability-port story |
| 5 | **G-I-30** if live QRF matching is the next UX goal | Dashboard/on-duty truth |
| 6 | **D-010** when reservation/payment is in scope | Unblocks Amadeus book + Uber pay |
| 7 | **Wave E** when a real pilot date exists | SPEC-018 |

---

## 4. Execution notes for the next agent

- Canonical repo for Waves A–F spec text: `scrimshawlife-ctrl/SUAS-specs`. This repo only re-pins after a specs merge.
- Do not encode Wave B–E values in implementation first. D-012 was the opposite order (decision then code) and is the pattern to keep.
- Wave A is drafted as editorial `0.1.6` (no new owner values). Owner-merge the specs PR, then re-pin this repo. Do not treat the draft branch as released authority.
- After any specs merge: update `src/release/pins.ts`, `.env.example`, `tests/helpers/env.ts`, `tests/setup.ts`, `.github/workflows/verify.yml`, and the handoff docs together.
- Catalog hygiene: when a wave merges, mark the gap `RESOLVED` in `docs/SPEC_DESIGN_GAPS.md` the way G-III-1 / D-012 were marked.

---

## 5. Out of scope

- Inventing D-011 weights, golden vectors, or questionnaire wording.
- Treating `SUAS_SAFETY_COPY_MODE=approved` as the TEST/CI default.
- Advancing any `TESTING.md` readiness gate.
- Implementing draft Rev 3 islands or extra hotlines.
- Claiming SPEC-017 “complete” in `STATUS.md` (owner records that).
