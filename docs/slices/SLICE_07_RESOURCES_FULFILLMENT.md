# Slice 7 — Resources / fulfillment: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 7: Resource, Referral, ServiceProvider,
ProviderAdapterConfiguration, FulfillmentAttempt, ServiceFulfillment, Provider
Router, and Manual/Fake adapters. Real providers remain unavailable and
manual-only.

**This slice is deliberately incomplete in one respect**, for the reason given in
§10: no released capability projection contract exists, so every
externally-transmitting path fails closed. Manual coordination — which the
release explicitly makes first-class — works end to end.

## 1. Released spec citations

| Spec                       | Sections relied on                                                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FULFILLMENT.md`           | §1 purpose, §2 states, §3 attempts, §3.1 attempt status, §3.2 idempotency, §3.3 unknown outcome, §4 provider-neutral execution, §5 mapping to Service Request, §6 confirmation, §7 failure/reroute, §8 webhooks, §9 concurrency, §11 events, §12 testability, §13 non-goals |
| `PROVIDER_INTEGRATIONS.md` | §1 purpose, §2 governing invariants 1-10, §3 integration modes, §4 capability ports, §6 offer shape, §7 fulfillment modes, §8 status normalization, §9 attempt identity, §10 concurrency, §11 webhooks, §12 resilience, §13 privacy projection, §14 configuration           |
| `RESOURCES.md`             | §1-§11                                                                                                                                                                                                                                                                      |
| `REFERRALS.md`             | §1-§9                                                                                                                                                                                                                                                                       |
| `CONSENT.md`               | §3.7 referral send, §3.8 provider disclosure, §3.9 minimum fields, §3.10-§3.11 re-evaluation on reroute, §5 disclosure audit                                                                                                                                                |
| `PRIVACY.md`               | §4 provider disclosure boundary                                                                                                                                                                                                                                             |
| `DATA_MODEL.md`            | §7 requests/providers/fulfillment, §8 referrals, §14 rules 7-8, 16                                                                                                                                                                                                          |

## 2. Change map — file to spec section

| Path                                        | Implements                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/0007_resources_fulfillment.sql` | `DATA_MODEL.md` §7-§8; `FULFILLMENT.md` §2-§3; `PROVIDER_INTEGRATIONS.md` §3, §7-§9, §12; `RESOURCES.md` §2, §7; `REFERRALS.md` §2-§3 |
| `src/fulfillment/port.ts`                   | `PROVIDER_INTEGRATIONS.md` §1-§4, §7-§8, §12; `FULFILLMENT.md` §3.1, §4                                                               |
| `src/fulfillment/adapters.ts`               | `PROVIDER_INTEGRATIONS.md` §1-§3, §7; `FULFILLMENT.md` §4; `ADMIN.md` §3                                                              |
| `src/fulfillment/attempts.ts`               | `FULFILLMENT.md` §1-§3, §5-§7, §9; `PROVIDER_INTEGRATIONS.md` §9-§10                                                                  |
| `src/fulfillment/router.ts`                 | `PROVIDER_INTEGRATIONS.md` §2, §10, §12-§13; `FULFILLMENT.md` §3.2-§3.3, §7; `CONSENT.md` §3.8, §3.10-§3.11, §5                       |
| `src/fulfillment/resources.ts`              | `RESOURCES.md` §1-§11                                                                                                                 |
| `src/fulfillment/referrals.ts`              | `REFERRALS.md` §1-§7; `CONSENT.md` §3.7                                                                                               |

## 3. Design decisions worth review

**Manual coordination needs no projection, and that is the whole point.** A
manual adapter transmits nothing — a responder acts by phone — so no consent
projection applies. The router asks each adapter whether it transmits externally
and only then evaluates consent and builds a projection. This is what keeps
PROVIDER_INTEGRATIONS.md §2 rule 8 satisfiable while the capability contracts are
unreleased: manual paths work today, API paths fail closed.

**The fake adapter declares itself as transmitting.** It could have been modelled
as harmless, but then the consent and projection path would never be exercised.
It goes through the full gate and reaches no network.

**One port, parameterised by capability.** FULFILLMENT.md §4 names four ports and
says interface names may vary but semantics must not; four identical interfaces
would only invite drift.

**Attempt identity is the concurrency control.** A partial unique index allows at
most one non-terminal attempt per Service Request, so two workers cannot allocate
the same logical attempt, while a terminal attempt frees the slot for a
documented reroute.

**An ambiguous failure records `PROVIDER_UNKNOWN`, never failure.** Assuming
failure is what produces the second ride. A subsequent attempt is refused until
the unknown one is reconciled, and reconciliation reuses the original idempotency
key so it cannot book twice.

**Provider acceptance creates an `ACCEPTED` ServiceFulfillment and moves no
Service Request.** FULFILLMENT.md §1 and §5 keep those separate, and there is a
test asserting the request is still `CREATED` after a provider says yes.

**Two released vocabularies are mapped explicitly.** DISPATCH.md §7 names MVP
categories (`FOOD`, `SHELTER`…) while ARCHITECTURE.md §11 names capability ports
(`FoodSupportPort`, `TemporaryShelterPort`…). The mapping is stated once rather
than assumed at each call site; the divergence is returned to specs.

## 4. Evidence

`npm run verify` runs format check, lint, typecheck, and 482 tests (23 files),
40 of them added by this slice. Integration tests run against PostgreSQL 17.

| Invariant                                                                             | Evidence                                |
| ------------------------------------------------------------------------------------- | --------------------------------------- |
| Manual coordination fulfils with no consent projection at all                         | `tests/integration/fulfillment.test.ts` |
| Every MVP capability has a working manual path                                        | same file                               |
| A transmitting adapter without a consent grant is refused, and never called           | same file                               |
| A consented transmitting adapter is still refused while no projection contract exists | same file                               |
| With a contract registered, only contracted fields reach the adapter                  | same file                               |
| A revoked grant stops the next disclosure; a prior attempt grants nothing             | same file                               |
| The disclosure audit records field names, not values                                  | same file                               |
| Attempt idempotency keys are stable and attempt-scoped                                | same file                               |
| A second attempt is refused while one is in flight                                    | same file                               |
| A reroute creates a new attempt on the same Service Request                           | same file                               |
| An ambiguous failure records `PROVIDER_UNKNOWN`, not failure                          | same file                               |
| Another attempt is refused until the unknown one is reconciled                        | same file                               |
| Reconciliation reuses the original idempotency key                                    | same file                               |
| Disabled, `UNAVAILABLE`, and `MISCONFIGURED` adapters are not routed to               | same file                               |
| An unavailable API adapter degrades to manual coordination                            | same file                               |
| Routing respects priority and never crosses tenants                                   | same file                               |
| Confirmation without a veteran or responder actor is refused                          | same file                               |
| A responder-only confirmation requires a recorded reason                              | same file                               |
| A dispute moves to `DISPUTED`, never `CONFIRMED`                                      | same file                               |
| Provider acceptance does not fulfil the Service Request                               | same file                               |
| Freshness bands are correct at the released day boundaries                            | same file                               |
| A Resource cannot be activated without verification evidence                          | same file                               |
| Verification is audited only — no Resource Domain Event is invented                   | same file                               |
| A replayed verification is idempotent                                                 | same file                               |
| Unknown integration modes and categories are rejected                                 | same file                               |
| Catalog search is tenant-scoped, capped, and warns on stale                           | same file                               |
| The veteran Resource projection excludes internal fields                              | same file                               |
| A Referral draft discloses nothing and evaluates no consent                           | same file                               |
| A send without a covering grant is refused                                            | same file                               |
| A replayed send does not re-evaluate consent or disclose again                        | same file                               |
| Undocumented Referral transitions are refused                                         | same file                               |
| A Referral does not fulfil a Service Request                                          | same file                               |

## 5. Environment and configuration changes

None. The four adapter-mode variables from Slice 1 (`manual|fake|disabled`)
already describe exactly what this slice implements.

## 6. Migration notes

`0007_resources_fulfillment.sql` adds seven tables (`service_providers`,
`resources`, `provider_adapter_configurations`, `referrals`,
`fulfillment_attempts`, `service_fulfillments`, `provider_webhook_deliveries`)
and six enum types. `EXPECTED_SCHEMA_VERSION` moves from 6 to 7.

**No credential column exists anywhere in this migration.** RESOURCES.md §2 and
DATA_MODEL.md §14 rule 16 both forbid provider secrets in domain tables, and
ADMIN.md §3 permits only a presence indicator, which is deployment configuration.

Two constraints carry released invariants rather than convention: an active
Resource must have verification evidence, and a `CONFIRMED` fulfillment must have
a veteran or responder confirmation timestamp.

## 7. Idempotency and failure behavior

- Each attempt carries a stable key derived from its own immutable identity; retries reuse it and a deliberate provider switch produces a new one.
- A partial unique index permits one non-terminal attempt per request.
- An adapter throw becomes `PROVIDER_UNKNOWN` with the failure text retained, and blocks further attempts until reconciled.
- Referral send is keyed by a unique send identity, and the replay path returns before consent is even re-evaluated, so a retry cannot disclose twice.
- Resource verification deduplicates on an optional idempotency key so a replay does not fabricate verification history.
- A provider outage produces `NoRoutableAdapterError` with the Service Request untouched, per PROVIDER_INTEGRATIONS.md §2 rule 6.

## 8. Security and privacy impact

- No provider credential is stored, logged, or exposed by any surface in this slice.
- The projection is built by the router and handed to the adapter; an adapter cannot reach back for more, which is what makes the minimum-necessary rule enforceable.
- Passing a forbidden category into the projection is refused rather than filtered, so a caller who hands over a whole Support Case is corrected.
- Disclosure Audit Events record field names and categories only; a test asserts a disclosed address value does not appear.
- The veteran Resource projection excludes eligibility notes, verification internals, and adapter identifiers.
- Consent is re-evaluated per attempt, so a prior disclosure never authorizes a later one to a different adapter.

## 9. Availability boundaries preserved

No real provider is reachable and none can be configured: the released adapter
modes are manual, fake, and disabled, and no vendor is named anywhere in code or
schema. Webhook ingress has a dedup table but no handler — PROVIDER_INTEGRATIONS.md
§11 requires authenticated signatures, and no provider means no signature scheme
to authenticate against. Funding and billing remain absent entirely: there is no
cost, payment, or eligibility field beyond the informational `cost` text
RESOURCES.md §2 permits.

## 10. Semantic gaps returned to `SUAS-specs`

1. **Still the blocker: no released per-capability disclosure projection.** Carried forward from Slice 4 §10 item 1 and now load-bearing. PROVIDER_INTEGRATIONS.md §13 requires the capability contract to identify each disclosed field and its Consent Grant purpose; v0.1.1 defines none. Every externally-transmitting adapter path therefore fails closed, proven by test. The router, the fake adapter, the consent gate, and the projection mechanism are all built and exercised against a test-only contract, so releasing the four contracts is the only remaining work for API-backed fulfillment.
2. **The specs name the same four capabilities twice.** DISPATCH.md §7 uses `FOOD`, `TRANSPORTATION`, `SHELTER`, `PEER_SUPPORT`; ARCHITECTURE.md §11 and FULFILLMENT.md §4 use `FoodSupportPort`, `TransportationPort`, `TemporaryShelterPort`, `PeerSupportPort`. Mapped explicitly in `src/fulfillment/port.ts`. Worth reconciling to one vocabulary.
3. **`PARTIAL` fulfillment has no released trigger.** FULFILLMENT.md §2 and §5 define the state and its Service Request mapping, but nothing says who declares partial fulfillment or on what evidence. The state exists; no command sets it.
4. **Webhook authentication cannot be implemented.** §11 requires signature verification and §8 requires normalization, but with no provider selected there is no signature scheme, no secret, and no vendor status vocabulary to normalize from. The dedup table and normalized-status column exist so a handler has somewhere to land.
5. **`ProviderOffer` is modelled only as adapter output.** PROVIDER_INTEGRATIONS.md §6 gives a full shape including `estimated_cost`, `funding_required`, and `expires_at`, but §6 also says an offer is not assignment or fulfillment, and no released workflow consumes one. Offers are not persisted; the normalized outcome carries what the attempt needs. Confirm whether offers need durable storage before the search and select workflow exists.
6. **Resource freshness bands are operational recommendations.** RESOURCES.md §3 gives 30 and 90 days and calls them operational rather than legal claims. Implemented as constants; the boundary behavior is tested. Confirm they are stable enough to encode.
7. **"Inactive is not newly assignable" is not enforced at the router.** RESOURCES.md §7 requires it, but a Resource and an adapter configuration are separate records and no released rule links a routed adapter back to a catalog Resource. `InactiveResourceError` exists for the selection path that Slice 10 will build; the router currently routes on adapter configuration alone.

## 11. Readiness statement

The `EXTERNAL_FULFILLMENT` gate requires "provider adapter/manual/idempotency/
reconciliation suites green" (`TESTING.md` §11). The manual, idempotency, and
reconciliation suites are green. The provider-adapter conformance suite in
`TESTING.md` §5 **cannot** be fully green: items 2, 10, and 13 depend on a
released capability projection that does not exist. The gate does not advance,
and readiness is recorded in `STATUS.md` on accepted evidence rather than claimed
here. No pilot or production operation is authorized. SPEC-018 remains the only
path to go-live.
