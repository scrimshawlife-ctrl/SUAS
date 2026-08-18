# Slice 3 — Identity / tenancy / authorization: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 3: User, Organization, Membership, the
passwordless auth abstraction, shared session revocation semantics, the
privileged MFA boundary, tenant isolation, and role + tenant + row
authorization. Consent is the fourth authorization input and belongs to Slice 4;
it is present here only as a fail-closed seam.

Production auth, email, and SMS providers remain unavailable. Every delivery and
factor path in this slice is a fake or test seam with no external effect.

## 1. Released spec citations

| Spec              | Sections relied on                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH.md`         | §1 purpose, §2 veteran authentication, §3 challenge contract, §4 responder/administrator authentication, §5 session model and invalidation triggers, §6 membership/role inputs, §8 audit, §9 provider-neutral delivery, §10 non-goals, §11 testability |
| `SECURITY.md`     | §2 required controls (RBAC, tenant isolation, row-level authz, MFA, secrets, rate limits, sessions, audit, deletion, no sensitive data in logs), §5 threat categories, §7 testability                                                                  |
| `DOMAIN_MODEL.md` | §2 User, Organization, OrganizationMembership                                                                                                                                                                                                          |
| `DATA_MODEL.md`   | §2 identity/authentication/organization, §13 required access paths, §14 rules 1, 3, 4                                                                                                                                                                  |
| `ADMIN.md`        | §1 Org Admin ≠ SUAS Admin, §2 SUAS System Administrator                                                                                                                                                                                                |
| `ONBOARDING.md`   | §3 (SUAS-admin is globally bound, not org-bound)                                                                                                                                                                                                       |
| `API.md`          | §2 version prefix, §4 authorization and tenancy, §6 error bodies                                                                                                                                                                                       |
| `ENVIRONMENT.md`  | §3 auth/session secret, §5 required secrets for an enabled capability, §6 secret classes                                                                                                                                                               |

## 2. Change map — file to spec section

| Path                                   | Implements                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `migrations/0003_identity_tenancy.sql` | `DATA_MODEL.md` §2, §13, §14 rule 1; `DOMAIN_MODEL.md` §2; `AUTH.md` §3, §5, §6         |
| `src/identity/users.ts`                | `DOMAIN_MODEL.md` §2 "User"; `AUTH.md` §2, §6; `SECURITY.md` §2 deletion                |
| `src/identity/organizations.ts`        | `DOMAIN_MODEL.md` §2; `AUTH.md` §6; `ADMIN.md` §1, §4                                   |
| `src/identity/admins.ts`               | `AUTH.md` §6; `ADMIN.md` §1-§2; `ONBOARDING.md` §3                                      |
| `src/auth/constants.ts`                | `AUTH.md` §3, §5 (documented constants, labelled `INFERRED`)                            |
| `src/auth/secrets.ts`                  | `AUTH.md` §3, §5; `SECURITY.md` §2; `ENVIRONMENT.md` §6                                 |
| `src/auth/rate-limit.ts`               | `AUTH.md` §3, §11; `SECURITY.md` §2; `API.md` §6 (429)                                  |
| `src/auth/delivery.ts`                 | `AUTH.md` §2, §9; `ENVIRONMENT.md` §3; `ARCHITECTURE.md` §11                            |
| `src/auth/challenge.ts`                | `AUTH.md` §2, §3, §8, §9; `DATA_MODEL.md` §14 rule 3                                    |
| `src/auth/session.ts`                  | `AUTH.md` §5, §10; `SECURITY.md` §2                                                     |
| `src/auth/mfa.ts`                      | `AUTH.md` §4; `SECURITY.md` §2; `ENVIRONMENT.md` §2                                     |
| `src/authz/context.ts`                 | `AUTH.md` §1, §5, §6; `API.md` §4                                                       |
| `src/authz/policy.ts`                  | `AUTH.md` §1, §6; `SECURITY.md` §2, §5; `API.md` §4                                     |
| `src/http/authenticate.ts`             | `API.md` §4; `AUTH.md` §5                                                               |
| `src/http/routes/auth.ts`              | `API.md` §2-§4, §6; `AUTH.md` §2-§5, §8                                                 |
| `src/http/server.ts`                   | `API.md` §6 (validation failures are 400); `ENVIRONMENT.md` §8 (admin-gated provenance) |
| `src/config/schema.ts`                 | `ENVIRONMENT.md` §5 (session secret is now a required secret)                           |

## 3. Design decisions worth review

**Tenant consistency is a database guarantee, not a convention.** `users` and
`organizations` carry unique `(id, tenant_id)` keys, and `organization_memberships`
and `sessions` reference them with composite foreign keys. A membership linking a
user and an organization from different tenants cannot be written at all
(DATA_MODEL.md §14 rule 1).

**Sessions are resolved from PostgreSQL on every request, with no cache.**
AUTH.md §5 permits a process-local cache only if revocation correctness is
preserved. The simplest mechanism that satisfies the horizontal-scaling
invariant is not to have one. User status, memberships, and the admin grant are
all re-read per request, so a revoke is enforced on every instance immediately.

**Challenge verification runs under a row lock.** `SELECT … FOR UPDATE`
serializes concurrent verifies of one challenge, which is what makes AUTH.md §3's
concurrency rule hold: three simultaneous verifies produce exactly one success.

**Rate-limit counters live in the database.** AUTH.md §3 states plainly that
process-local counters are not authoritative production controls. There is a test
that exhausts the budget through one pool and confirms a second pool — standing
in for another instance — is still refused.

**A disabled channel is reported unavailable, never faked.** AUTH.md §9 is
explicit, so `issueChallenge` refuses before writing anything: no challenge row is
created for a channel that cannot deliver.

**Stored credentials are keyed HMACs, not bare hashes.** A six-digit OTP has too
little entropy for an unkeyed digest to protect if the database leaks, so
`SUAS_SESSION_SECRET` is required to check a candidate. This is what makes the
secret a required capability secret under ENVIRONMENT.md §5.

**The SUAS-admin role is an explicit grant, not a boolean.** ADMIN.md requires
audit, and AUTH.md §6 forbids self-service elevation, so the grant records who
granted it, who revoked it, and when.

**A SUAS admin does not implicitly satisfy an organization role.** ADMIN.md §2
reserves cross-org action for audited break-glass paths, not routine responder
ownership, so `assertOrganizationRole` refuses a global admin who holds no
membership.

## 4. Evidence

`npm run verify` runs format check, lint, typecheck, and 261 tests (17 files),
106 of them added by this slice. Integration tests run against PostgreSQL 17.

| Invariant                                                                                         | Evidence                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A user needs at least one enrolled channel                                                        | `tests/integration/identity.test.ts`                         |
| Contact identifiers are unique per tenant, and lookups do not cross tenants                       | same file                                                    |
| Soft-delete preserves the row so historical actor ids resolve                                     | same file                                                    |
| A membership cannot span two tenants                                                              | same file — "tenant consistency is enforced by the database" |
| A revoked membership, or a suspended organization, drops authority at once                        | same file                                                    |
| An invited membership is not active                                                               | same file                                                    |
| The global admin role is granted explicitly, at most once, and lapses when the user is not active | same file                                                    |
| No organization role confers the global role                                                      | same file; `tests/unit/authz-policy.test.ts`                 |
| Challenge secrets are stored hashed                                                               | `tests/integration/auth.test.ts`                             |
| A verified challenge cannot be replayed                                                           | same file                                                    |
| Three concurrent verifies of one challenge yield exactly one success                              | same file                                                    |
| Wrong codes are counted and exhaust the challenge                                                 | same file                                                    |
| Expired challenges are refused                                                                    | same file                                                    |
| An unenrolled or suspended destination is not issued a challenge, and the caller cannot tell      | same file; `tests/integration/http-auth.test.ts`             |
| A challenge from another tenant does not verify                                                   | same file                                                    |
| A disabled channel refuses issuance and writes no challenge                                       | same file; `tests/unit/auth-primitives.test.ts`              |
| The rate limit is shared, and survives rotating to another instance                               | `tests/integration/auth.test.ts`                             |
| Rate-limit errors do not echo the destination                                                     | same file                                                    |
| Sessions store only a credential hash                                                             | same file                                                    |
| Revoked, expired, and idle sessions are refused; idle ones are revoked, not just rejected         | same file                                                    |
| A suspended user cannot act on a previously valid session                                         | same file                                                    |
| Revocation on one instance is enforced on another                                                 | same file                                                    |
| Sessions start unelevated; elevation expires before the session does                              | same file                                                    |
| The authorization context re-reads memberships, and derives tenant from the session               | same file                                                    |
| Auth actions are audited without copying the destination into the payload                         | same file                                                    |
| Cross-tenant access is denied as 404, without leaking existence                                   | `tests/unit/authz-policy.test.ts`                            |
| Roles are checked per organization; deny by default when no authority is named                    | same file                                                    |
| Privileged actions require MFA elevation                                                          | same file                                                    |
| Consent-based decisions fail closed until Slice 4                                                 | same file                                                    |
| Auth constants are all labelled `INFERRED`                                                        | `tests/unit/auth-primitives.test.ts`                         |
| The MFA test factor is single-use and PRODUCTION refuses to supply one                            | same file                                                    |
| The full sign-in, elevate, and logout path works over HTTP                                        | `tests/integration/http-auth.test.ts`                        |
| Malformed requests return the released 400 `VALIDATION_FAILED`                                    | same file                                                    |
| Build-info requires a SUAS admin with an elevated session                                         | `tests/integration/http.test.ts`                             |

## 5. Slice 1 gap closed

Slice 1 §9 item 2 flagged that `GET /api/v0/admin/build-info` had no admin
authorization and was therefore registered only outside PRODUCTION. It is now
registered in every environment class and requires the SUAS-admin role on an
MFA-elevated session, with tests for the unauthenticated, non-admin, and
unelevated cases. The underlying specification question — whether provenance
belongs on an authenticated admin resource, an unauthenticated operations
endpoint, or no HTTP surface at all — remains open with specs.

## 6. Environment and configuration changes

`SUAS_SESSION_SECRET` is now **required in every environment class**, where it was
previously required only in STAGING and PRODUCTION. This is ENVIRONMENT.md §5's
"required secrets are absent for an enabled capability" rule taking effect:
authentication became an enabled capability in this slice, and the secret keys
challenge and session credential hashing.

`.env.example` still ships the slot empty and documents how to generate one. CI
generates a throwaway value per run rather than committing one. No other released
variable changed.

## 7. Migration notes

`0003_identity_tenancy.sql` is additive: seven tables (`users`, `organizations`,
`organization_memberships`, `suas_admin_grants`, `auth_challenges`, `sessions`,
`auth_rate_limits`), seven enum types, and the indexes backing the DATA_MODEL.md
§13 access paths. `EXPECTED_SCHEMA_VERSION` moves from 2 to 3.

No destructive step. Deletion is soft-delete only, and nothing purges: retention
remains D-007 `DECISION_PENDING`. Rate-limit counters are abuse-control state
rather than business facts, so `pruneRateLimits` exists for elapsed windows; it is
not wired to a schedule and is not event retention.

The `tenant_id` columns added by Slice 2 for events remain without foreign keys.
Backfilling them against `users`/`organizations` would require deciding what an
event's tenant means for pre-tenant enrollment, which is one of the questions
returned below.

## 8. Security and privacy impact

- No credential is stored in recoverable form: challenge secrets and session credentials are keyed HMACs, and the raw session credential is returned exactly once.
- Constant-time comparison is used for credential checks.
- Verification failures are uniform: a wrong code, an expired challenge, a consumed challenge, and an unknown destination are indistinguishable to the caller, with a test asserting the responses are byte-identical.
- Challenge issuance answers identically for enrolled and unenrolled destinations, so the endpoint cannot enumerate veterans.
- Rate-limit errors name the bucket, never the subject, so they cannot echo a veteran's address.
- Audit Events record auth outcomes without copying the destination into the payload; a test asserts the address does not appear.
- Session rejection reasons are logged for operators but never returned to the caller.
- Cross-tenant denials return 404 rather than 403, so existence does not leak.

## 9. Availability boundaries preserved

No real auth, email, or SMS vendor is reachable. Delivery is a fake or sink port
selected from the released communication modes, and configuration cannot name a
vendor because the config schema rejects those values. The MFA factor is a test
factor that PRODUCTION refuses to supply, so a privileged session can never be
elevated by a stand-in outside the synthetic environment classes. No consent
evaluation is faked: disclosure-class decisions raise rather than default to
allow.

## 10. Semantic gaps returned to `SUAS-specs`

1. **How is a veteran's tenant resolved at sign-in?** Contact identifiers are unique per tenant (DATA_MODEL.md §2 scopes users by tenant), so a destination alone does not identify a user. The challenge endpoints therefore take `tenant_id` from the client, which is unsatisfying for a veteran-facing sign-in. Specs should say whether the pilot is single-tenant, whether tenant is derived from the client/deployment, or whether contact identifiers are globally unique after all.
2. **The SUAS-admin role has no released representation.** AUTH.md §6 and ONBOARDING.md §3 establish that it is global and distinct, but DATA_MODEL.md §2 names no table or column for it. Implemented as an auditable `suas_admin_grants` table. Confirm the representation, and say whether the grant is tenant-independent (as implemented) or scoped.
3. **Every auth constant is `INFERRED`.** AUTH.md §3 requires the challenge TTL to be an explicit documented constant and leaves the value `DECISION_PENDING`; §5 defers session idle and absolute timeouts to "accepted constants" that do not exist. Values are gathered and labelled in `src/auth/constants.ts`: challenge TTL 10 minutes, 5 attempts, session 12 hours absolute and 2 hours idle, MFA elevation 15 minutes, and the issue/verify rate budgets. All need released values.
4. **User enumeration is not addressed by the released text.** AUTH.md §9 forbids faking delivery success, which is implemented, but says nothing about whether an issuance endpoint may reveal that a destination is unenrolled. The implementation answers uniformly and records the distinction only in the Audit Event. Confirm this reading.
5. **A liveness endpoint and the provenance surface still have no released contract.** Carried forward from Slice 1: `API.md` §3 lists neither `/health` nor a build-info resource. Slice 3 has now gated build-info behind SUAS-admin plus MFA, which is the strictest reading; confirm or relax it.
6. **`ResponderProfile` is not implemented.** DOMAIN_MODEL.md §2 defines it with queue availability and capacity fields, but those belong to the coordination and responder-workflow slices. Flagged so its absence is not mistaken for an oversight.
7. **Recovery paths are unimplemented.** AUTH.md §7 leaves veteran lost-all-channel proofing and SUAS-admin dual-control break-glass `DECISION_PENDING`. Nothing in this slice implements recovery, so no undocumented identity-proofing bypass exists. A released contract is needed before recovery can be built.
8. **Event `tenant_id` has no foreign key.** Slice 2 wrote the column ahead of this slice. Whether Domain and Audit Events must reference a real tenant row — and what that means for the pre-tenant enrollment case DATA_MODEL.md §2 allows for challenges — is unresolved.

## 11. Readiness statement

This slice supplies most of the mechanism the `TESTING.md` §4 AUTH suite calls
for, but the `AUTH` readiness gate does **not** advance: §4 also requires recovery
behavior and MFA semantics that depend on decisions still open, and readiness is
recorded in `STATUS.md` on accepted evidence, not claimed by an implementation
PR. No pilot or production operation is authorized. SPEC-018 remains the only path
to go-live.
