# Slice 5 — Coordination kernel: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 5: Support Case, CaseAssignment, Service
Request, responder one-winner claim and reassignment, Contact Attempt, and
explicit transition commands. Follow-Up and Settlement are Slice 6; provider
fulfillment is Slice 7. Both are present here only as fail-closed seams.

## 1. Released spec citations

| Spec                     | Sections relied on                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CASES.md`               | §1 purpose, §2 states, §3 creation and deduplication, §3.1 atomic creation invariant, §4 transitions, §4.1 escalation correction, §4.2 reopen, §5 atomic assignment and claim, §6 notes/requests/follow-up, §7 resolution and closure, §8 authorization, §9 queue, §10 non-goals, §11 testability |
| `DISPATCH.md`            | §1 purpose, §2 states, §3 command concurrency invariant, §4 transitions, §5 provider relationship, §6 assignment concurrency, §7 categories, §8 consent/privacy, §10 expiry, §11 non-goals, §12 testability                                                                                       |
| `RESPONDER_WORKFLOWS.md` | §2 named actions, §3 idempotency and stale-state protection, §4 queue contract, §5 claim behavior, §6 authorization, §7 contact log, §8 escalation, §9 events, §11 non-goals, §12 testability                                                                                                     |
| `EVENT_MODEL.md`         | §3 catalog, §3.3 `RESPONDER_CONTACT_LOGGED` payload                                                                                                                                                                                                                                               |
| `CONSENT.md`             | §3.6 responder case-assignment basis, §3.8, §3.10-§3.11 disclosure re-evaluation                                                                                                                                                                                                                  |
| `DOMAIN_MODEL.md`        | §5 cases and responder work                                                                                                                                                                                                                                                                       |
| `DATA_MODEL.md`          | §6, §7, §13, §14 rules 1 and 6                                                                                                                                                                                                                                                                    |
| `API.md`                 | §5 pagination, §6 conflict codes                                                                                                                                                                                                                                                                  |

## 2. Change map — file to spec section

| Path                                      | Implements                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `migrations/0005_coordination.sql`        | `CASES.md` §2, §3.1, §5, §9; `DISPATCH.md` §2, §7; `DATA_MODEL.md` §6, §7, §13, §14 rule 6 |
| `src/coordination/case-transitions.ts`    | `CASES.md` §2, §4, §4.1, §4.2, §10                                                         |
| `src/coordination/request-transitions.ts` | `DISPATCH.md` §2, §4, §7, §11                                                              |
| `src/coordination/cases.ts`               | `CASES.md` §3.1, §4, §5, §7; `EVENT_MODEL.md` §3; `CONSENT.md` §3.6                        |
| `src/coordination/contact.ts`             | `RESPONDER_WORKFLOWS.md` §2, §7; `EVENT_MODEL.md` §3.3; `CASES.md` §6                      |
| `src/coordination/requests.ts`            | `DISPATCH.md` §3, §4, §6, §7, §8; `CONSENT.md` §3.8, §3.10-§3.11                           |
| `src/coordination/queue.ts`               | `RESPONDER_WORKFLOWS.md` §4; `CASES.md` §9; `API.md` §5                                    |

## 3. Design decisions worth review

**Both state machines are data, not branching logic.** The released transition
tables are transcribed into arrays, and a single resolver is the only way a
status changes. An edge that is not written down cannot be reached, so
"only documented edges succeed" holds by construction rather than by review.

**The two edges the specs single out as mistakes are absent, and tested for.**
CASES.md §4.1 and §10 call out escalating an unassigned `OPEN`/`TRIAGED` case;
DISPATCH.md §5 and §12 call out jumping `ASSIGNED` straight to `FULFILLED`. There
are tests asserting no such edge exists in the table at all, not merely that one
call fails.

**Cancellation is an enumerated set.** DISPATCH.md §4 explicitly warns against
"a wildcard that accidentally permits `CLOSED` or invalid historical
transitions", so the seven cancellable states are listed individually.

**Contested commands hold a row lock for the whole check-and-write.** The
partial unique indexes (one non-closed case per veteran, one active assignment
per case) are a second line of defence, not the only one. Two concurrent claims
serialize on the lock; the second then finds a status with no documented
`CLAIM_CASE` edge and conflicts.

**Case creation races an index rather than reading first.** CASES.md §3.1
forbids relying on "read no case → insert". The insert uses `ON CONFLICT DO
NOTHING`; a loser resolves to the existing case, and only the winner emits
`CASE_CREATED`.

**Contact attempts deduplicate through the event store.** The command's
idempotency key rides on the Domain Event, so a replay resolves to the persisted
event and returns the original contact row instead of writing a second one —
reusing the Slice 2 kernel rather than inventing a parallel mechanism.

**A Case Note emits nothing.** EVENT_MODEL.md §3.3 says a note must not emit
`RESPONDER_CONTACT_LOGGED`, and there is a test that asserts the absence.

## 4. Evidence

`npm run verify` runs format check, lint, typecheck, and 410 tests (21 files),
102 of them added by this slice. Integration tests run against PostgreSQL 17.

| Invariant                                                                     | Evidence                                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Exactly the seven released case states, referenced nowhere else               | `tests/unit/coordination-transitions.test.ts`       |
| Only documented case edges succeed                                            | same file                                           |
| No `OPEN → ACTIVE` edge exists at all                                         | same file                                           |
| `ESCALATE` is refused from unassigned `OPEN`/`TRIAGED`                        | same file; `tests/integration/coordination.test.ts` |
| Escalation and reopen require a reason                                        | `coordination-transitions.test.ts`                  |
| Reopen is the only edge out of `CLOSED`                                       | same file                                           |
| No Service Request edge jumps assignment to fulfilled                         | same file                                           |
| A provider completion cannot auto-confirm                                     | same file                                           |
| Only `MATCHING → ASSIGNED` is marked externally disclosing                    | same file                                           |
| Cancellation and expiry edges are explicit sets                               | same file                                           |
| Reserved future categories are rejected, with a reason                        | same file                                           |
| One case is created under concurrent open attempts                            | `tests/integration/coordination.test.ts`            |
| A duplicate open resolves to the existing case, and `CASE_CREATED` fires once | same file                                           |
| A second non-closed case per veteran is refused                               | same file                                           |
| Concurrent claims produce exactly one winner and one active assignment        | same file                                           |
| `CASE_ASSIGNED` is emitted once per logical assignment                        | same file                                           |
| A stale queue claim conflicts safely, writing nothing                         | same file                                           |
| Reassignment releases the prior assignment and creates the successor          | same file                                           |
| Concurrent reassignment never leaves two active owners                        | same file                                           |
| A responder who is not the assigned one is refused                            | same file                                           |
| Resolve fails while no Settlement can exist                                   | same file                                           |
| Resolve fails while a non-terminal Service Request remains                    | same file                                           |
| Resolve succeeds once blocking work is terminal and a Settlement is verified  | same file                                           |
| Contact attempts require an active assignment                                 | same file                                           |
| `complete-contact` refuses a `PENDING` outcome                                | same file                                           |
| A replayed contact command does not duplicate the contact fact                | same file                                           |
| A Case Note emits no `RESPONDER_CONTACT_LOGGED`                               | same file                                           |
| An externally disclosing assignment without consent evaluation is refused     | same file                                           |
| A reroute re-evaluates disclosure for the new grantee                         | same file                                           |
| Concurrent assignment from `MATCHING` yields one winner                       | same file                                           |
| The queue never crosses tenants                                               | same file                                           |
| The queue is bounded, capped, and keyset-paginated                            | same file                                           |
| Ownership and status filters behave                                           | same file                                           |

## 5. Slice 4 seam closed

Slice 4 defined `RESPONDER_CASE_ASSIGNMENT` as a documented consent basis but
denied it unconditionally, because nothing could confirm an assignment existed.
`createAssignmentVerifier` supplies that confirmation, and there are tests
showing the consent kernel now allows responder access on that basis while an
assignment is active and denies it once the assignment is released.

## 6. Environment and configuration changes

None.

## 7. Migration notes

`0005_coordination.sql` is additive: five tables (`support_cases`,
`case_assignments`, `case_notes`, `contact_attempts`, `service_requests`), six
enum types, two partial unique indexes carrying the one-winner invariants, and
the indexes backing the queue paths. `EXPECTED_SCHEMA_VERSION` moves from 4 to 5.

No destructive step, and nothing purges: CASES.md §7 requires closure to retain
history, and retention remains D-007 `DECISION_PENDING`.

`support_cases` has no `current_settlement_id` column yet. DATA_MODEL.md §6
describes it as a convenience projection over Settlement history, so it belongs
with the settlements table in Slice 6 rather than dangling here.

## 8. Idempotency and failure behavior

- Every contested command validates state inside the same transaction that writes, so a loser produces no partial assignment, no partial transition, and no event.
- Concurrent claims, concurrent reassignments, and concurrent request assignments each resolve to one winner; the others receive `409` with a released conflict code.
- A replayed contact command returns the original contact fact.
- Stale-state conflicts are distinguished from illegal transitions, so a console can tell "someone else got there first" from "that was never a legal move".
- Resolve refuses rather than partially resolving when Settlement is unavailable or blocking work remains.

## 9. Security and privacy impact

- Queue reads take the tenant as a required argument rather than an optional filter, so a caller cannot omit it and read across tenants.
- Queue pagination is keyset-based and hard-capped at 100 rows, so no caller can pull an unbounded history.
- Case Notes are stored as sensitive free text and are never written to application logs, never emitted in an event payload, and already excluded from provider projections by the Slice 4 forbidden categories.
- The responder case-assignment consent basis is verified against a live active assignment on every evaluation, so a released assignment stops conferring access immediately.

## 10. Availability boundaries preserved

No provider is contacted: the externally disclosing edge refuses without a
consent evaluation, and Slice 4's projection registry still has no released
contract to build a disclosure from. No Settlement can be created, so no case can
reach `RESOLVED` in normal operation. No signal is computed; the priority column
is a queue label that nothing in this slice writes automatically.

## 11. Semantic gaps returned to `SUAS-specs`

1. **"Blocking" Service Request is not defined precisely.** CASES.md §7 requires blocking Service Requests to "satisfy the documented terminal rules" without naming them. Implemented as: any request not in `CLOSED`, `CANCELLED`, `EXPIRED`, or `UNFULFILLABLE` blocks resolution — which means a `CONFIRMED` request still blocks until it is closed. Confirm, particularly whether `CONFIRMED` should count as settled.
2. **`ACTIVATE` is an implementation-named command.** CASES.md §4 describes the `ASSIGNED → ACTIVE` edge as "first qualifying work action or explicit activate command" without naming the command or listing what counts as a qualifying work action. Implemented as an explicit `ACTIVATE` only; no action implicitly activates a case.
3. **Service Request expiry TTL is `DECISION_PENDING`.** DISPATCH.md §10 requires durable expiry work with an unspecified TTL. The `EXPIRE` edges exist and are stale-state protected, but no expiry job is scheduled, because scheduling one would require inventing the TTL. Slice 6 or a released TTL should close this.
4. **Case priority has no writer.** RESPONDER_WORKFLOWS.md §4 lists `priority_signal_level` as a queue filter, and CASES.md §3 allows a signal to update case priority "through a documented idempotent action" that is not specified. The column exists and is filterable; nothing sets it. Slice 9 owns Support Signals.
5. **Veteran visibility is `INFERRED` under D-015.** CASES.md §8.1 and PRIVACY.md §5 mark the veteran-visible field set as an MVP inference. No veteran-facing read path is implemented in this slice, so nothing depends on the inference yet; the Slice 10 UI will.
6. **Org-admin authority is not scoped in the transition table.** CASES.md §4 names Org-admin as an actor on several edges, and ADMIN.md §4 scopes an org admin to one Organization — but a Case carries a tenant and a veteran, not an organization, so there is no released rule tying a case to the org whose admin may act on it. The transition table records which actors may perform each edge; enforcing the organizational scope needs that link defined.
7. **Reopen does not create a new resolution cycle here.** CASES.md §4.2 says prior Settlement history stays immutable and a reopened cycle requires a new Settlement "as later data-model semantics specify". Reopen moves the status; cycle semantics belong to Slice 6.

## 12. Readiness statement

The `COORDINATION` gate requires "Case/Request/responder concurrency/state suites
green" (`TESTING.md` §11). Those suites are green for everything this slice owns.
The gate still does **not** advance: `TESTING.md` §3.4 folds Settlement and
Follow-Up behavior into the same readiness picture, and both are Slice 6, and
readiness is recorded in `STATUS.md` on accepted evidence rather than claimed by
an implementation PR. No pilot or production operation is authorized. SPEC-018
remains the only path to go-live.
