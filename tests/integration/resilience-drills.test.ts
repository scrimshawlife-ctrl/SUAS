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
import {
  claimCase,
  executeCaseCommand,
  openCase,
  readCaseQueue,
  MAX_PAGE_SIZE,
} from '../../src/coordination/index.js';
import { appendDomainEvent, publishPendingEvents } from '../../src/events/index.js';
import { runIdempotentCommand } from '../../src/idempotency/index.js';
import {
  claimDueWork,
  createFollowUp,
  markFollowUpDue,
  rescheduleFollowUp,
} from '../../src/settlement/index.js';
import { withTransaction } from '../../src/db/index.js';
import {
  applyDeliveryCallback,
  attemptSend,
  enqueueNotification,
  FailingChannel,
  findNotification,
} from '../../src/notifications/index.js';
import { resolveCaseWithSettlement } from '../../src/settlement/index.js';
import type { DisclosureRequest } from '../../src/consent/index.js';
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
    // Drain from the other instance. Earlier drills left their own events in
    // the outbox, so the batch is drained to empty rather than assumed to be
    // one batch.
    let batches = 0;
    for (;;) {
      const pass = await publishPendingEvents(poolB(), (event) => {
        delivered.push(event.eventId);
        return Promise.resolve();
      });
      if (pass.published === 0) break;
      batches += 1;
    }
    expect(batches).toBeGreaterThan(0);

    // The committed fact was published exactly once, and a further pass adds nothing.
    const deliveries = delivered.filter((id) => id === appended.event.eventId).length;
    expect(deliveries).toBe(1);

    const afterDrain = await publishPendingEvents(poolB(), (event) => {
      delivered.push(event.eventId);
      return Promise.resolve();
    });
    expect(afterDrain.published).toBe(0);

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
          'releases no envelope, and tenant fairness is not demonstrated at all.',
      ],
    });
  });
});

describe('RESILIENCE.md §17.1 — notification provider unavailable', () => {
  it('leaves the send visibly failed and does not disturb the parent Case', async () => {
    const { tenantId, userId } = await enrolledUser();
    const opened = await withTransaction(poolA(), (tx) =>
      openCase(tx, { tenantId, veteranUserId: userId, actorType: 'VETERAN', actorId: userId }),
    );
    const statusBefore = opened.supportCase.status;

    const disclosure: DisclosureRequest = {
      tenantId,
      veteranUserId: userId,
      permission: 'can_view',
      scope: 'current_requests',
      granteeType: 'SYSTEM',
      granteeId: 'notifications',
      purpose: 'Notify the veteran about their own request',
      systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
    };

    const enqueued = await enqueueNotification(poolA(), {
      tenantId,
      recipientUserId: userId,
      destination: syntheticEmail('drill-recipient'),
      reason: 'drill_provider_outage',
      channel: 'EMAIL',
      templateVersion: 'drill@1',
      disclosure,
    });

    // The provider is down for every attempt.
    const failing = new Map([['EMAIL' as const, new FailingChannel('EMAIL')]]);
    await attemptSend(poolA(), failing, {
      tenantId,
      notificationId: enqueued.notification.notificationId,
      disclosure,
      renderBody: () => 'Synthetic notification body.',
    });

    const after = await findNotification(poolA(), tenantId, enqueued.notification.notificationId);
    expect(after?.deliveryStatus).not.toBe('DELIVERED');
    expect(after?.deliveryStatus).not.toBe('SENT');

    // The assertion the earlier evidence string claimed but never made.
    const caseAfter = await poolA().query<{ status: string }>(
      'SELECT status FROM support_cases WHERE tenant_id = $1 AND case_id = $2',
      [tenantId, opened.supportCase.caseId],
    );
    expect(caseAfter.rows[0]?.status).toBe(statusBefore);

    record({
      drillId: 'NOTIFICATION_PROVIDER_UNAVAILABLE',
      outcome: 'PASS',
      evidence:
        `A send against an unavailable channel left delivery status ` +
        `${after?.deliveryStatus ?? 'unknown'} and the parent Case still ${statusBefore}.`,
      caveats: [],
    });
  });
});

describe('RESILIENCE.md §17.3 — duplicate provider webhook', () => {
  it('applies a repeated delivery callback once', async () => {
    const { tenantId, userId } = await enrolledUser();
    const disclosure: DisclosureRequest = {
      tenantId,
      veteranUserId: userId,
      permission: 'can_view',
      scope: 'current_requests',
      granteeType: 'SYSTEM',
      granteeId: 'notifications',
      purpose: 'Notify the veteran about their own request',
      systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
    };

    const enqueued = await enqueueNotification(poolA(), {
      tenantId,
      recipientUserId: userId,
      destination: syntheticEmail('drill-webhook'),
      reason: 'drill_duplicate_webhook',
      channel: 'EMAIL',
      templateVersion: 'drill@1',
      disclosure,
    });

    const callback = {
      tenantId,
      notificationId: enqueued.notification.notificationId,
      providerEventId: `evt-${randomUUID()}`,
      reportedStatus: 'DELIVERED' as const,
    };

    // The provider redelivers the same event, and a stale one arrives after it.
    const first = await applyDeliveryCallback(poolA(), callback);
    const duplicate = await applyDeliveryCallback(poolB(), callback);
    const outOfOrder = await applyDeliveryCallback(poolB(), {
      ...callback,
      providerEventId: `evt-${randomUUID()}`,
      reportedStatus: 'SENT',
    });

    expect(first.applied).toBe(true);
    expect(duplicate.applied).toBe(false);
    expect(duplicate.reason).toBe('DUPLICATE');
    expect(outOfOrder.applied).toBe(false);

    record({
      drillId: 'DUPLICATE_OR_OUT_OF_ORDER_WEBHOOK',
      outcome: 'PASS',
      evidence:
        'A redelivered callback was refused as DUPLICATE on the other instance, and a ' +
        'later out-of-order callback did not regress the terminal delivery state.',
      caveats: [],
    });
  });
});

describe('RESILIENCE.md §17.9 — concurrent Settlement resolve', () => {
  it('settles once when two resolves race with different keys', async () => {
    const { tenantId, userId } = await enrolledUser();
    const opened = await withTransaction(poolA(), (tx) =>
      openCase(tx, { tenantId, veteranUserId: userId, actorType: 'VETERAN', actorId: userId }),
    );

    // RESOLVE is legal only from ACTIVE, by the assigned responder, with an
    // active assignment (CASES.md §4). Drive the Case there before racing.
    await claimCase(poolA(), {
      tenantId,
      caseId: opened.supportCase.caseId,
      responderUserId: userId,
    });
    await executeCaseCommand(poolA(), {
      tenantId,
      caseId: opened.supportCase.caseId,
      command: 'ACTIVATE',
      actorId: userId,
      actorType: 'RESPONDER',
    });

    const content = {
      requested: {},
      occurred: {},
      fulfilled: {},
      unresolved: {},
      authoredBy: userId,
      responderConfirmedBy: userId,
    };

    // A genuine race across both instances, with distinct idempotency keys so
    // the command kernel cannot collapse them into a replay.
    const outcomes = await Promise.allSettled([
      resolveCaseWithSettlement(poolA(), {
        tenantId,
        caseId: opened.supportCase.caseId,
        actorId: userId,
        content,
        idempotencyKey: randomUUID(),
      }),
      resolveCaseWithSettlement(poolB(), {
        tenantId,
        caseId: opened.supportCase.caseId,
        actorId: userId,
        content,
        idempotencyKey: randomUUID(),
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const settlements = await poolA().query(
      'SELECT settlement_id FROM settlements WHERE tenant_id = $1 AND case_id = $2',
      [tenantId, opened.supportCase.caseId],
    );
    expect(settlements.rowCount).toBe(1);

    record({
      drillId: 'CONCURRENT_SETTLEMENT_RESOLVE',
      outcome: 'PASS',
      evidence:
        'Two resolves raced across both instances under distinct idempotency keys; ' +
        'exactly one succeeded and exactly one Settlement row exists.',
      caveats: [],
    });
  });
});

describe('The drills this harness cannot honestly run', () => {
  it('records them BLOCKED rather than passing on another suite', () => {
    // Neither is re-driven here, and neither may borrow another file's result:
    // a caveat pointing at another suite is not §17 evidence.
    record({
      drillId: 'FULFILLMENT_TIMEOUT_AFTER_POSSIBLE_ACCEPTANCE',
      outcome: 'BLOCKED',
      evidence: 'Not re-driven by this harness.',
      blockedReason:
        'The ambiguous timeout is only meaningful through a transmitting adapter, and a ' +
        'transmitting adapter cannot complete while no per-capability projection contract ' +
        'is released (Slice 7 gap). Driving it here would require registering an invented ' +
        'contract.',
      caveats: [
        'PROVIDER_UNKNOWN handling itself is covered by tests/integration/fulfillment.test.ts.',
      ],
    });

    record({
      drillId: 'PROVIDER_RATE_LIMIT_MANUAL_FALLBACK',
      outcome: 'BLOCKED',
      evidence: 'Not re-driven by this harness.',
      blockedReason:
        'No released policy maps a RATE_LIMITED adapter to a manual fallback. The adapter ' +
        'health state exists, but the routing rule that would make rate limiting fall back ' +
        'to manual coordination is unspecified, so there is no defined behavior to drill.',
      caveats: [
        'Availability-based degradation to manual is a different rule, and is not this drill.',
      ],
    });

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
    // Three drills this harness cannot honestly run, each with a stated reason.
    expect([...report.blocked].sort()).toEqual([
      'FULFILLMENT_TIMEOUT_AFTER_POSSIBLE_ACCEPTANCE',
      'PROVIDER_RATE_LIMIT_MANUAL_FALLBACK',
      'RESTORE_REHEARSAL_WITH_PENDING_ATTEMPTS',
    ]);
    // No result borrows another suite's evidence.
    for (const result of report.results) {
      expect(result.caveats.join(' '), result.drillId).not.toContain('Delegated to');
    }
    expect(report.readiness).toContain('NOT_READY');
    expect(report.openDecisions.join(' ')).toContain('D-024');
  });
});
