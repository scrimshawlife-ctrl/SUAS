# Slice 8 — Notifications: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 8: logical-send dedupe, the durable-job
abstraction, consent re-check, fake email and SMS, and the IN_APP path.

## 1. Released spec citations

| Spec               | Sections relied on                                                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFICATIONS.md` | §1 purpose, §2 channels, §3 notification identity, §4 consent and preference evaluation, §5 durable send execution, §6 delivery status, §7 generation rule, §8 generating facts, §9 separation from Follow-Up retries, §10 security/privacy, §11 non-goals, §12 testability |
| `CONSENT.md`       | §4 (revocation stops future use; in-flight jobs re-check before any not-yet-sent disclosure), §9 (preferences are not consent)                                                                                                                                              |
| `DATA_MODEL.md`    | §9 notification_preferences and notifications                                                                                                                                                                                                                               |
| `ARCHITECTURE.md`  | §8 durable background work, §11 `EmailPort`/`SmsPort`                                                                                                                                                                                                                       |
| `ENVIRONMENT.md`   | §3 `SUAS_EMAIL_MODE` / `SUAS_SMS_MODE`                                                                                                                                                                                                                                      |
| `FOLLOWUP.md`      | §4 (notification retries are not coordination attempts)                                                                                                                                                                                                                     |

## 2. Change map — file to spec section

| Path                                | Implements                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `migrations/0008_notifications.sql` | `NOTIFICATIONS.md` §2-§6, §9; `DATA_MODEL.md` §9                               |
| `src/notifications/channels.ts`     | `NOTIFICATIONS.md` §2, §6, §10-§11; `ARCHITECTURE.md` §11; `ENVIRONMENT.md` §3 |
| `src/notifications/service.ts`      | `NOTIFICATIONS.md` §1, §3-§7, §9-§10; `CONSENT.md` §4                          |

## 3. Design decisions worth review

**There is no attempts table, deliberately.** NOTIFICATIONS.md §5 states that no
child `notification_attempts` table is required and that immutable Audit Events
remain the attempt-history authority. §12 asks for a test that it is absent, and
there is one.

**Consent is evaluated twice, and the second time is the one that matters.**
§4.1 evaluates at creation; §4.2 requires re-evaluation immediately before each
external attempt. A grant revoked in between cancels the send. This is the first
item in §12's list and the case a naive implementation gets wrong, because the
enqueue-time check feels sufficient.

**A duplicate generating event short-circuits before any consent work.** The
dedupe lookup runs first, so a redelivered job cannot produce a second message —
and cannot even re-read the veteran's grants.

**Preferences are read after a basis is established, never instead of one.** The
preference table carries no grant reference at all, so it is structurally unable
to authorize a send.

**A disabled channel yields no port.** The registry omits it rather than
supplying something that silently succeeds, so §2's "do not fake delivery" is
enforced by absence rather than by a runtime check someone could skip.

**PUSH is not an enum value.** §2 marks it `FUTURE`, so it is rejected with a
message naming it as reserved, matching how Slice 5 handles reserved Service
Request categories.

**A terminal delivery state is never regressed.** An out-of-order callback that
would move `DELIVERED` back to `SENT` is recorded and skipped with a reason,
rather than applied.

## 4. Evidence

`npm run verify` runs format check, lint, typecheck, and 505 tests (24 files),
23 of them added by this slice. Integration tests run against PostgreSQL 17.

| Invariant                                                                              | Evidence                                  |
| -------------------------------------------------------------------------------------- | ----------------------------------------- |
| MVP channels are accepted; PUSH is rejected as reserved                                | `tests/integration/notifications.test.ts` |
| A disabled channel is omitted from the registry                                        | same file                                 |
| Sending on a channel with no delivery path is refused, and nothing is recorded as sent | same file                                 |
| A duplicate generating event resolves to one logical Notification                      | same file                                 |
| A deliberate reminder is a new logical send                                            | same file                                 |
| Durable send work goes through the job seam, which still reports itself non-durable    | same file                                 |
| Enqueue without a basis is refused                                                     | same file                                 |
| A grant revoked between enqueue and send cancels the send, and nothing is delivered    | same file                                 |
| An internal-processing notification needs no third-party grant                         | same file                                 |
| A disabled channel preference blocks the send without being treated as consent         | same file                                 |
| Each attempt appends an immutable Audit Event                                          | same file                                 |
| No `notification_attempts` table exists                                                | same file                                 |
| Bounded retries exhaust into a visible `UNDELIVERABLE` state                           | same file                                 |
| A worker redelivering the job does not send twice                                      | same file                                 |
| Message bodies and destinations stay out of the audit payload                          | same file                                 |
| An authenticated callback moves canonical delivery status                              | same file                                 |
| A duplicate callback is deduplicated                                                   | same file                                 |
| An out-of-order callback does not regress a terminal state                             | same file                                 |
| Callback receipt never enqueues another message                                        | same file                                 |
| Notification attempts never touch a Follow-Up coordination count                       | same file                                 |

## 5. Environment and configuration changes

None. `SUAS_EMAIL_MODE` and `SUAS_SMS_MODE` from Slice 1 already describe exactly
what this slice consumes.

## 6. Migration notes

`0008_notifications.sql` adds three tables (`notification_preferences`,
`notifications`, `notification_delivery_callbacks`) and two enum types.
`EXPECTED_SCHEMA_VERSION` moves from 7 to 8. No destructive step.

The `dedupe_key` unique index is partial, so a policy that genuinely cannot
duplicate may omit the key entirely rather than inventing one.

## 7. Idempotency and failure behavior

- A duplicate generating event resolves to the existing Notification before any other work.
- A concurrent race on the dedupe key falls back to reading the winner rather than failing.
- A worker redelivering a job for an already-sent Notification skips rather than re-sending.
- Retries are bounded by `max_attempts`; exhaustion becomes `UNDELIVERABLE` and is listable for operations.
- Delivery callbacks are deduplicated on the provider event id and refuse to regress a terminal state, with the reason recorded on the callback row.
- A channel with no delivery path raises rather than recording a phantom send.

## 8. Security and privacy impact

- Audit payloads carry the channel, reason, outcome, attempt count, and consent basis — never the message body and never the destination. There is a test asserting both are absent.
- Destination data is tenant-scoped and stored on the notification row only.
- No provider credential appears in any table or code path in this slice.
- The consent re-check before each attempt means a revoked grant stops a queued message that was authorized when it was created.

## 9. Availability boundaries preserved

No real email or SMS vendor is reachable: the released modes are
`disabled|fake|sink`, and the configuration schema rejects a vendor name. The
durable send path uses the Slice 1 job seam, which still fails closed outside
LOCAL and TEST while D-022 is open — so this slice does not make production
notification delivery operational. Templates render text only; no safety copy is
shipped, and D-012 remains unresolved.

## 10. Semantic gaps returned to `SUAS-specs`

1. **Durable send execution is still blocked on D-022.** NOTIFICATIONS.md §5 requires sends to survive restart with duplicate-safe delivery. The enqueue path uses the Slice 1 durable-job seam, which supplies a declared non-durable fake in LOCAL and TEST and refuses in STAGING and PRODUCTION. No worker loop is registered, because scheduling one would mean choosing the queue product the decision reserves.
2. **Template rendering has no released contract.** §1 and §7 say templates render copy and carry no safety-critical decisions, and §3 requires a `template_version` on every send — but no template store, format, or rendering rule is released. `template_version` is recorded and the body is supplied by the caller; no template content is shipped.
3. **Notification policies are not enumerated.** §8 gives examples of generating facts and says policy plus authorization determines the logical send, but no released policy list maps an event to recipients, channels, or dedupe keys. Callers supply the reason key and dedupe key; nothing in this slice decides who gets notified from an event.
4. **The dedupe scope is described but not specified.** DATA_MODEL.md §9 says dedupe uniqueness is "scoped by tenant + recipient/channel/reason/policy as defined by the generating policy". With no released policies, the key is a caller-supplied string unique per tenant. A released policy vocabulary would let the scope be derived rather than trusted.
5. **Retry bounds and backoff are unreleased.** §5 requires bounded, backoff-aware retry that respects provider rate limits. `max_attempts` defaults to 5 and no backoff schedule exists, because there is no provider whose rate limits could inform one.
6. **Delivery-callback authentication is unimplementable.** §6 and §10 require authenticated, replay-protected webhooks. With no provider selected there is no signature scheme; `applyDeliveryCallback` therefore deduplicates and refuses regressions but performs no authentication, and must not be exposed as an HTTP endpoint until a provider decision closes. This mirrors the same gap in Slice 7 §10 item 4.

## 11. Readiness statement

`TESTING.md` §6 lists the notification suite, and its behavioral items are green.
No readiness gate advances: the `CONSENT` gate still needs the provider-disclosure
suite that Slice 4 §10 item 1 blocks, and durable delivery depends on D-022.
Readiness is recorded in `STATUS.md` on accepted evidence rather than claimed by
an implementation PR. No pilot or production operation is authorized. SPEC-018
remains the only path to go-live.
