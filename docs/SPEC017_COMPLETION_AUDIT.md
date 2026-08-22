# SPEC-017 completion audit — released stack `0.1.3`

**Released spec stack:** `0.1.3`
**Release manifest:** `RELEASE_MANIFEST-0.1.3.md`
**Specs merge:** `33c6f1925a8f8eb7ea1f52e77a102b28a249430f` (`src/release/pins.ts`)
**Decision ledgers:** `RELEASE_DECISIONS-0.1.3.md` (D-018), `RELEASE_DECISIONS-0.1.2.md` (D-017), `RELEASE_DECISIONS-0.1.0.md` (all other D-001–D-025)
**Stage:** `SPEC-017` implementation conformance
**Pilot / production readiness:** `NOT_READY` (unchanged by this audit)

This document is implementation evidence, not a readiness claim. Readiness is
recorded in the specs' `STATUS.md` on accepted evidence, and SPEC-018 remains the
only path to any real pilot or production operation. No readiness gate advances
here.

## 1. Purpose and scope

`SPEC017_PLAN.md` states: "SPEC-017 completes only when the built implementation
is audited against the entire released cut and all material gaps are fixed or
returned to specs." This audit performs that cross-check against the released
`0.1.3` cut: it confirms every planned slice is implemented, cross-checks the
build's provenance and availability boundaries against the released manifests and
decision ledgers, and consolidates every gap each slice returned to specs together
with its current disposition.

It audits the built implementation as it stands on the default branch. It does not
re-run the per-slice conformance analysis, change any released product/domain
rule, or advance any gate.

## 2. Method and provenance cross-check

- Consolidated the eleven per-slice conformance records in `docs/slices/`.
- Cross-checked the runtime pins in `src/release/pins.ts` against the released
  `RELEASE_MANIFEST-0.1.3.md`, `STATUS.md`, `CHANGELOG.md`, and the D-017/D-018
  decision ledgers in a fresh clone of `scrimshawlife-ctrl/SUAS-specs`.
- Verified the provider-adapter and disclosure-projection surfaces exist in code
  (`src/fulfillment/*`, `src/privacy/projection.ts`).
- Ran the full quality gate (`npm run verify`).

The slice records are each pinned to the stack they were authored under (`0.1.1`
for Slices 1–11). The runtime later advanced to `0.1.3` through two decision-only
patches — D-017 (v0.1.2, Uber transportation) and D-018 (v0.1.3, Amadeus shelter)
— neither of which changed product, domain, API, event, safety, privacy, or
readiness semantics (`CHANGELOG.md`; `RELEASE_MANIFEST-0.1.2.md`,
`RELEASE_MANIFEST-0.1.3.md`). `src/release/pins.ts` pins `SPEC_VERSION = 0.1.3`
and `RELEASE_MANIFEST-0.1.3.md`; the two authored-vs-runtime stack labels are
therefore consistent, and this audit is filed at `0.1.3`.

## 3. Slice conformance status

All eleven `SPEC017_PLAN.md` slices are implemented, with conformance records and
passing evidence. Qualifiers mark surfaces the release keeps manual-only or
interface-only.

| Slice                           | Status                         | Primary evidence                                                                                                |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 1 — Foundation                  | `IMPLEMENTED`                  | `config`, `build-info`, `jobs`, `fixture-boundary`, `migration-plan` (unit); `migrations`, `http` (integration) |
| 2 — Event / idempotency kernel  | `IMPLEMENTED`                  | `event-envelope`, `fingerprint` (unit); `events`, `idempotency` (integration)                                   |
| 3 — Identity / tenancy / authz  | `IMPLEMENTED`                  | `auth-primitives`, `authz-policy` (unit); `auth`, `identity`, `http-auth` (integration)                         |
| 4 — Consent and privacy kernel  | `IMPLEMENTED`                  | `projection` (unit); `consent` (integration)                                                                    |
| 5 — Coordination kernel         | `IMPLEMENTED`                  | `coordination-transitions` (unit); `coordination` (integration)                                                 |
| 6 — Follow-Up / Settlement      | `IMPLEMENTED`                  | `settlement` (integration)                                                                                      |
| 7 — Resources / fulfillment     | `IMPLEMENTED`                  | `fulfillment` (integration); `uber-guest-rides`, `amadeus-lodging` (unit)                                       |
| 8 — Notifications               | `IMPLEMENTED`                  | `notifications` (integration)                                                                                   |
| 9 — Check-In / Support Signal   | `IMPLEMENTED (interface only)` | `signals` (integration)                                                                                         |
| 10 — MVP-reference UI           | `IMPLEMENTED`                  | `ui-contract`, `ui-surfaces` (unit); `ui` (integration)                                                         |
| 11 — Scale / resilience harness | `IMPLEMENTED (drills only)`    | `resilience-harness` (unit); `resilience-drills` (integration)                                                  |

Per-slice detail lives in `docs/slices/SLICE_01_FOUNDATION.md` through
`docs/slices/SLICE_11_RESILIENCE_HARNESS.md`.

## 4. Cross-cutting conformance

### 4.1 Version identities and provenance

Spec stack, application version, API version (`/api/v0`), event schema (`0.1.0`),
and DB schema version (`9`) are kept as separate identities (`VERSIONING.md` §3;
`src/release/pins.ts`, `src/db/schema-version.ts`). Build provenance reports
stack, manifest, specs commit, environment class, schema version, and
`provenance_complete`, and never emits secret material (`build-info` unit tests).

### 4.2 Availability boundaries and pending decisions

Configuration can only further disable a feature; it cannot enable any surface the
manifest or decision ledger marks unavailable/future (`ENVIRONMENT.md` §4;
`config` unit tests, which name D-011, D-012, D-017–D-020, D-025 in their
rejections). Confirmed against the released ledgers: **D-017 `DECIDED`** (v0.1.2)
and **D-018 `DECIDED`** (v0.1.3); **D-011** (Support Signal scoring), **D-012**
(safety/crisis copy), **D-019** (food adapter), and **D-020** (external
peer-support adapter) remain `DECISION_PENDING`. The slice records additionally
rely on still-open D-001, D-007, D-009, D-010, D-014, D-015, D-021, D-022, D-023,
D-024, and D-025 (§5 below).

### 4.3 Provider fulfillment (D-017 / D-018)

Per-capability provider disclosure is no longer globally absent. Uber
(`TransportationPort`) and Amadeus (`TemporaryShelterPort`) ship as adapter-local
realizations behind the Provider Router, with released field-level disclosure
projections registered in `src/privacy/projection.ts`, deterministic ranking,
provider health/fallback, and SUAS-side idempotency
(`src/fulfillment/{uber-guest-rides,amadeus-lodging,temporary-shelter,registry}.ts`;
`uber-guest-rides`, `amadeus-lodging` unit tests). Manual adapters remain
mandatory, Amadeus reservation is `BLOCKED_BY_PAYMENT_ARCHITECTURE`, and no real
credential use, booking, reservation, webhook handling, or veteran-data disclosure
is authorized until SPEC-018 (`RELEASE_DECISIONS-0.1.2.md`,
`RELEASE_DECISIONS-0.1.3.md`). `FOOD_SUPPORT` and `PEER_SUPPORT` remain
projection-absent and manual/fake only (D-019, D-020 pending).

### 4.4 Correctness invariants

Persistent command idempotency, append-only event stores enforced by database
triggers, at-least-once delivery with per-consumer dedupe, outbox-recovered
publication, one-winner concurrent claims, and cross-instance session revocation
are exercised against PostgreSQL 17 with two in-process instances (`idempotency`,
`events`, `coordination`, `resilience-drills` integration tests). Tenant scope is
a required argument on domain reads and is carried through jobs, events, and
idempotency keys.

### 4.5 Safety and privacy

No official safety/crisis copy is shipped; the veteran crisis slot renders a
labelled placeholder (D-012 pending; `ui-surfaces`, `ui-contract` unit tests). No
automated emergency dispatch, diagnosis, suicide prediction, or safety-critical
generative behavior exists. Disclosure uses use-time consent evaluation and
minimum-necessary projection (`consent`, `projection` tests). LOCAL/TEST/STAGING
fail closed on real external effects and refuse production data resources
(`config` tests; `ENVIRONMENT.md` §5).

### 4.6 Test evidence

`npm run verify` — Prettier format check, ESLint, `tsc --noEmit`, and the full
suite — passes: **684 tests across 32 files**, integration suites against
PostgreSQL 17.

## 5. Material gap ledger (returned to specs)

Every gap each slice returned to specs is consolidated here by disposition. None
changes a released product/domain rule; each is safe today because the
corresponding production surface remains unavailable, manual-only, or
information-only. Item numbers reference the `## 10` section of each slice record.

### 5.A Closed since authoring by a later released decision

- **Per-capability disclosure projection** (Slice 4 item 1; Slice 7 item 1) — was
  the load-bearing blocker at `0.1.1`. D-017 (v0.1.2) released the `TRANSPORTATION`
  contract and D-018 (v0.1.3) released the `TEMPORARY_SHELTER` contract; both are
  implemented (§4.3). `FOOD_SUPPORT` and `PEER_SUPPORT` remain open (D-019, D-020).

### 5.B Blocked pending a named, unreleased decision

The production surface stays unavailable/manual-only, so deferral is safe.

- **D-011** — Support Signal scoring rules/thresholds and golden vectors. The
  engine, versioning, determinism, and settlement are built and tested against a
  labelled unreleased fixture; the registry ships empty (Slice 9 items 1, 4).
- **D-012** — approved safety/crisis copy; placeholder only (Slice 10 item 5).
- **D-019 / D-020** — food and external peer-support adapters; manual/fake only.
- **D-021 / D-023 / D-024** — workload envelope, performance SLOs, and recovery
  objectives; the resilience harness refuses to emit a numeric target and records
  the restore rehearsal `BLOCKED` (Slice 11 items 1–4, 8).
- **D-007** — idempotency/event retention window; `expires_at` columns exist but
  no reaper runs (Slice 2 item 2).
- **D-009 / D-014 / D-015** — coverage hours, location basis, and veteran-visible
  field sets; conservative/absent renderings (Slices 5, 6, 10).
- **D-022** — durable production queue vendor; the durable-job seam supplies a
  declared non-durable fake in LOCAL/TEST and refuses in STAGING/PRODUCTION
  (Slice 8 item 1).
- **D-001** — hosting/staging; drills run in `TEST`, no staging deployment exists
  (Slice 11 items 5, 9, 10).
- **D-025** — sensitive aggregate reporting stays disabled.
- **Provider webhook authentication** (Slice 7 item 4; Slice 8 item 6) — no
  signature scheme without a released provider webhook contract; callback handlers
  dedupe and refuse regressions but are not exposed as authenticated endpoints.

### 5.C Implementation-mechanism choices awaiting spec confirmation

Made under `HANDOFF.md` §11 where the released text is silent; documented in code
and in the cited slice records. Representative items:

- Production-data detection deny-list; `/health` and `/admin/build-info` surfaces
  not in the released API contract; PRODUCTION boot refusal (Slice 1 items 1–4).
- Concurrent in-flight idempotency retry answered as `409 IDEMPOTENCY_CONFLICT`;
  caller-owned terminal-vs-retryable classification; payload/result size bounds
  (Slice 2 items 1, 3, 4).
- Tenant-at-sign-in resolution; `suas_admin_grants` representation; all auth
  constants `INFERRED` pending released values (Slice 3 items 1, 2, 3).
- Closed system-basis list; purpose-matching not mechanical; no cascade on
  trusted-contact removal (Slice 4 items 3, 5, 7).
- "Blocking" Service Request definition; `ACTIVATE` command naming; org-admin
  scoping on case edges (Slice 5 items 1, 2, 6).
- `RESCHEDULED`/`ESCALATED` transition readings; `responsible_type` enum;
  Settlement summary shape (Slice 6 items 1, 3, 4, 6).
- Capability vocabulary reconciliation; `PARTIAL` fulfillment trigger; freshness
  bands; inactive-not-assignable at the router (Slice 7 items 2, 3, 6, 7).
- Notification template/policy/dedupe-scope vocabulary; retry/backoff bounds
  (Slice 8 items 2, 3, 4, 5).
- Effective-signal selection rule; incomplete-input behavior; questionnaire
  scoping; signal-driven case creation (Slice 9 items 2, 4, 6, 7).
- `RESPONDER_NOTIFIED` linkage; structured `contact_method`; responder on-duty
  store; chat/thread domain; pinned visual baseline; metric definitions (Slice 10
  items 1–4, 6–8).
- Rate-limited-to-manual routing rule; ambiguous-timeout drill; tenant fairness;
  real worker-restart drill (Slice 11 items 6, 7, 8, 10).

## 6. Readiness gates

All twelve gates in the released `STATUS.md` remain `NOT_READY`: `AUTH`,
`CONSENT`, `CHECK-IN`, `COORDINATION`, `EXTERNAL_FULFILLMENT`, `UI_CONFORMANCE`,
`SAFETY`, `PRIVACY`, `SCALE`, `RESILIENCE`, `OPERATIONS`, `REPORTING`. A gate
changes only with reproducible evidence under the specs' `TESTING.md`, recorded in
`STATUS.md` — not by this audit. Slices 10 and 11 document specifically why
`UI_CONFORMANCE`, `SCALE`, and `RESILIENCE` cannot advance (human accessibility
review and a pinned visual baseline; unreleased workload/SLO/recovery envelopes).

## 7. Completion determination

Against the `0.1.3` cut:

- **Every planned slice is implemented** with conformance records and a passing
  quality gate (§3, §4.6).
- **Every material gap is either fixed or returned to specs** (§5): the former
  load-bearing disclosure-projection blocker is now released and implemented for
  transportation and shelter; all remaining gaps are blocked on named unreleased
  decisions whose production surfaces stay unavailable, or are documented
  mechanism choices awaiting spec confirmation.
- **No availability boundary is upgraded and no gate advances** (§4.2, §6).

This satisfies the `SPEC017_PLAN.md` completion criterion as implementation
evidence. It is **not** a readiness declaration: the owner records SPEC-017
completion and any gate change in `STATUS.md` on accepted evidence, and SPEC-018
remains the required go/no-go stage before any real pilot or production operation.

### Recommended owner follow-ups (spec-side, not implementation)

- Confirm or correct the §5.C mechanism choices so they become released rules
  rather than implementation inferences.
- Prioritize the decisions that unblock the most implementation: D-011 (Support
  Signal scoring + golden vectors) and D-019/D-020 (remaining capability
  disclosure contracts).
- For gate movement, supply the `TESTING.md` evidence artifacts the harness cannot
  produce without released envelopes (D-021/D-023/D-024) and a pinned MVP visual
  baseline.
