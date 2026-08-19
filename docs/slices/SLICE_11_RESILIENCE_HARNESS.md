# Slice 11 — Scale / resilience harness: conformance record

**Released spec stack:** `0.1.1`
**Release manifest:** `RELEASE_MANIFEST-0.1.1.md`
**Specs merge:** `e7aaf5d8ec1f7b646f3fd96866947b40c37f84fb`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged by this slice)

Scope is `SPEC017_PLAN.md` Slice 11: horizontal-instance, duplicate delivery,
stale-work, concurrency, provider-timeout, queue-backlog, event-recovery,
session-revoke, migration/restore simulation — with the plan's own constraint
that **no production numeric SLO/RTO/RPO is invented**.

This slice proves invariants rather than adding behavior. It adds no migration,
no table, and no route.

## 1. Released spec citations

| Spec             | Sections relied on                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `RESILIENCE.md`  | §14 recovery objectives, §17 the thirteen failure drills, §18 `RESILIENCE` gate, §19 non-goals                                       |
| `SCALING.md`     | §3 workload dimensions, §6 concurrency/atomic commands, §10 backpressure, §13 release load profiles, §15 `SCALE` gate, §16 non-goals |
| `AUTH.md`        | §5 per-request session evaluation                                                                                                    |
| `ENVIRONMENT.md` | §5 LOCAL/TEST forbid real external effects                                                                                           |
| `DECISIONS.md`   | D-021, D-023, D-024 (all `DECISION_PENDING`)                                                                                         |

## 2. Change map — file to spec section

| Path                                          | Implements                                               |
| --------------------------------------------- | -------------------------------------------------------- |
| `src/resilience/drills.ts`                    | `RESILIENCE.md` §17, §18                                 |
| `src/resilience/envelope.ts`                  | `SCALING.md` §3, §13, §15, §16; `RESILIENCE.md` §14, §19 |
| `src/resilience/report.ts`                    | `RESILIENCE.md` §17; `SCALING.md` §15                    |
| `tests/integration/resilience-drills.test.ts` | `RESILIENCE.md` §17; `SCALING.md` §6, §10, §15           |

## 3. Design decisions worth review

**No numeric target can be produced.** Both gates require recorded rates,
latencies, and recovery objectives, and D-021, D-023, and D-024 are all open.
`envelope.ts` therefore has no numeric constant and three assertions that
refuse — a rate, an SLO, and an RTO/RPO. A test greps the module for numeric
rate and recovery literals, because a plausible-looking number here would read
as a released target.

**A partial run cannot be reported as a run.** §17 names thirteen drills.
`assembleDrillReport` requires a result for every one and names the missing
ones, so a harness that silently covered nine cannot emit a clean artifact.

**`BLOCKED` is a first-class outcome that must state its reason.** §18 accepts
drills that "pass or have accepted mitigations". A drill whose dependency is an
unreleased decision has neither passed nor failed, and recording it requires a
reason naming what is missing.

**The report cannot express readiness.** Its `readiness` field is a fixed
statement that both gates remain `NOT_READY`. There is no code path by which a
harness run concludes anything about its own gate.

**Two application instances share one database for the whole drill suite**,
which is what `SCALING.md` §15's two-instance requirement and §18's
cross-instance revocation actually test. Both are in-process; see §10 item 5.

**Three of the four §13 load profiles are marked not executable.** Steady
state, burst, and degraded dependency are each defined by a _rate_, and no rate
is released. Only concurrency correctness is defined by contention rather than
volume, so only it runs today.

## 4. Evidence

`npm run verify` runs format check, lint, typecheck, and 665 tests (30 files),
26 of them added by this slice. Integration drills run against PostgreSQL 17
with two application instances.

| Invariant                                                                 | Evidence                                      |
| ------------------------------------------------------------------------- | --------------------------------------------- |
| All thirteen §17 drills are declared; an unlisted drill is refused        | `tests/unit/resilience-harness.test.ts`       |
| Every recorded result carries evidence; a blocked one names its reason    | same file                                     |
| A run missing drills is refused, and the missing drills are named         | same file                                     |
| A duplicate result for one drill is refused                               | same file                                     |
| A run against `PRODUCTION` is refused                                     | same file                                     |
| A load rate, latency target, and recovery objective each refuse           | same file                                     |
| The three volume-defined profiles are not executable without an envelope  | same file                                     |
| No numeric rate or recovery constant ships in the envelope module         | same file                                     |
| A report states `NOT_READY` even when all thirteen drills passed          | same file                                     |
| A session revoked on one instance is refused by the other immediately     | `tests/integration/resilience-drills.test.ts` |
| A duplicated command replayed on a second instance executes its body once | same file                                     |
| A command that threw after its domain write leaves exactly one Case       | same file                                     |
| An event committed without publication is published after restart, once   | same file                                     |
| Queued outbox work survives its originating instance                      | same file                                     |
| A due job superseded by a reschedule is suppressed, not applied           | same file                                     |
| A backlog beyond one page is bounded and returns a continuation cursor    | same file                                     |
| The assembled run is complete, and blocks only the restore rehearsal      | same file                                     |

## 5. Environment and configuration changes

None.

## 6. Migration notes

None. `EXPECTED_SCHEMA_VERSION` stays at 9.

## 7. Idempotency and failure behavior

The harness performs no domain command of its own. The drills drive existing
commands and assert their idempotency and suppression behavior: replayed
commands execute once, failed transactions roll back whole, superseded
scheduled work is refused, and outbox publication recovers without republishing.

## 8. Security and privacy impact

Drills use synthetic users and tenants only, run in `TEST` with real external
effects disabled, and refuse to record a run against `PRODUCTION`. No drill
sends a message, calls a provider, or writes a veteran-identifying value.

## 9. Availability boundaries preserved

Neither `RESILIENCE` nor `SCALE` advances. The harness cannot express
readiness, cannot produce a numeric target, and records the restore rehearsal
as blocked rather than absent.

## 10. Semantic gaps returned to `SUAS-specs`

1. **D-021 blocks three of the four §13 load profiles.** Steady state, burst, and degraded dependency are each defined by a rate. No rate, concurrency level, or duration is released, so none can be executed without inventing the target §13 and §16 forbid inventing.
2. **D-023 leaves every performance assertion unavailable.** No latency, throughput, or saturation threshold exists, so the harness asserts none. §15 requires them recorded before the gate advances.
3. **D-024 blocks the restore rehearsal outright.** §17.13 requires a restore rehearsal with pending/unknown provider attempts, and §18 requires both that drill and recorded recovery objectives. With D-024 open there is no objective to rehearse against. This is the only drill recorded `BLOCKED`.
4. **No backup or restore procedure is released.** Separately from D-024's numbers, `DEPLOYMENT.md` releases no procedure to rehearse, and no environment class in this repository has backup infrastructure. Both are needed before §17.13 can run at all.
5. **The two instances are in-process, not two hosts.** They share one Node process and one database, which exercises cross-instance session revocation and cross-instance command replay honestly, but not process isolation, network partition, or rolling deploy. §15's "at least two app instances" is met in the sense that matters for semantics; §15's deploy and restart concerns are not.
6. **Four drills are delegated, not re-driven.** Notification-provider unavailability, fulfillment timeout after possible acceptance, duplicate webhook, and provider rate-limit fallback are exercised by the slice suites that own that machinery, in the same CI run. The report records where the evidence lives and caveats that the harness did not re-drive them. Whether §17 intends one consolidated drill run or accepts distributed evidence is not stated.
7. **Tenant fairness has no released policy.** §18 and `SCALING.md` §9 and §15 require noisy-neighbor controls "demonstrated for the release envelope". No fairness policy, quota, or scheduling rule is released, and demonstrating one needs D-021's envelope. Nothing in this slice demonstrates tenant fairness, and nothing could.
8. **§17 asks for staging; there is no staging environment.** The drills run in `TEST`. `ENVIRONMENT.md` defines a `STAGING` class, but no staging deployment exists to run drills against, and D-001 leaves hosting open.
9. **Worker restart is simulated, not real.** The restart drill publishes from the second instance rather than killing a process. It proves the queued work is not owned by the instance that enqueued it, which is the invariant §18 names, but it does not prove crash-recovery behavior of a real process under signal.

## 11. Readiness statement

`RESILIENCE = READY` requires twelve conditions and `SCALE = READY` requires
thirteen. The correctness conditions in both are exercised and passing:
production-critical work survives restart, retries and replays are bounded and
idempotent, duplicate commands and webhooks are safe, stale scheduled work is
suppressed, session revocation is authoritative across instances, event
publication recovers without losing a logical fact, contested operations are
atomic, and growing lists are bounded.

Every remaining condition depends on a decision that is not released. D-021 has
no workload envelope, D-023 has no SLOs, D-024 has no recovery objectives, no
restore procedure exists to test, and tenant fairness has no policy to
demonstrate. **Neither gate advances**, and this slice makes that structural
rather than editorial: the harness has no code path that produces a numeric
target or claims a gate.

Readiness is recorded in `STATUS.md` on accepted evidence rather than claimed by
an implementation PR. No pilot or production operation is authorized. SPEC-018
remains the only path to go-live.
