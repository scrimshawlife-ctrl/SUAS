# Slice 10 — MVP-reference UI: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 10: veteran, responder/QRF, resource, chat, and
admin surfaces with truthful pending/no-availability states, a WCAG target, and
deterministic visual fixtures.

This is the first slice whose spec describes an **appearance** rather than a
state machine, and the first where a released rule is that something the
reference shows must **not** ship. `MVP_REFERENCE.md` §7.3 preserves the crisis
block's placement while `SAFETY.md` §2 forbids its wording, so the slot renders
empty and labelled. **No crisis copy, destination, or hotline is shipped.**

## 1. Released spec citations

| Spec               | Sections relied on                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MVP_REFERENCE.md` | §1 purpose, §2 conformance classes, §3 interaction spine, §4 principles, §5 surface inventory, §6 category mapping, §7 divergences, §8 resource screens, §9 responder dashboard, §10 accessibility, §11 fixtures, §12 gate, §13 non-goals |
| `SAFETY.md`        | §2 standing non-goals and D-012, §3.1 approved crisis resources, §5 veteran-initiated emergency, §9 testability                                                                                                                           |
| `RESOURCES.md`     | §6 veteran-visible fields, §7 active/inactive, §8 bounded search                                                                                                                                                                          |
| `AUTH.md`          | §5 per-request session evaluation                                                                                                                                                                                                         |
| `ADMIN.md`         | §2 privileged surface authorization                                                                                                                                                                                                       |
| `API.md`           | §2 version selector scope, §4 session and server-derived tenant, §6 error body                                                                                                                                                            |
| `DECISIONS.md`     | D-009, D-011, D-012, D-014, D-017–D-020                                                                                                                                                                                                   |

## 2. Change map — file to spec section

| Path                    | Implements                                                  |
| ----------------------- | ----------------------------------------------------------- |
| `src/ui/contract.ts`    | `MVP_REFERENCE.md` §2, §5, §11, §12                         |
| `src/ui/categories.ts`  | `MVP_REFERENCE.md` §6                                       |
| `src/ui/qrf.ts`         | `MVP_REFERENCE.md` §7.2, §4.8; `SAFETY.md` §2               |
| `src/ui/safety.ts`      | `MVP_REFERENCE.md` §7.3; `SAFETY.md` §2, §3.1, §9           |
| `src/ui/surfaces.ts`    | `MVP_REFERENCE.md` §3, §5, §7, §8, §9                       |
| `src/ui/theme.ts`       | `MVP_REFERENCE.md` §4, §10                                  |
| `src/ui/a11y.ts`        | `MVP_REFERENCE.md` §10, §12                                 |
| `src/ui/fixtures.ts`    | `MVP_REFERENCE.md` §11                                      |
| `src/ui/view-models.ts` | `MVP_REFERENCE.md` §8, §9; `PRIVACY.md` minimum necessary   |
| `src/ui/read.ts`        | `MVP_REFERENCE.md` §7.2; `API.md` §4                        |
| `src/http/routes/ui.ts` | `MVP_REFERENCE.md` §5, §6, §7.5; `API.md` §4; `ADMIN.md` §2 |

## 3. Design decisions worth review

**Server-rendered HTML, no client framework.** §13 explicitly declines to freeze
CSS or framework technology, and §11 wants repeatable comparison. A pure
`view model → string` function is deterministic without a browser or a database,
keeps the accessibility tree inspectable in a unit test, and adds no dependency.

**The §5 inventory is transcribed as data, and each render asserts its own
required elements.** §2 says no required element may silently disappear. That is
only enforceable if "required" is written down, so each surface carries its
reference anchors and a render that loses one throws rather than shipping.

**Rendering is pure; reads are separate.** Every surface takes a view model.
This is what makes the fixtures deterministic, and it makes "may this surface see
this field?" answerable by reading one file.

**A value that is unknown is never rendered as zero.** §9 permits `Responses`,
`Rating`, `This Month`, and `Avg Response` only if exact definitions and data are
specified. None are released, so the metric type has a `NOT_COMPUTABLE` variant
carrying a reason, and a test asserts no `0` reaches a definition list.

**Card heading level is a parameter.** The accessibility audit caught three real
1.3.1 failures where a card heading jumped from `h1` to `h3`. Fixed by passing
the level the container implies rather than by relaxing the check.

**Non-operational category cards stay visible and inert.** §6 permits display
continuity but not an unreleased domain category. `categoryForCard` refuses for
Counseling, Activities, and Job Training, naming the display rule; the domain
layer refuses those categories too. Two locks, not one.

**`RESPONDER_NOTIFIED` is currently unreachable, on purpose.** See §10 item 1.

**Required elements are state-aware rather than unconditional.** A surface
legitimately changes its dominant action with state: once a QRF request is in
flight, offering a second Deploy button would be wrong, so the request block
takes that position. §2 still applies, so the in-flight home declares its own
required elements and an unnamed state fails closed. Review found the first
version of this asserting the deploy string unconditionally, which made the
live in-flight home a 500 — see §12.

**Chat availability is a union, not an optional reason.** "No threads and no
reason" renders as an empty inbox, which implies working messaging. No released
slice stores a thread, so the type makes that state unrepresentable instead of
asking every caller to remember the reason.

## 4. Evidence

`npm run verify` runs format check, lint, typecheck, and 639 tests (28 files),
105 of them added by this slice. Integration tests run against PostgreSQL 17.

| Invariant                                                                    | Evidence                         |
| ---------------------------------------------------------------------------- | -------------------------------- |
| Every §5 surface is declared, and an unknown surface is refused              | `tests/unit/ui-contract.test.ts` |
| Every §11 fixture requirement is covered, with all six recorded fields       | same file                        |
| All six reference category labels remain visible                             | same file                        |
| Housing maps to temporary `SHELTER`, not the FUTURE `HOUSING` workflow       | same file                        |
| Counseling, Activities, and Job Training cannot create a Service Request     | same file                        |
| An assignment alone does not claim a responder was notified                  | same file                        |
| `RESPONDER_NOTIFIED` requires a recorded delivery                            | same file                        |
| An exhausted match reports no availability rather than continued searching   | same file                        |
| A failed dependency reports `DEGRADED` rather than a calm search             | same file                        |
| Every released request status maps to a label without falling through        | same file                        |
| Call and Message stay hidden without a counterpart and an authorized path    | same file                        |
| The crisis slot renders a placeholder and refuses to present official copy   | same file                        |
| The safety module ships no hotline, destination, or URL                      | same file                        |
| The placeholder gives no crisis guidance                                     | same file                        |
| Every fixture renders identically on repeated calls                          | `tests/unit/ui-surfaces.test.ts` |
| Every fixture passes the decidable WCAG 2.2 AA checks                        | same file                        |
| The audit detects a missing accessible name and a zoom-blocking viewport     | same file                        |
| A surface that loses a required action fails, naming what went missing       | same file                        |
| Unreleased categories are labelled in text, not by styling alone             | same file                        |
| The veteran home makes no proximity claim and no emergency implication       | same file                        |
| Immediate resources render above the broader catalog                         | same file                        |
| An unrecorded contact method is stated, and no scheme is guessed             | same file                        |
| No fabricated zero reaches a responder metric                                | same file                        |
| Veteran-authored text is escaped, not rendered as markup                     | same file                        |
| Public surfaces serve without a session; authenticated ones refuse without   | `tests/integration/ui.test.ts`   |
| Enrollment states the contact requirement instead of the reference's promise | same file                        |
| An unverified resource never reaches a veteran                               | same file                        |
| An unreleased category serves information only, never a catalog              | same file                        |
| A category absent from the reference surface is refused outright             | same file                        |
| The admin overview refuses a non-admin session                               | same file                        |
| Chat states its own unavailability                                           | same file                        |
| The veteran home renders while a QRF request is in flight                    | same file                        |
| An in-flight home shows the request block and no second deploy action        | same file                        |
| Every link the home and category surfaces render resolves, none 404          | same file                        |
| An in-flight home keeps every other §5 landmark                              | `tests/unit/ui-surfaces.test.ts` |
| A surface state that declares no required elements is refused                | same file                        |
| An empty inbox cannot render without declaring messaging available           | same file                        |

## 5. Environment and configuration changes

None.

## 6. Migration notes

None. This slice adds no table, column, or enum; `EXPECTED_SCHEMA_VERSION`
stays at 9. Every surface reads facts the earlier slices already record.

## 7. Idempotency and failure behavior

All routes are `GET` and side-effect free. The command paths the reference
implies — deploy, cancel, go on duty — are **not** wired in this slice; the
forms post to routes that do not exist yet, so no half-built command can run.
Wiring them belongs with the surfaces' owning commands, not with the rendering.

## 8. Security and privacy impact

- Every authenticated surface resolves its own session; there is no weaker "UI session" (`AUTH.md` §5).
- Tenant is server-derived on every read and is a required argument, never an optional filter.
- The admin surface requires the SUAS-admin grant **and** MFA elevation, and shows capability presence only — never a credential value.
- All text is escaped at the point of rendering; a test drives markup through a chat preview.
- The resource list shows only active, verified resources, so an unverified listing cannot reach a veteran.
- No veteran address, message body, or signal value appears on any surface added here.

## 9. Availability boundaries preserved

No crisis copy is shipped. No surface claims a responder exists, was reached, or
is nearby. No surface implies emergency dispatch. Non-operational categories
cannot create a Service Request. Metrics with no released definition display no
value. The `UI_CONFORMANCE` gate does **not** advance — see §11.

## 10. Semantic gaps returned to `SUAS-specs`

1. **A notification cannot be linked to the request it was sent for.** §7.2 permits `RESPONDER_NOTIFIED` only when the system knows delivery occurred, but the released `notifications` table (migration 0008) records no Case or Service Request reference. There is no join from a delivery back to a QRF request, so the label is currently **unreachable** and the surface stays on `SEARCHING` after assignment. Inventing a `dedupe_key` naming convention would manufacture the certainty §7.2 forbids. Releasing a subject reference on notifications closes this.
2. **`contact_method` is unstructured, so §8's direct actions are not implementable.** §8 asks for "direct phone/email/web actions where allowed", but `RESOURCES.md` §6 releases `contact_method` as a single free-text field. The catalog does not record whether a value is a number, an address, or a URL, so the row renders the value as recorded and offers no action. Releasing structured contact fields, or a scheme discriminator, closes this.
3. **There is no responder on-duty/availability store.** §9.1 makes on-duty "a primary responder control/state", and §5 lists a responder availability surface, but no released slice or table records availability. The surface renders and the control posts to an unwired route; the displayed state reflects nothing. A canonical availability fact is needed.
4. **There is no chat or message thread domain.** §5 requires a persistent Chat entry and §11 requires a chat fixture. Nothing in the released stack stores a thread or a message. The surface exists and states its unavailability rather than rendering an empty inbox that implies messaging works. `NOTIFICATIONS.md` covers outbound sends, not conversation.
5. **D-012 blocks the immediate-resource copy.** The slot renders in its reference position with a placeholder, per `SAFETY.md` §2 and §9. Nothing else in this slice is blocked by it, but the veteran-facing crisis path cannot exist until D-012 closes.
6. **The four reference metrics have no definitions.** §9 permits `Responses`, `Rating`, `This Month`, and `Avg Response` only with exact definitions and data. None are released, so all render as not computable.
7. **The visual reference is a live URL, not a pinned artifact.** §11 asks each fixture to record "reference source/revision/observation date", and `MVP_REFERENCE.md` §4 gives a URL plus an observation date of 2026-08-18 PT. A live site can change under the implementation, and no pinned snapshot or captured baseline is released. The fixtures record the observation date, but there is nothing immutable to compare against. A committed reference capture would make §11's comparison meaningful.
8. **Screenshot comparison has no released tooling or baseline.** §11 says "repeatable screenshot/reference comparison". This slice supplies the deterministic input — fixed view models, fixed markup, no clock or network — but captures no images and performs no comparison. That step needs a released baseline (item 7) and a human reviewer.
9. **Coverage hours are D-009 pending.** The availability surface shows no coverage window rather than inventing one.
10. **Location basis is undefined.** §7.2 forbids claiming geographic proximity "without an accepted/location-authorized basis" and forbids requiring continuous GPS; D-014 leaves geocoding/maps pending. No surface here shows distance or proximity, and no location capture exists. What an "accepted location-authorized basis" is remains unspecified.

## 11. Readiness statement

`UI_CONFORMANCE` requires all nine conditions in §12, including that
"visual-regression fixtures pass review" and "accessibility checks pass".

The mechanical parts hold: every required surface exists, reference-critical
actions are asserted present, the QRF flow is truthful about request,
availability, and contact state, unreleased categories are not served as
operational workflows, each divergence traces to a §7 clause, and resource data
comes from the catalog rather than hard-coded text.

The reviewed parts do not. **Accessibility checks pass only at the decidable
floor** — contrast ratios, focus order as experienced, reflow at 320 CSS px,
target size after layout, and screen-reader comprehensibility are not checked
here and need human review. **Fixtures have not passed review**, because §11's
comparison needs a pinned reference baseline that is not released (§10 items 7
and 8). Four required surfaces additionally render facts the domain does not yet
record (§10 items 1, 3, and 4).

The gate does **not** advance. Readiness is recorded in `STATUS.md` on accepted
evidence rather than claimed by an implementation PR. No pilot or production
operation is authorized. SPEC-018 remains the only path to go-live.

## 12. Review findings addressed

Three live-path defects were found in review of the first pushed SHA. All three
passed CI, because in each case the fixtures never reached the failing state —
which is itself the finding worth recording: a deterministic fixture proves only
the state it pins.

1. **`/app/home` returned 500 while a QRF request was in flight.** `VETERAN_HOME`
   required the literal `Deploy QRF`, and the in-flight render legitimately
   replaces that action with the request block, so `assertRequiredElementsPresent`
   threw on a real veteran path. Fixed by making required elements state-aware:
   the `QRF_IN_FLIGHT` state names its own landmarks, an unnamed state fails
   closed, and the assert is not weakened. A fixture and an integration test now
   cover the in-flight home.
2. **The chat renderer could print an empty inbox.** The fixture called
   `renderChat` with no unavailability reason, so it rendered "You have no
   conversations yet" — implying working messaging that no released slice
   provides. Fixed by making availability a union, so the state is unrepresentable
   without a caller explicitly declaring messaging available. The fixture now
   pins the same unavailable state the live route serves.
3. **Unreleased category cards linked to an unregistered route.** Non-operational
   cards pointed at `/app/resources/{label}/info`, which was never registered, so
   Counseling, Activities, and Job Training were dead links from the veteran
   home. Fixed by routing every card through the single registered handler, which
   already decides what a non-operational category may show. An integration test
   now walks every link the home and category surfaces render and fails on a 404,
   which covers the class rather than the instance.

Items the review raised and left standing, unchanged and already documented:
forms posting to unwired command routes (§7), the responder dashboard's
hardcoded availability and row category (§10 items 3 and 1), and accessibility
covering only the decidable markup floor (§11).
