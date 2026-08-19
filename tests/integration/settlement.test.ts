/**
 * Follow-Up and Settlement integration evidence (requires PostgreSQL).
 *
 * SUAS-specs FOLLOWUP.md §2-§9, §11 (critical behaviors: stale jobs, idempotent
 * completion, coordination retry semantics); SETTLEMENT.md §2-§6, §8-§10
 * (multi-cycle history, blocking vs carried-forward, idempotent resolve);
 * CASES.md §4.2, §7.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import { listAggregateEvents } from '../../src/events/index.js';
import {
  claimCase,
  createServiceRequest,
  executeCaseCommand,
  executeServiceRequestCommand,
  findCase,
  openCase,
} from '../../src/coordination/index.js';
import {
  BlockingFollowUpError,
  cancelFollowUp,
  claimDueWork,
  completeFollowUp,
  createFollowUp,
  findCurrentSettlement,
  findFollowUp,
  FollowUpValidationError,
  listSettlements,
  markFollowUpDue,
  markFollowUpOverdue,
  recordCoordinationAttempt,
  rescheduleFollowUp,
  resolveCaseWithSettlement,
  setResolutionDisposition,
  SettlementContentError,
  UnclassifiedFollowUpError,
  veteranVisibleSettlement,
  type SettlementContent,
} from '../../src/settlement/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function user(tenantId: string, label: string) {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

/** An ACTIVE case with an assigned responder, ready to resolve. */
async function activeCase() {
  const tenantId = syntheticTenantId();
  const veteran = await user(tenantId, 'veteran');
  const responder = await user(tenantId, 'responder');
  const opened = await withTransaction(pool, (tx) =>
    openCase(tx, {
      tenantId,
      veteranUserId: veteran.userId,
      actorType: 'RESPONDER',
      actorId: responder.userId,
    }),
  );
  const caseId = opened.supportCase.caseId;
  await claimCase(pool, { tenantId, caseId, responderUserId: responder.userId });
  await executeCaseCommand(pool, {
    tenantId,
    caseId,
    command: 'ACTIVATE',
    actorId: responder.userId,
    actorType: 'RESPONDER',
  });
  return { tenantId, veteran, responder, caseId };
}

function content(responderId: string): SettlementContent {
  return {
    requested: { service_requests: [] },
    occurred: { contact_attempts: 1, assignments: 1 },
    fulfilled: { fulfillments: [] },
    unresolved: { notes: 'none' },
    authoredBy: responderId,
    responderConfirmedBy: responderId,
  };
}

describe('FOLLOWUP.md §3, §11 — creation requires the released fields', () => {
  it('creates a Follow-Up and emits FOLLOWUP_CREATED', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    const followUp = await createFollowUp(pool, {
      tenantId,
      caseId,
      dueAt: new Date(Date.now() + 60_000),
      responsibleType: 'RESPONDER',
      responsibleId: responder.userId,
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });

    expect(followUp.status).toBe('SCHEDULED');
    expect(followUp.scheduleVersion).toBe(1);
    expect(followUp.coordinationAttemptCount).toBe(0);
    // Unclassified until someone decides; SETTLEMENT.md §4 then blocks resolve.
    expect(followUp.resolutionDisposition).toBeUndefined();

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'FollowUp',
      aggregateId: followUp.followUpId,
    });
    expect(events.map((event) => event.eventType)).toContain('FOLLOWUP_CREATED');
  });

  it('refuses a Follow-Up with no valid due time', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    await expect(
      createFollowUp(pool, {
        tenantId,
        caseId,
        dueAt: new Date('not-a-date'),
        responsibleType: 'RESPONDER',
        responsibleId: responder.userId,
        actorId: responder.userId,
        actorType: 'RESPONDER',
      }),
    ).rejects.toThrow(FollowUpValidationError);
  });

  it('refuses a Follow-Up with no responsible party', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    await expect(
      createFollowUp(pool, {
        tenantId,
        caseId,
        dueAt: new Date(Date.now() + 60_000),
        responsibleType: 'RESPONDER',
        responsibleId: '   ',
        actorId: responder.userId,
        actorType: 'RESPONDER',
      }),
    ).rejects.toThrow(FollowUpValidationError);
  });
});

describe('FOLLOWUP.md §5 — durable due and overdue jobs', () => {
  async function dueFollowUp() {
    const context = await activeCase();
    const followUp = await createFollowUp(pool, {
      tenantId: context.tenantId,
      caseId: context.caseId,
      dueAt: new Date(Date.now() - 1000),
      responsibleType: 'RESPONDER',
      responsibleId: context.responder.userId,
      actorId: context.responder.userId,
      actorType: 'RESPONDER',
    });
    return { ...context, followUp };
  }

  it('marks a due Follow-Up due and emits FOLLOWUP_DUE', async () => {
    const { tenantId, followUp } = await dueFollowUp();
    const result = await markFollowUpDue(pool, tenantId, {
      followUpId: followUp.followUpId,
      scheduleVersion: followUp.scheduleVersion,
    });

    expect(result.transitioned).toBe(true);
    expect((await findFollowUp(pool, tenantId, followUp.followUpId))?.status).toBe('DUE');

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'FollowUp',
      aggregateId: followUp.followUpId,
    });
    expect(events.filter((event) => event.eventType === 'FOLLOWUP_DUE')).toHaveLength(1);
  });

  it('emits one logical FOLLOWUP_DUE for a duplicate job delivery', async () => {
    const { tenantId, followUp } = await dueFollowUp();
    const item = { followUpId: followUp.followUpId, scheduleVersion: followUp.scheduleVersion };

    await markFollowUpDue(pool, tenantId, item);
    const second = await markFollowUpDue(pool, tenantId, item);

    expect(second.transitioned).toBe(false);
    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'FollowUp',
      aggregateId: followUp.followUpId,
    });
    expect(events.filter((event) => event.eventType === 'FOLLOWUP_DUE')).toHaveLength(1);
  });

  it('cannot mark a rescheduled Follow-Up due with the old schedule version', async () => {
    const { tenantId, followUp, responder } = await dueFollowUp();
    const stale = { followUpId: followUp.followUpId, scheduleVersion: followUp.scheduleVersion };

    const rescheduled = await rescheduleFollowUp(pool, {
      tenantId,
      followUpId: followUp.followUpId,
      newDueAt: new Date(Date.now() + 3_600_000),
      reason: 'veteran asked to be called next week',
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });
    expect(rescheduled.scheduleVersion).toBe(followUp.scheduleVersion + 1);

    const result = await markFollowUpDue(pool, tenantId, stale);
    expect(result.transitioned).toBe(false);
    expect((await findFollowUp(pool, tenantId, followUp.followUpId))?.status).toBe('SCHEDULED');
  });

  it('cannot mark a rescheduled Follow-Up overdue with the old schedule version', async () => {
    const { tenantId, followUp, responder } = await dueFollowUp();
    const stale = { followUpId: followUp.followUpId, scheduleVersion: followUp.scheduleVersion };

    await rescheduleFollowUp(pool, {
      tenantId,
      followUpId: followUp.followUpId,
      newDueAt: new Date(Date.now() + 3_600_000),
      reason: 'rescheduled',
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });

    expect((await markFollowUpOverdue(pool, tenantId, stale)).transitioned).toBe(false);
    expect((await findFollowUp(pool, tenantId, followUp.followUpId))?.status).toBe('SCHEDULED');
  });

  it('ignores a stale due job for a completed Follow-Up', async () => {
    const { tenantId, followUp, responder } = await dueFollowUp();
    await completeFollowUp(pool, {
      tenantId,
      followUpId: followUp.followUpId,
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });

    const result = await markFollowUpDue(pool, tenantId, {
      followUpId: followUp.followUpId,
      scheduleVersion: followUp.scheduleVersion,
    });
    expect(result.transitioned).toBe(false);
    expect((await findFollowUp(pool, tenantId, followUp.followUpId))?.status).toBe('COMPLETED');
  });

  it('ignores a stale due job for a cancelled Follow-Up', async () => {
    const { tenantId, followUp, responder } = await dueFollowUp();
    await cancelFollowUp(pool, {
      tenantId,
      followUpId: followUp.followUpId,
      reason: 'no longer needed',
      actorId: responder.userId,
    });

    expect(
      (
        await markFollowUpOverdue(pool, tenantId, {
          followUpId: followUp.followUpId,
          scheduleVersion: followUp.scheduleVersion,
        })
      ).transitioned,
    ).toBe(false);
    expect((await findFollowUp(pool, tenantId, followUp.followUpId))?.status).toBe('CANCELLED');
  });

  it('does not mark a future Follow-Up due', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    const followUp = await createFollowUp(pool, {
      tenantId,
      caseId,
      dueAt: new Date(Date.now() + 3_600_000),
      responsibleType: 'RESPONDER',
      responsibleId: responder.userId,
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });

    const result = await markFollowUpDue(pool, tenantId, {
      followUpId: followUp.followUpId,
      scheduleVersion: followUp.scheduleVersion,
    });
    expect(result.transitioned).toBe(false);
  });

  it('claims only work that is actually due', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    await createFollowUp(pool, {
      tenantId,
      caseId,
      dueAt: new Date(Date.now() - 1000),
      responsibleType: 'RESPONDER',
      responsibleId: responder.userId,
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });

    const claimed = await claimDueWork(pool);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.item.scheduleVersion).toBe(1);
  });

  it('emits no OVERDUE Domain Event, because the catalog defines none', async () => {
    const { tenantId, followUp } = await dueFollowUp();
    await markFollowUpOverdue(pool, tenantId, {
      followUpId: followUp.followUpId,
      scheduleVersion: followUp.scheduleVersion,
    });

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'FollowUp',
      aggregateId: followUp.followUpId,
    });
    // FOLLOWUP.md §9: OVERDUE is audited; inventing FOLLOWUP_OVERDUE would be an
    // unreconciled addition to the released catalog.
    expect(events.map((event) => event.eventType)).not.toContain('FOLLOWUP_OVERDUE');

    const audits = await pool.query(
      `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'FOLLOWUP_OVERDUE'`,
      [tenantId],
    );
    expect(audits.rowCount).toBe(1);
  });
});

describe('FOLLOWUP.md §6 — completion, reschedule, cancellation', () => {
  async function scheduled() {
    const context = await activeCase();
    const followUp = await createFollowUp(pool, {
      tenantId: context.tenantId,
      caseId: context.caseId,
      dueAt: new Date(Date.now() + 60_000),
      responsibleType: 'RESPONDER',
      responsibleId: context.responder.userId,
      actorId: context.responder.userId,
      actorType: 'RESPONDER',
    });
    return { ...context, followUp };
  }

  it('completes once and emits one FOLLOWUP_COMPLETED', async () => {
    const { tenantId, followUp, responder } = await scheduled();
    const input = {
      tenantId,
      followUpId: followUp.followUpId,
      actorId: responder.userId,
      actorType: 'RESPONDER' as const,
    };

    const first = await completeFollowUp(pool, input);
    const replay = await completeFollowUp(pool, input);

    expect(first.alreadyCompleted).toBe(false);
    expect(replay.alreadyCompleted).toBe(true);

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'FollowUp',
      aggregateId: followUp.followUpId,
    });
    expect(events.filter((event) => event.eventType === 'FOLLOWUP_COMPLETED')).toHaveLength(1);
  });

  it('is idempotent for duplicate cancellation', async () => {
    const { tenantId, followUp, responder } = await scheduled();
    const input = {
      tenantId,
      followUpId: followUp.followUpId,
      reason: 'veteran resolved it themselves',
      actorId: responder.userId,
    };

    expect((await cancelFollowUp(pool, input)).alreadyCancelled).toBe(false);
    expect((await cancelFollowUp(pool, input)).alreadyCancelled).toBe(true);
  });

  it('requires a reason to reschedule or cancel', async () => {
    const { tenantId, followUp, responder } = await scheduled();
    await expect(
      rescheduleFollowUp(pool, {
        tenantId,
        followUpId: followUp.followUpId,
        newDueAt: new Date(Date.now() + 120_000),
        reason: '  ',
        actorId: responder.userId,
        actorType: 'RESPONDER',
      }),
    ).rejects.toThrow(FollowUpValidationError);

    await expect(
      cancelFollowUp(pool, {
        tenantId,
        followUpId: followUp.followUpId,
        reason: '',
        actorId: responder.userId,
      }),
    ).rejects.toThrow(FollowUpValidationError);
  });

  it('refuses to complete a cancelled Follow-Up', async () => {
    const { tenantId, followUp, responder } = await scheduled();
    await cancelFollowUp(pool, {
      tenantId,
      followUpId: followUp.followUpId,
      reason: 'not needed',
      actorId: responder.userId,
    });

    await expect(
      completeFollowUp(pool, {
        tenantId,
        followUpId: followUp.followUpId,
        actorId: responder.userId,
        actorType: 'RESPONDER',
      }),
    ).rejects.toThrow(FollowUpValidationError);
  });
});

describe('FOLLOWUP.md §4 — coordination retry count is business meaning', () => {
  it('increments only on an explicit coordination attempt', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    const followUp = await createFollowUp(pool, {
      tenantId,
      caseId,
      dueAt: new Date(Date.now() - 1000),
      responsibleType: 'RESPONDER',
      responsibleId: responder.userId,
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });

    expect(await recordCoordinationAttempt(pool, tenantId, followUp.followUpId)).toBe(1);

    // Duplicate job delivery is infrastructure, not a coordination attempt, so it
    // must leave the business counter alone (FOLLOWUP.md §4, §10).
    const item = { followUpId: followUp.followUpId, scheduleVersion: followUp.scheduleVersion };
    await markFollowUpDue(pool, tenantId, item);
    await markFollowUpDue(pool, tenantId, item);
    await markFollowUpOverdue(pool, tenantId, item);

    expect(
      (await findFollowUp(pool, tenantId, followUp.followUpId))?.coordinationAttemptCount,
    ).toBe(1);
  });
});

describe('SETTLEMENT.md §2, §5 — resolve requires complete Settlement content', () => {
  it('refuses incomplete content and leaves the case unresolved', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    await expect(
      resolveCaseWithSettlement(pool, {
        tenantId,
        caseId,
        actorId: responder.userId,
        content: {
          ...content(responder.userId),
          authoredBy: '',
        },
      }),
    ).rejects.toThrow(SettlementContentError);

    expect((await findCase(pool, tenantId, caseId))?.status).toBe('ACTIVE');
  });

  it('refuses without an active assignment', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await user(tenantId, 'veteran');
    const responder = await user(tenantId, 'responder');
    const opened = await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'RESPONDER',
        actorId: responder.userId,
      }),
    );

    await expect(
      resolveCaseWithSettlement(pool, {
        tenantId,
        caseId: opened.supportCase.caseId,
        actorId: responder.userId,
        content: content(responder.userId),
      }),
    ).rejects.toThrow();
  });

  it('resolves and records the Settlement', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    const result = await resolveCaseWithSettlement(pool, {
      tenantId,
      caseId,
      actorId: responder.userId,
      content: content(responder.userId),
    });

    expect(result.supportCase.status).toBe('RESOLVED');
    expect(result.settlement.resolutionCycle).toBe(1);

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: caseId,
    });
    const resolved = events.find((event) => event.eventType === 'CASE_RESOLVED');
    expect(resolved?.payload).toMatchObject({
      settlement_id: result.settlement.settlementId,
      resolution_cycle: 1,
    });
  });

  it('caches the current Settlement on the case without replacing history', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    const result = await resolveCaseWithSettlement(pool, {
      tenantId,
      caseId,
      actorId: responder.userId,
      content: content(responder.userId),
    });

    const cached = await pool.query<{ current_settlement_id: string }>(
      'SELECT current_settlement_id FROM support_cases WHERE case_id = $1',
      [caseId],
    );
    expect(cached.rows[0]?.current_settlement_id).toBe(result.settlement.settlementId);
    expect((await findCurrentSettlement(pool, tenantId, caseId))?.settlementId).toBe(
      result.settlement.settlementId,
    );
  });

  it('refuses a stale resolve whose expected state no longer holds', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    await expect(
      resolveCaseWithSettlement(pool, {
        tenantId,
        caseId,
        actorId: responder.userId,
        content: content(responder.userId),
        expectedStatus: 'FOLLOWUP',
      }),
    ).rejects.toThrow();
  });
});

describe('SETTLEMENT.md §5.3 — resolve is idempotent', () => {
  it('creates one Settlement and one CASE_RESOLVED for a replayed command', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    const input = {
      tenantId,
      caseId,
      actorId: responder.userId,
      content: content(responder.userId),
      idempotencyKey: 'resolve-command-1',
    };

    const first = await resolveCaseWithSettlement(pool, input);
    const replay = await resolveCaseWithSettlement(pool, input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.settlement.settlementId).toBe(first.settlement.settlementId);

    expect(await listSettlements(pool, tenantId, caseId)).toHaveLength(1);
    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: caseId,
    });
    expect(events.filter((event) => event.eventType === 'CASE_RESOLVED')).toHaveLength(1);
  });
});

describe('SETTLEMENT.md §4, FOLLOWUP.md §8 — blocking and carried-forward', () => {
  async function caseWithFollowUp(disposition?: 'BLOCKING' | 'CARRIED_FORWARD') {
    const context = await activeCase();
    const followUp = await createFollowUp(pool, {
      tenantId: context.tenantId,
      caseId: context.caseId,
      dueAt: new Date(Date.now() + 86_400_000),
      responsibleType: 'RESPONDER',
      responsibleId: context.responder.userId,
      actorId: context.responder.userId,
      actorType: 'RESPONDER',
      ...(disposition !== undefined ? { resolutionDisposition: disposition } : {}),
    });
    return { ...context, followUp };
  }

  it('refuses to resolve with an unclassified open Follow-Up', async () => {
    const { tenantId, caseId, responder } = await caseWithFollowUp();
    await expect(
      resolveCaseWithSettlement(pool, {
        tenantId,
        caseId,
        actorId: responder.userId,
        content: content(responder.userId),
      }),
    ).rejects.toThrow(UnclassifiedFollowUpError);
  });

  it('refuses to resolve with a blocking open Follow-Up', async () => {
    const { tenantId, caseId, responder } = await caseWithFollowUp('BLOCKING');
    await expect(
      resolveCaseWithSettlement(pool, {
        tenantId,
        caseId,
        actorId: responder.userId,
        content: content(responder.userId),
      }),
    ).rejects.toThrow(BlockingFollowUpError);
  });

  it('resolves with a carried-forward Follow-Up, recording owner and due date', async () => {
    const { tenantId, caseId, responder, followUp } = await caseWithFollowUp('CARRIED_FORWARD');
    const result = await resolveCaseWithSettlement(pool, {
      tenantId,
      caseId,
      actorId: responder.userId,
      content: content(responder.userId),
    });

    expect(result.supportCase.status).toBe('RESOLVED');
    expect(result.settlement.remainingFollowUps).toHaveLength(1);
    expect(result.settlement.remainingFollowUps[0]).toMatchObject({
      follow_up_id: followUp.followUpId,
      responsible_type: 'RESPONDER',
      responsible_id: responder.userId,
    });
    expect(result.settlement.remainingFollowUps[0]).toHaveProperty('due_at');
  });

  it('leaves a carried-forward Follow-Up open and owned after resolution', async () => {
    const { tenantId, caseId, responder, followUp } = await caseWithFollowUp('CARRIED_FORWARD');
    await resolveCaseWithSettlement(pool, {
      tenantId,
      caseId,
      actorId: responder.userId,
      content: content(responder.userId),
    });

    // FOLLOWUP.md §8: resolution never auto-completes a Follow-Up.
    const after = await findFollowUp(pool, tenantId, followUp.followUpId);
    expect(after?.status).toBe('SCHEDULED');
    expect(after?.responsibleId).toBe(responder.userId);
  });

  it('resolves once a blocking Follow-Up is completed', async () => {
    const { tenantId, caseId, responder, followUp } = await caseWithFollowUp('BLOCKING');
    await completeFollowUp(pool, {
      tenantId,
      followUpId: followUp.followUpId,
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });

    const result = await resolveCaseWithSettlement(pool, {
      tenantId,
      caseId,
      actorId: responder.userId,
      content: content(responder.userId),
    });
    expect(result.supportCase.status).toBe('RESOLVED');
  });

  it('lets a disposition be set after creation', async () => {
    const { tenantId, followUp } = await caseWithFollowUp();
    const updated = await setResolutionDisposition(pool, {
      tenantId,
      followUpId: followUp.followUpId,
      disposition: 'CARRIED_FORWARD',
    });
    expect(updated?.resolutionDisposition).toBe('CARRIED_FORWARD');
  });
});

describe('SETTLEMENT.md §3 — multi-cycle resolution history', () => {
  async function resolvedCase() {
    const context = await activeCase();
    const first = await resolveCaseWithSettlement(pool, {
      tenantId: context.tenantId,
      caseId: context.caseId,
      actorId: context.responder.userId,
      content: content(context.responder.userId),
    });
    return { ...context, first };
  }

  it('preserves the prior Settlement across close, reopen, and re-resolution', async () => {
    const { tenantId, caseId, responder, first } = await resolvedCase();

    await executeCaseCommand(pool, {
      tenantId,
      caseId,
      command: 'CLOSE',
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });
    await executeCaseCommand(pool, {
      tenantId,
      caseId,
      command: 'REOPEN',
      actorId: responder.userId,
      actorType: 'ORG_ADMIN',
      reason: 'the need recurred',
    });

    await claimCase(pool, { tenantId, caseId, responderUserId: responder.userId });
    await executeCaseCommand(pool, {
      tenantId,
      caseId,
      command: 'ACTIVATE',
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });

    const second = await resolveCaseWithSettlement(pool, {
      tenantId,
      caseId,
      actorId: responder.userId,
      content: content(responder.userId),
    });

    // SETTLEMENT.md §3.1-§3.3: a later cycle, a new record, prior history intact.
    expect(second.settlement.resolutionCycle).toBe(2);
    expect(second.settlement.settlementId).not.toBe(first.settlement.settlementId);

    const history = await listSettlements(pool, tenantId, caseId);
    expect(history.map((item) => item.resolutionCycle)).toEqual([1, 2]);
    expect(history[0]?.settlementId).toBe(first.settlement.settlementId);
  });

  it('points the current projection at the latest cycle deterministically', async () => {
    const { tenantId, caseId, responder, first } = await resolvedCase();
    await executeCaseCommand(pool, {
      tenantId,
      caseId,
      command: 'CLOSE',
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });
    await executeCaseCommand(pool, {
      tenantId,
      caseId,
      command: 'REOPEN',
      actorId: responder.userId,
      actorType: 'ORG_ADMIN',
      reason: 'recurrence',
    });
    await claimCase(pool, { tenantId, caseId, responderUserId: responder.userId });
    await executeCaseCommand(pool, {
      tenantId,
      caseId,
      command: 'ACTIVATE',
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });
    const second = await resolveCaseWithSettlement(pool, {
      tenantId,
      caseId,
      actorId: responder.userId,
      content: content(responder.userId),
    });

    const current = await findCurrentSettlement(pool, tenantId, caseId);
    expect(current?.settlementId).toBe(second.settlement.settlementId);
    expect(current?.settlementId).not.toBe(first.settlement.settlementId);
  });

  it('refuses to rewrite a committed Settlement', async () => {
    const { first } = await resolvedCase();

    await expect(
      pool.query(
        `UPDATE settlements SET unresolved_summary = '{"tampered":true}' WHERE settlement_id = $1`,
        [first.settlement.settlementId],
      ),
    ).rejects.toThrow(/cannot be rewritten/);

    await expect(
      pool.query('DELETE FROM settlements WHERE settlement_id = $1', [
        first.settlement.settlementId,
      ]),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('refuses a second Settlement for the same cycle', async () => {
    const { tenantId, caseId, responder } = await resolvedCase();
    const { createSettlement } = await import('../../src/settlement/index.js');

    await expect(
      createSettlement(pool, {
        tenantId,
        caseId,
        resolutionCycle: 1,
        content: content(responder.userId),
        remainingFollowUps: [],
      }),
    ).rejects.toThrow();
  });
});

describe('SETTLEMENT.md §6 — veteran visibility', () => {
  it('excludes internal referenced records from the veteran projection', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    const result = await resolveCaseWithSettlement(pool, {
      tenantId,
      caseId,
      actorId: responder.userId,
      content: content(responder.userId),
    });

    const projection = veteranVisibleSettlement(result.settlement);
    // The occurred summary references Contact Attempts and internal responder
    // actions, which a Settlement reference does not make veteran-visible.
    expect(projection).not.toHaveProperty('occurred');
    expect(projection).not.toHaveProperty('responder_confirmed_by');
    expect(projection).not.toHaveProperty('authored_by');
    expect(projection).toHaveProperty('unresolved');
    expect(projection).toHaveProperty('remaining_follow_ups');
  });
});

describe('CASES.md §7 — blocking Service Requests still apply', () => {
  it('refuses to resolve while a non-terminal Service Request remains', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId,
        category: 'FOOD',
        createdBy: responder.userId,
        actorType: 'RESPONDER',
      }),
    );

    await expect(
      resolveCaseWithSettlement(pool, {
        tenantId,
        caseId,
        actorId: responder.userId,
        content: content(responder.userId),
      }),
    ).rejects.toThrow();
  });

  it('resolves once the Service Request is terminal', async () => {
    const { tenantId, caseId, responder } = await activeCase();
    const request = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId,
        category: 'FOOD',
        createdBy: responder.userId,
        actorType: 'RESPONDER',
      }),
    );
    await executeServiceRequestCommand(pool, {
      tenantId,
      serviceRequestId: request.serviceRequestId,
      command: 'CANCEL',
      actorId: responder.userId,
      actorType: 'RESPONDER',
      reason: 'no longer needed',
    });

    const result = await resolveCaseWithSettlement(pool, {
      tenantId,
      caseId,
      actorId: responder.userId,
      content: content(responder.userId),
    });
    expect(result.supportCase.status).toBe('RESOLVED');
  });
});
