# Slice 2 — Event / idempotency kernel: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 2: persistent command idempotency, the event
envelope, replay-safe publication with outbox-equivalent semantics,
correlation/causation, and duplicate-delivery evidence. No product/domain
workflow, no identity or tenancy, no UI, and no provider integration.

## 1. Released spec citations

| Spec              | Sections relied on                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVENT_MODEL.md`  | §1 purpose/append-only, §2 envelope, §2.1 identity separation, §3 catalog, §4 Audit Events, §5 transactionality/replay/idempotency, §6 ordering, §8 schema evolution, §9 non-goals, §10 testability |
| `API.md`          | §6 error body and conflict codes, §7 persistent idempotency rules 1-7                                                                                                                               |
| `DATA_MODEL.md`   | §10 command idempotency records, §11 immutable event stores and outbox, §13 required access paths, §14 rules 14-16                                                                                  |
| `ARCHITECTURE.md` | §3 invariants 1, 4, 5, 11, 12; §5.17 Command Idempotency; §5.18 Audit/Event layer; §8 durable background work; §9 sync vs async; §10 concurrency/idempotency; §13 resilience; §16 non-goals         |
| `VERSIONING.md`   | §3.4 event schema version identity                                                                                                                                                                  |
| `TESTING.md`      | §2 test layers, §3.5 events / command idempotency                                                                                                                                                   |
| `ENVIRONMENT.md`  | §9 migration and compatibility rules                                                                                                                                                                |

## 2. Change map — file to spec section

| Path                                           | Implements                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `migrations/0002_event_idempotency_kernel.sql` | `DATA_MODEL.md` §10, §11, §13; `EVENT_MODEL.md` §1, §2, §5                 |
| `src/events/envelope.ts`                       | `EVENT_MODEL.md` §2, §2.1, §3, §8; `VERSIONING.md` §3.4                    |
| `src/events/store.ts`                          | `EVENT_MODEL.md` §1, §2.1, §4, §5.2-§5.3; `DATA_MODEL.md` §11              |
| `src/events/outbox.ts`                         | `EVENT_MODEL.md` §5.3-§5.4; `ARCHITECTURE.md` §8, §13; `DATA_MODEL.md` §11 |
| `src/events/consumer.ts`                       | `EVENT_MODEL.md` §5.4-§5.5, §8, §10; `ARCHITECTURE.md` §3 invariant 4      |
| `src/idempotency/fingerprint.ts`               | `API.md` §7.2-§7.4; `DATA_MODEL.md` §10                                    |
| `src/idempotency/store.ts`                     | `API.md` §7; `DATA_MODEL.md` §10, §14 rule 15; `ARCHITECTURE.md` §5.17     |
| `src/idempotency/run.ts`                       | `API.md` §6, §7; `ARCHITECTURE.md` §9; `EVENT_MODEL.md` §5.3               |
| `src/db/transaction.ts`                        | `EVENT_MODEL.md` §5.3; `ARCHITECTURE.md` §10                               |
| `src/db/schema-version.ts`                     | `ENVIRONMENT.md` §9 (expected schema version 1 → 2)                        |
| `src/http/server.ts`                           | `API.md` §6 (released conflict codes surfaced in the error body)           |

## 3. Design decisions worth review

**The four identities are separate columns, not aliases.** `event_id`,
`idempotency_key`, `correlation_id`, and `causation_event_id` are modelled and
tested as distinct (EVENT_MODEL.md §2.1).

**Append-only is enforced by the database, not by convention.** Triggers on
`domain_events` and `audit_events` reject row-level UPDATE and DELETE, so
application code cannot rewrite a business fact even by mistake
(EVENT_MODEL.md §1, §10).

**Duplicate producer replay is prevented by a unique index**, not by an
application check: `(tenant_id, event_type, idempotency_key)` where the key is
present. A replay resolves to the already-persisted fact
(EVENT_MODEL.md §2.1, §5.2).

**The outbox is deliberately mutable while the event stores are not.**
Publication state is infrastructure, not business meaning, which is why it lives
in its own table (DATA_MODEL.md §11).

**Delivery is at-least-once and consumers dedupe.** `processed_events` is keyed
by (consumer, event) and written in the same transaction as the handler's effect,
so a duplicate delivery produces one observable business effect — the target
stated in EVENT_MODEL.md §5.

**A failed command is retryable by default.** Caching a transient failure as the
authoritative outcome is worse than re-running a deterministic one, so callers
opt in to terminal failure explicitly.

## 4. Evidence

`npm run verify` runs format check, lint, typecheck, and 155 tests (12 files),
55 of them added by this slice. Integration tests run against PostgreSQL 17.

| Invariant                                                                            | Evidence                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Every envelope field persists, with a server-authoritative time                      | `tests/integration/events.test.ts` — "envelope"        |
| Causation links two facts without conflating identity                                | same file                                              |
| An event type outside the released catalog is rejected                               | same file; `tests/unit/event-envelope.test.ts`         |
| `event_id` is distinct from the idempotency key                                      | `events.test.ts`, `idempotency.test.ts`                |
| A producer replay resolves to the persisted fact, not a second event                 | `events.test.ts` — "identity separation"               |
| Logical event identity is tenant-scoped                                              | same file                                              |
| UPDATE and DELETE are rejected on both event stores                                  | same file — "append-only"                              |
| Event and outbox row commit together; a failed transaction leaves neither            | same file — "a committed event cannot be lost"         |
| A publisher crash after domain commit leaves the event pending and later delivers it | same file                                              |
| Retry is bounded, backs off, and dead-letters with visibility                        | same file — "bounded retry and failed-work visibility" |
| A dead-lettered event stays put until explicitly requeued                            | same file                                              |
| Duplicate delivery applies the effect once                                           | same file — "duplicate delivery yields one effect"     |
| Dedupe is per consumer, so a second consumer still sees the event                    | same file                                              |
| A failed handler does not mark the event processed                                   | same file                                              |
| An unsupported event schema version is rejected, not misread                         | same file; `tests/unit/event-envelope.test.ts`         |
| Concurrent publishers each claim distinct work                                       | same file — "concurrent publishers"                    |
| Same key and same request replays the authoritative result                           | `tests/integration/idempotency.test.ts`                |
| Replay works from a separate pool, proving records are not process-local             | same file                                              |
| Fingerprints ignore JSON key order but not values                                    | same file; `tests/unit/fingerprint.test.ts`            |
| Same key with a conflicting request raises 409 `IDEMPOTENCY_CONFLICT`                | `idempotency.test.ts`                                  |
| Keys are scoped by tenant and by command                                             | same file                                              |
| The command body, its event, and the COMPLETED record commit atomically              | same file — "atomicity and contention"                 |
| A rolled-back command is never reported successful                                   | same file                                              |
| Concurrent reservation of one key produces a single winner                           | same file                                              |
| A retryable failure can re-run; a terminal failure replays                           | same file                                              |
| The stored outcome stays bounded                                                     | same file                                              |
| Payloads are bounded, so notes and provider bodies cannot be dumped in               | `tests/unit/event-envelope.test.ts`                    |

## 5. Test-harness changes

Two problems in the Slice 1 harness surfaced while adding this slice and are
fixed here:

1. Migration tests reset the database, which is destructive to whatever else
   shares it. They now own `suas_migrations_test` and reset by dropping the
   `public` schema, which stays correct as migrations are added instead of
   needing a hand-maintained drop list.
2. The shared `suas_test` database was migrated only as a side effect of whichever
   test happened to run first. A vitest `globalSetup` now migrates it once before
   the run, so `npm test` works against an empty database.

Migration assertions that hardcoded a single migration now derive from the
on-disk migration set.

## 6. Migration notes

`0002_event_idempotency_kernel.sql` is additive: five tables
(`domain_events`, `audit_events`, `event_outbox`, `processed_events`,
`command_idempotency_records`), three enum types, two append-only triggers, and
the indexes backing the DATA_MODEL.md §13 access paths. `EXPECTED_SCHEMA_VERSION`
moves from 1 to 2.

No destructive step; forward-fix is a later numbered migration. Retention and
expiry remain D-007 `DECISION_PENDING`, so no purge or TTL behavior is added —
`expires_at` exists only so a released retention policy has a home.

`tenant_id` carries no foreign key yet because organizations arrive in Slice 3.
The column exists now because tenant scope is part of the released envelope and
tenant isolation must survive jobs and events.

## 7. Idempotency and failure behavior

- Reservation commits separately from execution, so concurrent instances observe it immediately; the command body, its Domain Event, and the COMPLETED record then commit as one transaction.
- A lost response can safely retry: an identical request replays a completed outcome, and a retryable failure re-runs.
- Outbox claims use `FOR UPDATE SKIP LOCKED`, so concurrent publishers do not contend or double-deliver within a run.
- A crash between dispatch and commit leaves the row pending, producing a redelivery that consumers absorb.
- Publication attempts are bounded, back off exponentially to a ceiling, and end in a visible dead-letter state rather than an infinite retry.

## 8. Security and privacy impact

- Event payloads are bounded at 16 KB and idempotency results at 8 KB, so whole provider responses, Check-In answers, and notes cannot be dumped into either (EVENT_MODEL.md §2, §4).
- Publication failure detail is truncated and stored as operational metadata, not domain meaning.
- `correlation_id` and `request_id` remain opaque identifiers; nothing in this slice writes veteran PII.
- Audit Events accept `ip` and `user_agent` only where a caller supplies them, per EVENT_MODEL.md §4 "where collection is justified".
- No secret material is read or written by this slice.

## 9. Availability boundaries preserved

Nothing becomes production-operational. The Domain Event catalog is exactly the
22 released types, with a test asserting no vendor-native names leak in
(EVENT_MODEL.md §3, §9). No durable queue vendor is selected: publication is
driven by an explicit function call, and the D-022 seam from Slice 1 is untouched.
No retention or purge behavior is invented while D-007 is open.

## 10. Semantic gaps returned to `SUAS-specs`

Mechanism choices made under `HANDOFF.md` §11 where the released text is silent.
None changes a released product or domain rule.

1. **Concurrent in-flight retry has no defined response.** `API.md` §7 covers same-key/same-request (replay) and same-key/conflicting-request (409 `IDEMPOTENCY_CONFLICT`), but not a retry arriving while the original is still executing. Implemented as 409 `IDEMPOTENCY_CONFLICT` with a distinguishing message, because inventing a new error code would add to the released contract. Specs should confirm, or define a distinct code or a 425/409 retry-after semantic.
2. **Idempotency record retention is unimplemented by design.** `API.md` §7 requires that retention "not permit unsafe duplicate effects inside the accepted replay window" and ties the window to D-007. No expiry runs, so records accumulate. The `expires_at` column is in place; a released window is needed before a reaper can exist.
3. **Terminal versus retryable failure classification is caller-owned.** The released text does not say which command failures should be cached as authoritative. The default is retryable, with an explicit opt-in for terminal. Confirm whether specs intend a released classification, particularly for domain-validation failures.
4. **Payload and result size bounds are implementation-owned.** `EVENT_MODEL.md` §2 and `DATA_MODEL.md` §10 require "bounded" without naming a bound. 16 KB for event payloads and 8 KB for idempotency results are enforceable guards, not released values.
5. **Audit Event publication is not defined.** `EVENT_MODEL.md` §5.3 covers required Domain Event publication; §4 does not say whether Audit Events are also published to consumers. They are currently persisted but not routed through the outbox. Confirm.
6. **Dead-letter requeue is an operator action with no released contract.** `EVENT_MODEL.md` §4 lists recovery/replay/dead-letter actions among auditable facts. `requeueDeadLetter` exists and its docstring requires callers to append that Audit Event, but no released spec defines who may requeue or what the Audit Event should record. Slice 3 brings the identity needed to enforce it.

## 11. Readiness statement

Kernel evidence only. This advances no `TESTING.md` §11 readiness gate — the
`COORDINATION` gate depends on Case/Request suites that do not exist yet — and it
authorizes no pilot or production operation. SPEC-018 remains the only path to
go-live.
