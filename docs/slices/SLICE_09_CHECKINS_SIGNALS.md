# Slice 9 — Check-In / Support Signal interface: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 9: questionnaire and Check-In versioning, and a
deterministic engine **interface**. Production scoring remains unavailable, and
only clearly labelled unreleased fixtures exercise the interface.

**No scoring rule, weight, or threshold is shipped in this slice.** D-011 is
open, and SUPPORT_SIGNALS.md §2 states that implementation may build a pure
function contract and unreleased fixtures but "must not ship invented weights or
thresholds". The engine registry ships empty and every computation refuses.

## 1. Released spec citations

| Spec                 | Sections relied on                                                                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHECKINS.md`        | §1 purpose, §2 entities, §3 dimensions, §4 states, §4.1 incomplete, §4.2 abandoned, §4.3 corrections, §4.4 timing, §4.5 questionnaire migration, §5 publication, §6 completion and signal trigger, §7 events and audit, §8 authorization, §9 non-goals, §10 testability |
| `SUPPORT_SIGNALS.md` | §1 values, §2 computation contract, §3 computation identity, §4 recorded fields, §5 settlement and events, §6 historical integrity, §7 override policy, §9 visibility, §10 non-goals, §11 testability                                                                   |
| `EVENT_MODEL.md`     | §3.1 `CHECKIN_COMPLETED`, §3.2 `SUPPORT_SIGNAL_CHANGED`                                                                                                                                                                                                                 |
| `DATA_MODEL.md`      | §3 questionnaire and Check-In, §4 support signals, §14 rules 2 and 5                                                                                                                                                                                                    |
| `ENVIRONMENT.md`     | §3 `SUAS_SUPPORT_SIGNAL_MODE` = `disabled\|fixture`                                                                                                                                                                                                                     |
| `TESTING.md`         | §3.1 Support Signal suite, §12 D-011 golden vectors remain `UNRELEASED_FIXTURE`                                                                                                                                                                                         |

## 2. Change map — file to spec section

| Path                                   | Implements                                                               |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `migrations/0009_checkins_signals.sql` | `CHECKINS.md` §2-§5; `SUPPORT_SIGNALS.md` §3-§7; `DATA_MODEL.md` §3-§4   |
| `src/signals/engine.ts`                | `SUPPORT_SIGNALS.md` §1-§3, §10; `CHECKINS.md` §4.1; `ENVIRONMENT.md` §3 |
| `src/signals/check-ins.ts`             | `CHECKINS.md` §4-§7; `EVENT_MODEL.md` §3.1                               |
| `src/signals/settlement.ts`            | `SUPPORT_SIGNALS.md` §3-§7; `EVENT_MODEL.md` §3.2                        |

## 3. Design decisions worth review

**Free text is never handed to an engine.** SUPPORT_SIGNALS.md §10 forbids
generative interpretation of free text as a primary signal. Rather than relying
on an engine to ignore it, `CanonicalSignalInput` has no free-text field at all,
and `canonicalInputFor` does not select it. A test asserts the free text a
veteran wrote does not appear anywhere in the canonical input.

**`answer_options` has no `weight` column.** CHECKINS.md §3 marks option weights
`NOT_COMPUTABLE` until a version is published, and §2 of SUPPORT_SIGNALS forbids
invented weights. Adding a nullable weight column would have been an invitation
to fill it; a released scoring contract adds it in its own migration.

**An engine must declare whether it is released.** A fixture engine runs only
when a caller explicitly opts in, and the error naming it says plainly that a
fixture is never production authority.

**Completion and settlement are separate facts.** `CHECKIN_COMPLETED` requests
computation; it does not mean a signal settled. There is a test that completes a
Check-In, sees the job enqueued, and asserts no signal exists.

**A submission missing required answers becomes `INCOMPLETE` and emits nothing.**
CHECKINS.md §4.1 forbids computing a production signal from incomplete input, and
§7 emits `CHECKIN_COMPLETED` only on a successful transition to `COMPLETED`.

**Settled Check-In responses are immutable at the database level.** A trigger
refuses inserts, updates, and deletes on responses once the parent Check-In is
settled, so §4.3's "not silently rewritten" holds against a direct SQL write, not
only against the service layer.

**The effective-signal rule is stated, not implied.** §7 says the selection rule
"must be deterministic and reconciled ... before release" and forbids inferring
it from insertion order. No rule is released, so the one used is written down in
the query and in §10 below: most recent `computed_at`, ties broken by id
descending, with an override superseding what it overrides.

## 4. Evidence

`npm run verify` runs format check, lint, typecheck, and 534 tests (25 files),
29 of them added by this slice. Integration tests run against PostgreSQL 17.

| Invariant                                                                       | Evidence                            |
| ------------------------------------------------------------------------------- | ----------------------------------- |
| No engine is registered by default                                              | `tests/integration/signals.test.ts` |
| Computation refuses with no engine, naming D-011                                | same file                           |
| An unreleased fixture runs only on explicit opt-in                              | same file                           |
| Incomplete input is refused when the engine defines no missing-input behavior   | same file                           |
| The same canonical inputs produce the same result                               | same file                           |
| Publication is atomic and a new Check-In resolves to the published version      | same file                           |
| Republishing a published version is refused                                     | same file                           |
| Publishing supersedes the prior version, leaving exactly one published          | same file                           |
| An in-flight Check-In stays on its original version after a publish             | same file                           |
| A Check-In cannot start with no published version                               | same file                           |
| The first saved response moves the Check-In to `IN_PROGRESS`                    | same file                           |
| Completion emits exactly one `CHECKIN_COMPLETED`, and a replay emits none       | same file                           |
| A submission missing required answers becomes `INCOMPLETE` and emits nothing    | same file                           |
| An abandoned Check-In emits nothing                                             | same file                           |
| A settled Check-In cannot be edited, including by direct SQL                    | same file                           |
| Completion requests durable computation without settling a signal               | same file                           |
| Free text never reaches the canonical signal input                              | same file                           |
| One primary calculation settles per computation identity, with one change event | same file                           |
| Concurrent duplicate computation settles exactly one row                        | same file                           |
| A new signal version is a distinct computation                                  | same file                           |
| An explicit need cannot use a null check-in as its identity                     | same file                           |
| Settled signals are immutable to update and delete                              | same file                           |
| A completed Check-In with no settled signal is detectable                       | same file                           |
| An override is a new linked immutable row requiring a reason                    | same file                           |
| The override becomes the effective signal, deterministically and repeatably     | same file                           |
| An override never erases the computed signal from history                       | same file                           |

## 5. Environment and configuration changes

None. `SUAS_SUPPORT_SIGNAL_MODE` from Slice 1 already expresses the
`disabled|fixture` boundary this slice honours.

## 6. Migration notes

`0009_checkins_signals.sql` adds six tables (`questionnaire_versions`,
`questions`, `answer_options`, `check_ins`, `check_in_responses`,
`support_signals`), five enum types, and two triggers — one refusing edits to a
settled Check-In's responses, one making Support Signals append-only by reusing
the guard from migration 0002. `EXPECTED_SCHEMA_VERSION` moves from 8 to 9.

No destructive step, and no questionnaire or scoring content is inserted.

## 7. Idempotency and failure behavior

- Completion is idempotent: a replay returns the already-completed Check-In and emits no second fact.
- Primary settlement resolves duplicates on a unique computation key, so concurrent workers settle exactly one row and only the winner emits a change event.
- A recomputation under a new signal version is a distinct identity and writes a new row rather than mutating the old one.
- A failed or delayed signal job cannot roll a Check-In back from `COMPLETED`, and unsettled completions are listable for operations.
- Recovery uses the same computation identity, so a replay after an interrupted worker settles to the same logical result.

## 8. Security and privacy impact

- Free text is excluded from canonical signal input by structure, not by convention.
- `basis` records which canonical inputs and rules were used, not the veteran's answers verbatim.
- Settled Check-In responses and Support Signals are immutable at the database level, so history cannot be quietly rewritten.
- No questionnaire content is shipped, so no prompt in this repository can solicit medical history or an identifier the privacy spec forbids.
- Nothing in this slice discloses a signal: visibility requires the Slice 4 consent path (`can_view` + `support_signal`).

## 9. Availability boundaries preserved

No production Support Signal can be computed. The engine registry is empty, an
unreleased fixture requires explicit opt-in and is labelled as non-authoritative,
and incomplete input is refused. No questionnaire is published by the
implementation, so no instrument or psychometric claim exists. Signal computation
is requested through the Slice 1 job seam, which still fails closed outside LOCAL
and TEST while D-022 is open.

## 10. Semantic gaps returned to `SUAS-specs`

1. **D-011 blocks all scoring.** SUPPORT_SIGNALS.md §2 leaves exact rules and thresholds `DECISION_PENDING`, and TESTING.md §12 keeps golden vectors `UNRELEASED_FIXTURE`. The pure-function contract, versioning, determinism, and settlement are all built and tested against a labelled fixture — releasing a scoring contract and its golden vectors is the only remaining work. This is the same shape as the Slice 7 projection blocker.
2. **The effective-signal selection rule is not released.** §7 requires it to be deterministic and reconciled in DATA_MODEL.md or CASES.md _before release_, and forbids insertion-order inference. Implemented as: most recent `computed_at`, ties broken by `support_signal_id` descending, with an override superseding the signal it overrides. Deterministic and total, but chosen by this implementation. It needs confirming, particularly what should happen when two overrides target the same signal.
3. **Questionnaire content is `NOT_COMPUTABLE`.** CHECKINS.md §3 marks exact questions, option weights, and required flags unavailable until a version is published. The structures exist and hold nothing; `answer_options` deliberately has no weight column.
4. **Incomplete-input behavior has no released definition.** §4.1 permits a signal from incomplete input only if the published signal version defines deterministic missing-input behavior. The engine interface carries a `handlesIncompleteInput` flag and refuses otherwise; what such behavior should be is unreleased.
5. **The abandonment idle timeout is `DECISION_PENDING`.** §4.2 leaves it open, so nothing abandons a Check-In automatically; abandonment is an explicit call only.
6. **Questionnaire scoping is ambiguous.** The released text does not say whether a QuestionnaireVersion is global or tenant-scoped. Implemented as optionally tenant-scoped with a global fallback, and at most one published version per scope. Confirm.
7. **Signal-driven Case creation is not wired.** §8 says a `YELLOW`, `ORANGE`, or `RED` signal _may_ cause a Support Case to open or update "according to CASES.md", and CASES.md §3 says a new signal may update case priority "through a documented idempotent action" that is not specified. Slice 5 built the idempotent case-open path and this slice settles signals, but nothing connects them, because the connecting rule is undefined.

## 11. Readiness statement

The `CHECK-IN` gate requires "questionnaire + signal deterministic/replay suites
green" (`TESTING.md` §11). The questionnaire and replay suites are green. The
determinism suite is green only against a labelled fixture, and `TESTING.md` §3.1
requires golden vectors per published version, which do not exist. The gate does
**not** advance. Readiness is recorded in `STATUS.md` on accepted evidence rather
than claimed by an implementation PR. No pilot or production operation is
authorized. SPEC-018 remains the only path to go-live.
