# Slice 4 — Consent and privacy kernel: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 4: Consent Grants, use-time evaluation,
revocation, minimum-necessary projection, Trusted Circle visibility, and audit
paths. No coordination, notification, or provider integration: this slice
supplies the authority that those slices must ask for.

## 1. Released spec citations

| Spec                       | Sections relied on                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONSENT.md`               | §1 consent is first-class and not a boolean, §2 grant shape, §2.1 required MVP grants and non-implication, §3 evaluation rules 1-11, §4 revocation, §5 provider disclosure projection, §6 templates, §7 states, §8 events, §9 non-goals, §10 testability |
| `TRUSTED_CIRCLE.md`        | §1 membership grants no visibility, §2 lifecycle, §3 invite/accept, §4 the label is not a permission, §5 permissions live on grants, §6 consent dependencies, §7 transitions are audited, §8 responder access, §11 testability                           |
| `PRIVACY.md`               | §2 principles, §4 provider disclosure boundary, §7 testability, §10 retention and deletion                                                                                                                                                               |
| `PROVIDER_INTEGRATIONS.md` | §13 privacy and consent projection                                                                                                                                                                                                                       |
| `DOMAIN_MODEL.md`          | §4 TrustedContact, ConsentGrant, ConsentEvent                                                                                                                                                                                                            |
| `DATA_MODEL.md`            | §5 consent and trusted circle, §14 rule 1                                                                                                                                                                                                                |
| `API.md`                   | §4 (`403 CONSENT_DENIED`), §6 error bodies                                                                                                                                                                                                               |
| `EVENT_MODEL.md`           | §3 `CONSENT_GRANTED` / `CONSENT_REVOKED`, §4 Audit Events                                                                                                                                                                                                |
| `AUTH.md`                  | §1 authorization is role + tenant + row + consent/system basis                                                                                                                                                                                           |

## 2. Change map — file to spec section

| Path                                  | Implements                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `migrations/0004_consent_privacy.sql` | `DATA_MODEL.md` §5; `CONSENT.md` §2, §4, §6, §7; `TRUSTED_CIRCLE.md` §2          |
| `src/consent/vocabulary.ts`           | `CONSENT.md` §1, §2, §2.1, §3.5-§3.6, §7                                         |
| `src/consent/templates.ts`            | `CONSENT.md` §6; `ADMIN.md` §2                                                   |
| `src/consent/trusted-circle.ts`       | `TRUSTED_CIRCLE.md` §1-§7; `DOMAIN_MODEL.md` §4                                  |
| `src/consent/grants.ts`               | `CONSENT.md` §2, §4, §6, §7, §8; `PRIVACY.md` §2, §10                            |
| `src/consent/evaluate.ts`             | `CONSENT.md` §1, §3, §4, §5, §7, §8; `TRUSTED_CIRCLE.md` §6; `API.md` §4         |
| `src/privacy/projection.ts`           | `PRIVACY.md` §4; `CONSENT.md` §5, §9; `PROVIDER_INTEGRATIONS.md` §13             |
| `src/authz/policy.ts`                 | Slice 3's fail-closed placeholder removed; consent now has a real implementation |

## 3. Design decisions worth review

**No implication between scopes, anywhere.** CONSENT.md §2.1 says a YELLOW grant
does not imply ORANGE or RED, and `support_signal` does not imply
`checkin_answers`. There is deliberately no widening, hierarchy, or "covers"
helper in the vocabulary module for anything to call by accident. Matching is on
the exact tuple.

**Permission and scope pairings are validated on write.** A grant such as
`can_receive` + `checkin_answers` is rejected rather than stored, so a nonsensical
grant cannot sit in the table waiting to be matched.

**Membership is evaluated before grants.** TRUSTED_CIRCLE.md §6 requires it, and
it matters: a removed contact with a leftover active grant must be denied. The
evaluation checks the contact's status first and returns
`MEMBERSHIP_NOT_USABLE` before it ever looks for a grant.

**Nothing caches.** CONSENT.md §3.1 says evaluate at the moment of use and do not
cache "visible forever". Every call re-reads the veteran's status, the
membership, and the grant.

**Expiry is applied at use time, not only by a sweep.** A grant whose
`expires_at` has passed is refused by the evaluation query itself, so an
unswept row cannot authorize a disclosure. `expireDueGrants` exists to keep
stored status truthful and write `EXPIRED` history; it is not retention, and
deletes nothing.

**The denial message says nothing about the veteran's consent posture.** The
party being refused learns only that they are not authorized. The reason is
carried on the error object for logging and recorded in the audit trail.

**The provider projection registry ships empty and fails closed.** This is the
most consequential decision in the slice, and §10 item 1 explains why.

## 4. Evidence

`npm run verify` runs format check, lint, typecheck, and 308 tests (19 files),
48 of them added by this slice. Integration tests run against PostgreSQL 17.

| Invariant                                                                                                    | Evidence                                            |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| A grant cannot reference an unpublished template                                                             | `tests/integration/consent.test.ts` — "templates"   |
| A YELLOW grant does not authorize a RED alert                                                                | same file — "no implication between scopes"         |
| A `support_signal` grant does not reveal `checkin_answers` or `location`                                     | same file                                           |
| An unreleased permission/scope pairing is rejected on write                                                  | same file                                           |
| Grant allows notify; revoke denies the next one                                                              | same file — "revocation is the critical suite"      |
| Consent history survives revocation, and the grant row is not deleted                                        | same file                                           |
| Consent history is immutable to UPDATE and DELETE                                                            | same file                                           |
| Re-consent inserts a new grant rather than reviving the revoked row                                          | same file                                           |
| At most one active grant exists per permission tuple                                                         | same file                                           |
| An expired grant is denied at use time, before any sweep                                                     | same file                                           |
| The sweep records `EXPIRED` history                                                                          | same file                                           |
| An accepted contact with no grants sees nothing at all                                                       | same file — "membership is evaluated before grants" |
| An invited contact is denied even with an active grant                                                       | same file                                           |
| Suspended, removed, and revoked contacts are denied despite active grants                                    | same file                                           |
| An invite requires a contact channel                                                                         | same file                                           |
| Internal processing is allowed without a grant, but only when nothing leaves SUAS                            | same file — "system basis"                          |
| The internal basis is refused for a third-party grantee                                                      | same file                                           |
| Responder case-assignment basis cannot be established without an assignment verifier                         | same file                                           |
| A verified active assignment allows responder access; an unverified one denies                               | same file                                           |
| A suspended veteran's data is not disclosed                                                                  | same file — "enrollment and tenancy"                |
| A grant in another tenant does not match                                                                     | same file                                           |
| Allowed disclosures are audited with the consent basis and disclosed field names                             | same file — "audit paths"                           |
| Denied disclosures are audited too                                                                           | same file                                           |
| A `DENIED` ConsentEvent is written even when no grant ever existed                                           | same file                                           |
| Purely internal processing is not audited per evaluation                                                     | same file                                           |
| `requireDisclosure` returns the basis, or throws `403 CONSENT_DENIED` without describing the consent posture | same file                                           |
| No released projection contract exists for any capability, and building one is refused                       | `tests/unit/projection.test.ts`                     |
| A contract naming a forbidden category cannot be registered                                                  | same file                                           |
| A projection discloses only contracted fields and reports names, not values                                  | same file                                           |
| A source carrying a forbidden category is refused rather than silently filtered                              | same file                                           |

## 5. Slice 3 seam closed

Slice 3 installed `requireConsentBasis()`, which threw unconditionally so that no
disclosure could be assumed before this slice existed. It is removed. Callers now
use `requireDisclosure()` in `src/consent`, which performs the real use-time
evaluation and throws the same released `403 CONSENT_DENIED` when the answer is
no. The Slice 3 authorization test was rewritten to assert the thing that still
matters: passing a role, tenant, and row check says nothing about consent.

## 6. Environment and configuration changes

None. No new configuration variable, and no change to an existing one.

## 7. Migration notes

`0004_consent_privacy.sql` is additive: four tables
(`consent_template_versions`, `trusted_contacts`, `consent_grants`,
`consent_events`), six enum types, an append-only trigger on `consent_events`
reusing the guard from migration 0002, and the indexes backing use-time
evaluation. `EXPECTED_SCHEMA_VERSION` moves from 3 to 4.

No destructive step. Consent history is never deleted (CONSENT.md §4), and
retention remains D-007 `DECISION_PENDING`, so nothing purges.

`trusted_contacts` and `consent_grants` reference `users` with composite
`(user_id, tenant_id)` foreign keys, so a grant cannot span tenants.

## 8. Security and privacy impact

- Disclosure decisions are made at use time from authoritative state, so a revoke takes effect on the next evaluation on any instance.
- Denials are uniform and non-specific: the refused party is not told whether a grant exists, was revoked, expired, or never existed.
- Audit payloads record field **names** and categories, never values, per CONSENT.md §5. A test asserts a disclosed address value does not appear in the projection's field-name list.
- Consent history is append-only at the database level, so a revocation cannot be rewritten as though it never happened.
- Internal processing is deliberately not audited per evaluation: it discloses to no third party, and auditing every internal read would bury the disclosure records that matter.
- The projection module refuses a source object carrying a forbidden category rather than filtering it out, so a caller who passes a whole Support Case is corrected instead of quietly rescued.

## 9. Availability boundaries preserved

No provider disclosure can be built, because no released capability contract
exists to build one from. No consent template copy is shipped: bodies are
administrator-supplied, since CONSENT.md §6 marks the copy `NOT_COMPUTABLE`.
Nothing in this slice sends, notifies, or refers — those paths arrive in later
slices and must call `requireDisclosure()` before they do.

## 10. Semantic gaps returned to `SUAS-specs`

1. **No released per-capability disclosure projection exists, so provider disclosure is impossible by construction.** PROVIDER_INTEGRATIONS.md §13 and PRIVACY.md §4.2 define the categories an adapter must never receive, and §13 states that "the capability contract must identify the field and applicable Consent Grant purpose" — but v0.1.1 defines no field list for TRANSPORTATION, TEMPORARY_SHELTER, FOOD_SUPPORT, or PEER_SUPPORT. Inventing one would be inventing product semantics, so the registry ships **empty** and every capability fails closed. Slice 7 cannot build a real adapter disclosure until these contracts are released. This is the highest-priority gap in the slice.
2. **Grantee identity is untyped across grantee types.** CONSENT.md §2 gives `grantee_type` and `grantee_id` without saying what the id references per type. Implemented as opaque text: a `trusted_contact_id` for TRUSTED_CONTACT, a user id for RESPONDER, an organization id for ORGANIZATION, an adapter id for SERVICE_PROVIDER. Confirm, particularly whether a trusted-contact grant should key on the contact row or on a bound user.
3. **The system-basis list is closed by implementation, not by release.** CONSENT.md §3.5 and §3.6 describe two situations that authorize action without a grant; neither is given a name or an enumeration. Implemented as exactly `SYSTEM_INTERNAL_PROCESSING` and `RESPONDER_CASE_ASSIGNMENT`, with anything else denying. Specs should name the bases and say whether more exist.
4. **Whether internal processing must be audited per evaluation.** CONSENT.md §8 requires auditing "every evaluate-for-disclosure that returns allow or deny on third-party data". Internal system evaluation is therefore not audited per call here, though a `DENIED` ConsentEvent is still written on refusal. Confirm that reading.
5. **Purpose matching is not mechanically defined.** CONSENT.md §3.4 requires the purpose to match the action, but purpose is free text bound to a template, and the released text gives no matching rule. The implementation matches on permission and scope, and records the purpose string on the grant, the ConsentEvent, and the Audit Event without comparing it. A released purpose vocabulary would make §3.4 enforceable rather than advisory.
6. **Relationship label enum is `DECISION_PENDING`.** TRUSTED_CIRCLE.md §4 requires the label and leaves the enum open, so it is free text. It is explicitly not a permission and is never read by evaluation.
7. **Bulk revocation on contact removal is left to the caller.** TRUSTED_CIRCLE.md §7 says that if grants are bulk-revoked as part of removal, `CONSENT_REVOKED` is emitted per grant — but does not say whether removal _must_ revoke them. The implementation does not cascade, because §6 already denies a removed contact regardless of leftover grants, and cascading would destroy the veteran's ability to restore a relationship. Confirm.
8. **Consent template publication has no released admin surface yet.** Templates can be created and published through the module, but no HTTP admin endpoint exists; ADMIN.md §2 lists the surface without defining its API. Deferred rather than invented.

## 11. Readiness statement

The `CONSENT` readiness gate requires "use-time grant/provider-disclosure suites
green" (`TESTING.md` §11). The use-time grant suite is green. The
provider-disclosure suite **cannot** be green, because no released projection
contract exists to test an adapter against. The gate therefore does **not**
advance, and readiness is recorded in `STATUS.md` on accepted evidence rather
than claimed here. No pilot or production operation is authorized. SPEC-018
remains the only path to go-live.
