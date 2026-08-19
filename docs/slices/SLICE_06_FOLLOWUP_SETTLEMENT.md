# Slice 6 — Follow-Up / Settlement: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 6: stale-job schedule identity, blocking and
carry-forward classification, multi-cycle Settlement history, idempotent resolve,
and reopen behavior. Closes the Settlement seam Slice 5 left fail-closed.

## 1. Released spec citations

| Spec             | Sections relied on                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FOLLOWUP.md`    | §1 first-class work item, §2 states, §3 core fields, §4 retry semantics, §5 durable due/overdue jobs, §6 completion/reschedule/cancellation, §7 escalation, §8 Case interaction, §9 events, §10 non-goals, §11 testability |
| `SETTLEMENT.md`  | §1 purpose, §2 required content, §3 resolution-cycle history, §4 remaining Follow-Up semantics, §5 validation and idempotency, §6 veteran visibility, §8 events/audit, §9 non-goals, §10 testability                       |
| `CASES.md`       | §4 transitions, §4.2 reopen, §7 resolution and closure                                                                                                                                                                     |
| `DATA_MODEL.md`  | §6 follow_ups, §8 settlements, §14                                                                                                                                                                                         |
| `EVENT_MODEL.md` | §3 catalog (`FOLLOWUP_CREATED`, `FOLLOWUP_DUE`, `FOLLOWUP_COMPLETED`, `CASE_RESOLVED`)                                                                                                                                     |
| `API.md`         | §7 persistent idempotency                                                                                                                                                                                                  |

## 2. Change map — file to spec section

| Path                                      | Implements                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `migrations/0006_followup_settlement.sql` | `FOLLOWUP.md` §2, §3, §5; `SETTLEMENT.md` §2, §3, §8; `DATA_MODEL.md` §6, §8 |
| `src/settlement/follow-ups.ts`            | `FOLLOWUP.md` §2-§9; `SETTLEMENT.md` §4                                      |
| `src/settlement/settlements.ts`           | `SETTLEMENT.md` §2, §3, §6                                                   |
| `src/settlement/resolve.ts`               | `SETTLEMENT.md` §1, §4, §5; `FOLLOWUP.md` §8; `CASES.md` §7                  |
| `src/coordination/cases.ts`               | `resolveCase` seam removed; `CLOSE` now releases the active assignment       |
| `src/coordination/index.ts`               | resolution exports moved to the settlement module                            |

## 3. Design decisions worth review

**A stale job is stopped by a `schedule_version` predicate in the write itself,**
not by a read-then-check. FOLLOWUP.md §5.7 requires a reschedule to invalidate
old due-work identities; the reschedule bumps the version, so the old job's
`UPDATE ... WHERE schedule_version = $n` matches nothing and no-ops. The
suppression is audited, so a delayed scan stays observable (§5.6).

**Settlement history is a table of cycles.** SETTLEMENT.md §3.5 rejects one
mutable settlement row as a history model, and §9 forbids overwriting a prior
Settlement on reopen. The Case's `current_settlement_id` is a cache over that
history, and the deterministic projection is the highest `resolution_cycle`, not
an insertion-order scan (§3.6).

**A committed Settlement cannot be rewritten.** A database trigger rejects any
change to the resolution meaning — cycle, summaries, carried-forward references,
author, confirmation, settled time — while still permitting a later veteran
confirmation, which §2 makes optional and after the fact.

**Unclassified Follow-Ups are refused before blocking ones.** SETTLEMENT.md §4
says a Case cannot resolve with an unclassified open Follow-Up, and the
classification is what makes the blocking question answerable at all, so it is
checked first and reported distinctly.

**Only three Follow-Up Domain Events are emitted.** FOLLOWUP.md §9 puts OVERDUE,
RESCHEDULED, ESCALATED, and CANCELLED in the Audit Event category and says
additional Domain Event names require explicit catalog reconciliation. There is a
test asserting no `FOLLOWUP_OVERDUE` Domain Event exists and that the audit
record does.

**Resolve replays through the Slice 2 idempotency kernel** rather than a bespoke
mechanism, so a retried resolve returns the original Settlement instead of
opening a second cycle.

## 4. Evidence

`npm run verify` runs format check, lint, typecheck, and 442 tests (22 files),
36 of them added by this slice, with 4 Slice 5 tests relocated into it.
Integration tests run against PostgreSQL 17.

| Invariant                                                                           | Evidence                               |
| ----------------------------------------------------------------------------------- | -------------------------------------- |
| Creation without a valid due time or responsible party fails                        | `tests/integration/settlement.test.ts` |
| A due Follow-Up transitions once and emits one `FOLLOWUP_DUE`                       | same file                              |
| Duplicate job delivery emits one logical due fact                                   | same file                              |
| A rescheduled Follow-Up cannot be marked due or overdue by the old schedule version | same file                              |
| Completed and cancelled Follow-Ups ignore stale jobs                                | same file                              |
| A future Follow-Up is not marked due                                                | same file                              |
| No `FOLLOWUP_OVERDUE` Domain Event is invented; the audit record exists             | same file                              |
| Completion and cancellation are idempotent                                          | same file                              |
| Reschedule and cancellation require a reason                                        | same file                              |
| A cancelled Follow-Up cannot be completed                                           | same file                              |
| Job redelivery never increments the coordination attempt count                      | same file                              |
| Resolve refuses incomplete Settlement content, leaving the case unresolved          | same file                              |
| Resolve refuses without an active assignment                                        | same file                              |
| Resolve records the Settlement and `CASE_RESOLVED` carries the cycle                | same file                              |
| The Case caches the current Settlement without replacing history                    | same file                              |
| A stale resolve conflicts                                                           | same file                              |
| A replayed resolve yields one Settlement and one `CASE_RESOLVED`                    | same file                              |
| An unclassified open Follow-Up blocks resolution                                    | same file                              |
| A blocking open Follow-Up blocks resolution                                         | same file                              |
| A carried-forward Follow-Up resolves, recording owner and due date                  | same file                              |
| Resolution never auto-completes a carried-forward Follow-Up                         | same file                              |
| Close, reopen, and re-resolve produce cycle 2 with cycle 1 intact                   | same file                              |
| The current projection points at the latest cycle                                   | same file                              |
| A committed Settlement cannot be updated or deleted                                 | same file                              |
| A second Settlement for the same cycle is refused                                   | same file                              |
| The veteran projection excludes internal referenced records                         | same file                              |
| Blocking Service Requests still prevent resolution                                  | same file                              |

## 5. Slice 5 seam closed, and one behavior changed

`resolveCase` and its `SettlementVerifier` are gone. Resolution now lives in
`src/settlement/resolve.ts` and creates the Settlement itself, so the four Slice 5
resolution tests moved into this slice's suite and were expanded.

**`CLOSE` now releases the active case assignment.** Building the reopen test
surfaced a real defect: a closed case kept its active assignment, so after reopen
the case sat in `OPEN` still owned, and could never be claimed for the new cycle —
`CLAIM_CASE` requires no active assignment, and there is no released
`OPEN`-with-active-assignment state. Closing now releases ownership with reason
`CASE_CLOSED`; the assignment row is retained as history, per CASES.md §7. The
released text does not state this explicitly, so it is returned to specs below.

## 6. Environment and configuration changes

None.

## 7. Migration notes

`0006_followup_settlement.sql` adds two tables (`follow_ups`, `settlements`),
three enum types, the immutability trigger on settlements, and one nullable
column on `support_cases` (`current_settlement_id`).
`EXPECTED_SCHEMA_VERSION` moves from 5 to 6.

No destructive step. Settlement history is never deleted and nothing purges;
retention remains D-007 `DECISION_PENDING`.

`resolution_disposition` is deliberately nullable: NULL means "not yet
classified", which is the state SETTLEMENT.md §4 requires resolution to refuse.

## 8. Idempotency and failure behavior

- Due and overdue transitions are guarded by `(schedule_version, status, due_at)` predicates inside the write, so duplicate, stale, and out-of-order job delivery are all no-ops.
- Suppressed jobs write an audit record rather than failing silently.
- Completion and cancellation return an `already*` flag rather than throwing on replay.
- Resolve validates content before locking anything, so an incomplete Settlement never leaves a partially resolved case.
- Resolve with an idempotency key replays the original outcome; without one, a second resolve hits the case state machine and conflicts.
- Notification and queue retries are structurally unable to reach the coordination counter — only `recordCoordinationAttempt` writes it.

## 9. Security and privacy impact

- `veteranVisibleSettlement` drops the occurred summary and every internal actor identity, because SETTLEMENT.md §6 says referencing an internal record does not make it veteran-visible.
- Settlement summaries hold references and short statements rather than copied notes or provider payloads, per §2.
- Follow-Up reasons are stored but never emitted in a Domain Event payload.
- The settlement immutability trigger means a resolution cannot be quietly rewritten to say something else happened.

## 10. Availability boundaries preserved

No scheduler is registered. FOLLOWUP.md §5 requires durable async due/overdue
evaluation, and the durable job vendor remains D-022 open from Slice 1, so this
slice supplies `claimDueWork` plus the transition functions and leaves the
scheduling to whatever the released decision names. Nothing computes a signal,
contacts a provider, or sends a notification.

## 11. Semantic gaps returned to `SUAS-specs`

1. **`RESCHEDULED` as a resting status would strand a Follow-Up.** FOLLOWUP.md §2 lists it as a state, but a Follow-Up parked there would never be picked up by a due sweep that selects `SCHEDULED`. Implemented as: reschedule returns the status to `SCHEDULED` with a bumped `schedule_version`, and the reschedule is recorded as an audited fact. The enum value exists for schema fidelity but is never set. Specs should either confirm this reading or define the transition out of `RESCHEDULED`.
2. **Closing a Case has no released effect on its assignment.** Implemented as: `CLOSE` releases the active assignment, because otherwise a reopened case is `OPEN` and simultaneously owned, which no released state describes and which makes the case unclaimable. Please confirm.
3. **`ESCALATED` Follow-Up has no transition path.** FOLLOWUP.md §7 says escalation may occur from `OVERDUE` or through "an explicit authorized manual action defined by the owning workflow", which is not defined. The status exists in the enum and is treated as open, but no command sets it.
4. **The `responsible_type` enumeration is not released.** FOLLOWUP.md §3 requires `responsible_type`/`responsible_id` without listing the types. Implemented as the four actors §0 names: RESPONDER, VETERAN, ORG_ADMIN, SYSTEM.
5. **Coordination retry bound is `DECISION_PENDING`.** FOLLOWUP.md §4 leaves the bound open, so the counter increments without a ceiling and nothing escalates on it.
6. **Settlement summary structure is unspecified.** SETTLEMENT.md §2 names four required summaries and says they should reference canonical records rather than duplicate text, but gives no shape. They are stored as JSON objects whose contents the caller decides; a released shape would make "what was requested" mechanically checkable rather than merely present.
7. **Veteran-visible Settlement fields are `INFERRED`.** SETTLEMENT.md §6 and PRIVACY.md §5 defer to MVP visibility rules under D-015. The projection drops the occurred summary and internal identities, which is the conservative reading; confirm before the Slice 10 UI depends on it.

## 12. Readiness statement

`TESTING.md` §3.4 folds Settlement and Follow-Up into the Case suite, and those
behaviors are now green. The `COORDINATION` gate still does **not** advance:
readiness is recorded in `STATUS.md` on accepted evidence rather than claimed by
an implementation PR, and the durable scheduler FOLLOWUP.md §5 assumes does not
exist while D-022 is open. No pilot or production operation is authorized.
SPEC-018 remains the only path to go-live.
