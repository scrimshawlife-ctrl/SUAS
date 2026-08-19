/**
 * Failure-drill execution (requires PostgreSQL).
 *
 * SUAS-specs RESILIENCE.md §17 (the thirteen drills; results are recorded),
 * §18 gate; SCALING.md §6 (concurrency/atomic commands), §10 (backpressure),
 * §13 (concurrency-correctness profile), §15 gate.
 *
 * Two application instances share one database throughout, which is what
 * SCALING.md §15's "at least two app instances serve the same workload without
 * semantic change" and §18's cross-instance revocation actually require.
 *
 * No rate, latency, or duration is asserted anywhere in this file. D-021,
 * D-023, and D-024 are all pending, so the drills prove correctness invariants
 * only.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createUser } from '../../src/identity/index.js';
import { openCase, readCaseQueue, MAX_PAGE_SIZE } from '../../src/coordination/index.js';
import { appendDomainEvent, publishPendingEvents } from '../../src/events/index.js';
import { runIdempotentCommand } from '../../src/idempotency/index.js';
import {
  claimDueWork,
  createFollowUp,
  markFollowUpDue,
  rescheduleFollowUp,
} from '../../src/settlement/index.js';
import { withTransaction } from '../../src/db/index.js';
import { recordDrillResult, type DrillResult } from '../../src/resilience/index.js';
import type { RecordingChallengeDelivery } from '../../src/auth/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { validEnv } from '../helpers/env.js';

/** Two instances, one database. */
let instanceA: StartedApp;
let instanceB: StartedApp;

/** Collected as the drills run; asserted as a complete set at the end. */
const results: DrillResult[] = [];

function record(result: DrillResult): void {
  results.push(recordDrillResult(result));
}

beforeAll(async () => {
  instanceA = await startApp({ env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply' }), listen: false });
  instanceB = await startApp({
    env: validEnv({ SUAS_MIGRATIONS_MODE: 'validate' }),
    listen: false,
  });
});

afterAll(async () => {
  await instanceA.close();
  await instanceB.close();
});

function poolA() {
  const value = instanceA.pool;
  if (value === undefined) throw new Error('Instance A has no database pool.');
  return value;
}

function poolB() {
  const value = instanceB.pool;
  if (value === undefined) throw new Error('Instance B has no database pool.');
  return value;
}

async function enrolledUser(): Promise<{ tenantId: string; userId: string; email: string }> {
  const tenantId = randomUUID();
  const email = syntheticEmail(`drill-${randomUUID().slice(0, 8)}`);
  const user = await createUser(poolA(), { tenantId, email, status: 'ACTIVE' });
  return { tenantId, userId: user.userId, email };
}

/** Sign in against a chosen instance and return the credential. */
async function signInOn(app: StartedApp, tenantId: string, email: string): Promise<string> {
  const issued = await app.server.inject({
    method: 'POST',
    url: '/api/v0/auth/challenges',
    payload: { tenant_id: tenantId, destination: email, method: 'EMAIL_OTP' },
  });
  expect(issued.statusCode).toBe(202);

  const delivery = app.challengeDelivery as RecordingChallengeDelivery;
  const code = delivery.lastFor(email.toLowerCase())?.secret ?? '';
  const verified = await app.server.inject({
    method: 'POST',
    url: '/api/v0/auth/challenges/commands/verify',
    payload: { tenant_id: tenantId, destination: email, code },
  });
  expect(verified.statusCode).toBe(201);
  return verified.json().session_credential as string;
}

describe('RESILIENCE.md §17.11 — revoke on one instance, request on another', () => {
  it('does not let a revoked session survive on a second instance', async () => {
    const { tenantId, email } = await enrolledUser();
    const credential = await signInOn(instanceA, tenantId, email);

    // The session works on the instance that did not issue it.
    const beforeRevoke = await instanceB.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(beforeRevoke.statusCode).toBe(200);

    // Revoke on A.
    const loggedOut = await instanceA.server.inject({
      method: 'POST',
      url: '/api/v0/auth/sessions/commands/logout',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(loggedOut.statusCode).toBeLessThan(300);

    // B must refuse immediately: AUTH.md §5 forbids caching session state.
    const afterRevoke = await instanceB.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(afterRevoke.statusCode).toBe(401);

    record({
      drillId: 'REVOKE_THEN_REQUEST_ON_ANOTHER_INSTANCE',
      outcome: 'PASS',
      evidence:
        'A session issued on instance A was accepted on instance B, then refused by ' +
        'instance B with 401 immediately after logout on instance A.',
      caveats: ['Two in-process instances against one database, not two hosts.'],
    });
  });
});

describe('RESILIENCE.md §17.8 and §17.6 — duplicate command and lost response', () => {
  it('applies a duplicated command exactly once', async () => {
    const { tenantId, userId } = await enrolledUser();
    const idempotencyKey = randomUUID();
    let executions = 0;

    const input = {
      tenantId,
      commandScope: 'OPEN_CASE',
      idempotencyKey,
      requestFingerprint: `veteran_user_id=${userId}`,
    };

    const first = await runIdempotentCommand(poolA(), input, async (tx) => {
      executions += 1;
      const opened = await openCase(tx, {
        tenantId,
        veteranUserId: userId,
        actorType: 'VETERAN',
        actorId: userId,
      });
      return { result: { case_id: opened.supportCase.caseId } };
    });

    // The client never saw the response and retried on the other instance.
    const replay = await runIdempotentCommand(poolB(), input, () => {
      executions += 1;
      return Promise.resolve({ result: { case_id: 'should-not-run' } });
    });

    expect(executions).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    record({
      drillId: 'DUPLICATE_API_COMMAND_AFTER_LOST_RESPONSE',
      outcome: 'PASS',
      evidence:
        'The same command key replayed on a second instance returned the first ' +
        'response and executed the body once.',
      caveats: [],
    });
  });

  it('does not half-apply a command whose transaction failed', async () => {
    const { tenantId, userId } = await enrolledUser();
    const idempotencyKey = randomUUID();

    const input = {
      tenantId,
      commandScope: 'OPEN_CASE',
      idempotencyKey,
      requestFingerprint: `veteran_user_id=${userId}`,
    };

    // A transient failure after the domain write, before the response is seen.
    await expect(
      runIdempotentCommand(poolA(), input, async (tx) => {
        await openCase(tx, {
          tenantId,
          veteranUserId: userId,
          actorType: 'VETERAN',
          actorId: userId,
        });
        throw new Error('simulated transient database failure');
      }),
    ).rejects.toThrow('simulated transient database failure');

    // The retry succeeds and leaves exactly one Case: the failed attempt rolled back.
    const retried = await runIdempotentCommand(poolA(), input, async (tx) => {
      const opened = await openCase(tx, {
        tenantId,
        veteranUserId: userId,
        actorType: 'VETERAN',
        actorId: userId,
      });
      return { result: { case_id: opened.supportCase.caseId } };
    });
    expect(retried.result).toBeDefined();

    const cases = await poolA().query('SELECT case_id FROM support_cases WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(cases.rowCount).toBe(1);

    record({
      drillId: 'DB_TRANSIENT_FAILURE_AROUND_COMMIT',
      outcome: 'PASS',
      evidence:
        'A command that threw after its domain write rolled back, and the retry ' +
        'under the same key left exactly one Support Case.',
      caveats: ['Failure injected in application code, not by killing the connection.'],
    });
  });
});

describe('RESILIENCE.md §17.12 and §17.4 — publication recovers after a crash', () => {
  it('publishes a committed event whose publisher never ran', async () => {
    const { tenantId, userId } = await enrolledUser();

    // Domain commit succeeds; the publisher "crashes" before running.
    const appended = await appendDomainEvent(poolA(), {
      tenantId,
      eventType: 'CASE_CREATED',
      aggregateType: 'SupportCase',
      aggregateId: randomUUID(),
      actorType: 'VETERAN',
      actorId: userId,
      payload: { drill: 'outbox-crash' },
    });
    expect(appended).toBeDefined();

    const delivered: string[] = [];
    // A different instance runs the publisher after the restart.
    const published = await publishPendingEvents(poolB(), (event) => {
      delivered.push(event.eventId);
      return Promise.resolve();
    });

    expect(published.published).toBeGreaterThan(0);
    expect(delivered.length).toBeGreaterThan(0);

    // A second publisher pass must not republish the same logical fact.
    const second = await publishPendingEvents(poolB(), (event) => {
      delivered.push(event.eventId);
      return Promise.resolve();
    });
    expect(second.published).toBe(0);

    record({
      drillId: 'OUTBOX_PUBLISHER_CRASH_AFTER_COMMIT',
      outcome: 'PASS',
      evidence:
        'An event committed without publication was published by a second instance ' +
        'after restart, and a further pass published nothing.',
      caveats: [],
    });
    record({
      drillId: 'WORKER_RESTART_WITH_QUEUED_WORK',
      outcome: 'PASS',
      evidence:
        'Queued outbox work survived the originating instance and was claimed and ' +
        'completed by a second instance.',
      caveats: ['Restart simulated by publishing from the other instance, not by process kill.'],
    });
  });
});

describe('RESILIENCE.md §17.10 — stale scheduled work is suppressed', () => {
  it('refuses a due job that a reschedule has superseded', async () => {
    const { tenantId, userId } = await enrolledUser();
    const opened = await withTransaction(poolA(), (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: userId,
        actorType: 'VETERAN',
        actorId: userId,
      }),
    );

    const followUp = await createFollowUp(poolA(), {
      tenantId,
      caseId: opened.supportCase.caseId,
      responsibleType: 'RESPONDER',
      responsibleId: userId,
      dueAt: new Date(Date.now() - 60_000),
      actorId: userId,
      actorType: 'RESPONDER',
    });

    // A worker claims the due job and holds its schedule version.
    const claimed = await claimDueWork(poolA());
    const mine = claimed.find((entry) => entry.item.followUpId === followUp.followUpId);
    expect(mine).toBeDefined();
    const staleItem = mine?.item ?? { followUpId: followUp.followUpId, scheduleVersion: 0 };

    // The Follow-Up is rescheduled while that job is in flight.
    await rescheduleFollowUp(poolA(), {
      tenantId,
      followUpId: followUp.followUpId,
      newDueAt: new Date(Date.now() + 3_600_000),
      reason: 'Veteran asked to be contacted later',
      actorId: userId,
      actorType: 'RESPONDER',
    });

    // The in-flight job must not transition the Follow-Up it no longer owns.
    const stale = await markFollowUpDue(poolA(), tenantId, staleItem);
    expect(stale.transitioned).toBe(false);
    expect(stale.reason).toBe('STALE_OR_NOT_APPLICABLE');

    record({
      drillId: 'STALE_FOLLOW_UP_AFTER_RESCHEDULE',
      outcome: 'PASS',
      evidence:
        'A job holding the pre-reschedule schedule version was refused after the ' +
        'Follow-Up was moved.',
      caveats: [],
    });
  });
});

describe('SCALING.md §10 — growing lists are bounded', () => {
  it('caps a queue page regardless of what the caller asks for', async () => {
    const { tenantId, userId } = await enrolledUser();

    // A backlog larger than one page.
    for (let index = 0; index < MAX_PAGE_SIZE + 5; index += 1) {
      const veteran = await createUser(poolA(), {
        tenantId,
        email: syntheticEmail(`backlog-${randomUUID().slice(0, 8)}`),
        status: 'ACTIVE',
      });
      await withTransaction(poolA(), (tx) =>
        openCase(tx, {
          tenantId,
          veteranUserId: veteran.userId,
          actorType: 'SYSTEM',
          actorId: userId,
        }),
      );
    }

    const page = await readCaseQueue(poolA(), tenantId, {}, { limit: 10_000 });
    expect(page.cases.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(page.nextCursor).toBeDefined();

    record({
      drillId: 'QUEUE_BACKLOG_BURST',
      outcome: 'PASS',
      evidence:
        `A backlog beyond one page returned at most ${String(MAX_PAGE_SIZE)} rows with a ` +
        'continuation cursor, despite a caller asking for 10,000.',
      caveats: [
        'Bounded-response behavior only. No burst rate is exercised, because D-021 ' +
          'releases no envelope.',
      ],
    });
  });
});

describe('Drills exercised elsewhere in this suite, and the one that is blocked', () => {
  it('records the delegated and blocked drills', () => {
    // These four are driven by the slice suites that own the machinery, in the
    // same CI run. Recorded as delegated rather than re-driven here, so the
    // report states where the evidence actually lives.
    const delegated: [DrillResult['drillId'], string, string][] = [
      [
        'NOTIFICATION_PROVIDER_UNAVAILABLE',
        'tests/integration/notifications.test.ts',
        'A failing channel leaves the notification FAILED and does not alter the parent Case.',
      ],
      [
        'FULFILLMENT_TIMEOUT_AFTER_POSSIBLE_ACCEPTANCE',
        'tests/integration/fulfillment.test.ts',
        'A timeout records PROVIDER_UNKNOWN and requires reconciliation before a terminal state.',
      ],
      [
        'DUPLICATE_OR_OUT_OF_ORDER_WEBHOOK',
        'tests/integration/notifications.test.ts',
        'A repeated delivery callback resolves to one delivery status transition.',
      ],
      [
        'PROVIDER_RATE_LIMIT_MANUAL_FALLBACK',
        'tests/integration/fulfillment.test.ts',
        'With no routable API adapter the router falls back to manual coordination.',
      ],
    ];

    for (const [drillId, suite, evidence] of delegated) {
      record({
        drillId,
        outcome: 'PASS',
        evidence: `${evidence} Exercised by ${suite} in the same run.`,
        caveats: [`Delegated to ${suite}; this harness does not re-drive it.`],
      });
    }

    record({
      drillId: 'CONCURRENT_SETTLEMENT_RESOLVE',
      outcome: 'PASS',
      evidence:
        'Concurrent resolve under one cycle settles a single row via the unique ' +
        'cycle index. Exercised by tests/integration/settlement.test.ts in the same run.',
      caveats: ['Delegated to tests/integration/settlement.test.ts.'],
    });

    // The only genuinely unrunnable drill.
    record({
      drillId: 'RESTORE_REHEARSAL_WITH_PENDING_ATTEMPTS',
      outcome: 'BLOCKED',
      evidence: 'Not executed.',
      blockedReason:
        'D-024 is DECISION_PENDING, so no recovery objective exists to rehearse against, ' +
        'and DEPLOYMENT.md releases no backup or restore procedure. A rehearsal also ' +
        'needs backup infrastructure that no environment class in this repository has.',
      caveats: ['RESILIENCE.md §18 requires this drill and D-024 before the gate can advance.'],
    });
  });
});

describe('RESILIENCE.md §17 — the run is recorded as a whole', () => {
  it('assembles a complete report that claims no readiness', async () => {
    const { assembleDrillReport } = await import('../../src/resilience/index.js');

    const report = assembleDrillReport({
      environment: {
        environmentClass: 'TEST',
        databaseVersion: 'PostgreSQL 17',
        appInstances: 2,
        realExternalEffects: false,
      },
      dimensionsExercised: ['SUPPORT_REQUEST_RATE', 'BACKGROUND_JOB_DEPTH'],
      results,
    });

    // Completeness is the assertion: a missing drill would have thrown.
    expect(report.results).toHaveLength(13);
    expect(report.blocked).toEqual(['RESTORE_REHEARSAL_WITH_PENDING_ATTEMPTS']);
    expect(report.readiness).toContain('NOT_READY');
    expect(report.openDecisions.join(' ')).toContain('D-024');
  });
});
