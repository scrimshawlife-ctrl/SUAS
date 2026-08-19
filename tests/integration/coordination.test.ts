/**
 * Coordination kernel integration evidence (requires PostgreSQL).
 *
 * SUAS-specs CASES.md §3.1 (atomic creation), §5 (atomic claim and assignment),
 * §7 (resolution), §9 (queue), §11 (critical suite: case transitions and
 * concurrency); DISPATCH.md §3, §6, §12; RESPONDER_WORKFLOWS.md §3, §4, §7, §12;
 * CONSENT.md §3.6, §3.8.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import { listAggregateEvents } from '../../src/events/index.js';
import {
  addCaseNote,
  assignCase,
  BlockingWorkError,
  claimCase,
  ContactOutcomeRequiredError,
  createAssignmentVerifier,
  createServiceRequest,
  DisclosureGuardRequiredError,
  executeCaseCommand,
  executeServiceRequestCommand,
  findActiveAssignment,
  findCase,
  IllegalCaseTransitionError,
  listContactAttempts,
  NoActiveAssignmentError,
  NotAssignedResponderError,
  openCase,
  readCaseQueue,
  recordContact,
  resolveCase,
  SettlementRequiredError,
  StaleCaseStateError,
} from '../../src/coordination/index.js';
import { createUser } from '../../src/identity/index.js';
import { evaluateDisclosure } from '../../src/consent/index.js';
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

async function scenario() {
  const tenantId = syntheticTenantId();
  const veteran = await user(tenantId, 'veteran');
  const responder = await user(tenantId, 'responder');
  const other = await user(tenantId, 'responder-b');
  const opened = await withTransaction(pool, (tx) =>
    openCase(tx, {
      tenantId,
      veteranUserId: veteran.userId,
      actorType: 'RESPONDER',
      actorId: responder.userId,
    }),
  );
  return { tenantId, veteran, responder, other, supportCase: opened.supportCase };
}

describe('CASES.md §3.1 — atomic creation invariant', () => {
  it('creates one case and emits CASE_CREATED once', async () => {
    const { tenantId, supportCase } = await scenario();
    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    expect(events.filter((event) => event.eventType === 'CASE_CREATED')).toHaveLength(1);
  });

  it('resolves a duplicate open to the existing case rather than creating a second', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await user(tenantId, 'veteran');

    const first = await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'SYSTEM',
        actorId: 'signal',
      }),
    );
    const second = await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'SYSTEM',
        actorId: 'signal',
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.supportCase.caseId).toBe(first.supportCase.caseId);
  });

  it('yields one logical case under concurrent creation', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await user(tenantId, 'veteran');

    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        withTransaction(pool, (tx) =>
          openCase(tx, {
            tenantId,
            veteranUserId: veteran.userId,
            actorType: 'SYSTEM',
            actorId: 'signal',
          }),
        ),
      ),
    );

    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof openCase>>> =>
        attempt.status === 'fulfilled',
    );
    const created = fulfilled.filter((attempt) => attempt.value.created);
    expect(created).toHaveLength(1);

    const rows = await pool.query('SELECT case_id FROM support_cases WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it('permits a new case only once the previous one is closed', async () => {
    const { tenantId, veteran, responder, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });
    await executeCaseCommand(pool, {
      tenantId,
      caseId: supportCase.caseId,
      command: 'ACTIVATE',
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });

    // A second non-closed case for the same veteran is refused while one is open.
    const blocked = await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'RESPONDER',
        actorId: responder.userId,
      }),
    );
    expect(blocked.created).toBe(false);
  });
});

describe('CASES.md §5 — atomic claim', () => {
  it('assigns the case to the claiming responder', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    const result = await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    expect(result.supportCase.status).toBe('ASSIGNED');
    expect(result.assignment.responderUserId).toBe(responder.userId);
  });

  it('produces exactly one winner under concurrent claims', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();

    const outcomes = await Promise.allSettled([
      claimCase(pool, { tenantId, caseId: supportCase.caseId, responderUserId: responder.userId }),
      claimCase(pool, { tenantId, caseId: supportCase.caseId, responderUserId: other.userId }),
      claimCase(pool, { tenantId, caseId: supportCase.caseId, responderUserId: responder.userId }),
    ]);

    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(winners).toHaveLength(1);

    const assignments = await pool.query(
      `SELECT 1 FROM case_assignments WHERE case_id = $1 AND status = 'ACTIVE'`,
      [supportCase.caseId],
    );
    expect(assignments.rowCount).toBe(1);
  });

  it('emits CASE_ASSIGNED once per logical assignment', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();
    await Promise.allSettled([
      claimCase(pool, { tenantId, caseId: supportCase.caseId, responderUserId: responder.userId }),
      claimCase(pool, { tenantId, caseId: supportCase.caseId, responderUserId: other.userId }),
    ]);

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    expect(events.filter((event) => event.eventType === 'CASE_ASSIGNED')).toHaveLength(1);
  });

  it('conflicts when the case was already claimed, writing nothing', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    await expect(
      claimCase(pool, { tenantId, caseId: supportCase.caseId, responderUserId: other.userId }),
    ).rejects.toThrow(IllegalCaseTransitionError);

    const assignment = await findActiveAssignment(pool, supportCase.caseId);
    expect(assignment?.responderUserId).toBe(responder.userId);
  });

  it('conflicts safely on a stale queue item', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    // The second responder still believes the case is OPEN, as their queue showed.
    await expect(
      claimCase(pool, {
        tenantId,
        caseId: supportCase.caseId,
        responderUserId: other.userId,
        expectedStatus: 'OPEN',
      }),
    ).rejects.toThrow(StaleCaseStateError);
  });
});

describe('CASES.md §5.7 — reassignment is atomic', () => {
  it('releases the prior assignment and creates the successor', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();
    const first = await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    const second = await assignCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: other.userId,
      assignedBy: other.userId,
    });

    expect(second.assignment.responderUserId).toBe(other.userId);

    const active = await findActiveAssignment(pool, supportCase.caseId);
    expect(active?.caseAssignmentId).toBe(second.assignment.caseAssignmentId);

    const prior = await pool.query<{ status: string }>(
      'SELECT status FROM case_assignments WHERE case_assignment_id = $1',
      [first.assignment.caseAssignmentId],
    );
    expect(prior.rows[0]?.status).toBe('REASSIGNED');
  });

  it('never leaves two active owners under concurrent reassignment', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    await Promise.allSettled([
      assignCase(pool, {
        tenantId,
        caseId: supportCase.caseId,
        responderUserId: other.userId,
        assignedBy: other.userId,
      }),
      assignCase(pool, {
        tenantId,
        caseId: supportCase.caseId,
        responderUserId: responder.userId,
        assignedBy: responder.userId,
      }),
    ]);

    const active = await pool.query(
      `SELECT 1 FROM case_assignments WHERE case_id = $1 AND status = 'ACTIVE'`,
      [supportCase.caseId],
    );
    expect(active.rowCount).toBe(1);
  });
});

describe('CASES.md §4.1 — unassigned cases cannot use assigned-responder edges', () => {
  it('refuses ESCALATE on an unassigned OPEN case', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    await expect(
      executeCaseCommand(pool, {
        tenantId,
        caseId: supportCase.caseId,
        command: 'ESCALATE',
        actorId: responder.userId,
        actorType: 'RESPONDER',
        reason: 'urgent',
      }),
    ).rejects.toThrow(IllegalCaseTransitionError);
  });

  it('allows ESCALATE once assigned, and records the event', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    const escalated = await executeCaseCommand(pool, {
      tenantId,
      caseId: supportCase.caseId,
      command: 'ESCALATE',
      actorId: responder.userId,
      actorType: 'RESPONDER',
      reason: 'no responder available in region',
    });
    expect(escalated.status).toBe('ACTIVE');

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    expect(events.some((event) => event.eventType === 'CASE_ESCALATED')).toBe(true);
  });

  it('refuses a responder who is not the assigned one', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    await expect(
      executeCaseCommand(pool, {
        tenantId,
        caseId: supportCase.caseId,
        command: 'ACTIVATE',
        actorId: other.userId,
        actorType: 'RESPONDER',
      }),
    ).rejects.toThrow(NotAssignedResponderError);
  });
});

describe('CASES.md §7 — resolution requires a Settlement', () => {
  async function activeCase() {
    const context = await scenario();
    await claimCase(pool, {
      tenantId: context.tenantId,
      caseId: context.supportCase.caseId,
      responderUserId: context.responder.userId,
    });
    await executeCaseCommand(pool, {
      tenantId: context.tenantId,
      caseId: context.supportCase.caseId,
      command: 'ACTIVATE',
      actorId: context.responder.userId,
      actorType: 'RESPONDER',
    });
    return context;
  }

  it('refuses to resolve while Settlement does not exist', async () => {
    const { tenantId, responder, supportCase } = await activeCase();
    await expect(
      resolveCase(pool, { tenantId, caseId: supportCase.caseId, actorId: responder.userId }),
    ).rejects.toThrow(SettlementRequiredError);

    expect((await findCase(pool, tenantId, supportCase.caseId))?.status).toBe('ACTIVE');
  });

  it('refuses to resolve when the verifier reports no Settlement', async () => {
    const { tenantId, responder, supportCase } = await activeCase();
    await expect(
      resolveCase(
        pool,
        { tenantId, caseId: supportCase.caseId, actorId: responder.userId },
        { verifySettlement: () => Promise.resolve(false) },
      ),
    ).rejects.toThrow(SettlementRequiredError);
  });

  it('refuses to resolve while a non-terminal Service Request remains', async () => {
    const { tenantId, responder, supportCase } = await activeCase();
    await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId: supportCase.caseId,
        category: 'FOOD',
        createdBy: responder.userId,
        actorType: 'RESPONDER',
      }),
    );

    await expect(
      resolveCase(
        pool,
        { tenantId, caseId: supportCase.caseId, actorId: responder.userId },
        { verifySettlement: () => Promise.resolve(true) },
      ),
    ).rejects.toThrow(BlockingWorkError);
  });

  it('resolves once blocking work is terminal and a Settlement exists', async () => {
    const { tenantId, responder, supportCase } = await activeCase();
    const request = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId: supportCase.caseId,
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
      reason: 'veteran no longer needs it',
    });

    const resolved = await resolveCase(
      pool,
      { tenantId, caseId: supportCase.caseId, actorId: responder.userId },
      { verifySettlement: () => Promise.resolve(true) },
    );
    expect(resolved.status).toBe('RESOLVED');

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    expect(events.filter((event) => event.eventType === 'CASE_RESOLVED')).toHaveLength(1);
  });
});

describe('RESPONDER_WORKFLOWS.md §7 — contact log', () => {
  async function assignedCase() {
    const context = await scenario();
    await claimCase(pool, {
      tenantId: context.tenantId,
      caseId: context.supportCase.caseId,
      responderUserId: context.responder.userId,
    });
    return context;
  }

  it('records a contact attempt and emits RESPONDER_CONTACT_LOGGED', async () => {
    const { tenantId, responder, supportCase } = await assignedCase();
    const result = await recordContact(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
      command: 'log-contact-attempt',
      channel: 'PHONE',
      outcome: 'NO_ANSWER',
    });

    expect(result.deduplicated).toBe(false);

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    const logged = events.find((event) => event.eventType === 'RESPONDER_CONTACT_LOGGED');
    expect(logged?.payload).toMatchObject({
      channel: 'PHONE',
      outcome: 'NO_ANSWER',
      command: 'log-contact-attempt',
      actor_id: responder.userId,
    });
  });

  it('requires an active assignment', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    await expect(
      recordContact(pool, {
        tenantId,
        caseId: supportCase.caseId,
        responderUserId: responder.userId,
        command: 'log-contact-attempt',
        channel: 'PHONE',
        outcome: 'PENDING',
      }),
    ).rejects.toThrow(NoActiveAssignmentError);
  });

  it('refuses complete-contact with a PENDING outcome', async () => {
    const { tenantId, responder, supportCase } = await assignedCase();
    await expect(
      recordContact(pool, {
        tenantId,
        caseId: supportCase.caseId,
        responderUserId: responder.userId,
        command: 'complete-contact',
        channel: 'PHONE',
        outcome: 'PENDING',
      }),
    ).rejects.toThrow(ContactOutcomeRequiredError);
  });

  it('does not duplicate the contact fact when a command is replayed', async () => {
    const { tenantId, responder, supportCase } = await assignedCase();
    const input = {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
      command: 'complete-contact' as const,
      channel: 'PHONE' as const,
      outcome: 'REACHED' as const,
      idempotencyKey: 'contact-command-1',
    };

    const first = await recordContact(pool, input);
    const replay = await recordContact(pool, input);

    expect(replay.deduplicated).toBe(true);
    expect(replay.contactAttempt.contactAttemptId).toBe(first.contactAttempt.contactAttemptId);
    expect(await listContactAttempts(pool, tenantId, supportCase.caseId)).toHaveLength(1);
  });

  it('does not emit RESPONDER_CONTACT_LOGGED for a Case Note', async () => {
    const { tenantId, responder, supportCase } = await assignedCase();
    await addCaseNote(pool, {
      tenantId,
      caseId: supportCase.caseId,
      authorUserId: responder.userId,
      body: 'Left a voicemail; will try again tomorrow.',
    });

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    expect(events.some((event) => event.eventType === 'RESPONDER_CONTACT_LOGGED')).toBe(false);
  });
});

describe('DISPATCH.md §3, §6, §8 — Service Request commands', () => {
  async function matchingRequest() {
    const context = await scenario();
    await claimCase(pool, {
      tenantId: context.tenantId,
      caseId: context.supportCase.caseId,
      responderUserId: context.responder.userId,
    });
    const request = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId: context.tenantId,
        caseId: context.supportCase.caseId,
        category: 'TRANSPORTATION',
        createdBy: context.responder.userId,
        actorType: 'RESPONDER',
      }),
    );

    const base = {
      tenantId: context.tenantId,
      serviceRequestId: request.serviceRequestId,
      actorId: context.responder.userId,
      actorType: 'RESPONDER' as const,
    };
    await executeServiceRequestCommand(pool, { ...base, command: 'SUBMIT' });
    await executeServiceRequestCommand(pool, { ...base, command: 'TRIAGE' });
    await executeServiceRequestCommand(pool, { ...base, command: 'START_MATCHING' });
    return { ...context, request, base };
  }

  it('emits SERVICE_REQUEST_CREATED on creation', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    const request = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId: supportCase.caseId,
        category: 'FOOD',
        createdBy: responder.userId,
        actorType: 'RESPONDER',
      }),
    );

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'ServiceRequest',
      aggregateId: request.serviceRequestId,
    });
    expect(events.map((event) => event.eventType)).toContain('SERVICE_REQUEST_CREATED');
  });

  it('refuses an externally disclosing assignment with no consent evaluation', async () => {
    const { base } = await matchingRequest();
    await expect(
      executeServiceRequestCommand(pool, { ...base, command: 'ASSIGN', granteeId: 'adapter-1' }),
    ).rejects.toThrow(DisclosureGuardRequiredError);
  });

  it('assigns when the disclosure guard allows it, and emits the event once', async () => {
    const { tenantId, base, request } = await matchingRequest();
    const seen: string[] = [];

    const assigned = await executeServiceRequestCommand(
      pool,
      { ...base, command: 'ASSIGN', granteeId: 'adapter-1' },
      {
        disclosureGuard: (params) => {
          seen.push(params.granteeId);
          return Promise.resolve();
        },
      },
    );

    expect(assigned.status).toBe('ASSIGNED');
    expect(seen).toEqual(['adapter-1']);

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'ServiceRequest',
      aggregateId: request.serviceRequestId,
    });
    expect(events.filter((event) => event.eventType === 'SERVICE_REQUEST_ASSIGNED')).toHaveLength(
      1,
    );
  });

  it('re-evaluates disclosure on a reroute rather than reusing the prior decision', async () => {
    const { base } = await matchingRequest();
    const grantees: string[] = [];
    const guard = (params: { granteeId: string }) => {
      grantees.push(params.granteeId);
      return Promise.resolve();
    };

    await executeServiceRequestCommand(
      pool,
      { ...base, command: 'ASSIGN', granteeId: 'adapter-1' },
      { disclosureGuard: guard },
    );
    await executeServiceRequestCommand(pool, {
      ...base,
      command: 'DECLINE',
      reason: 'provider unavailable',
    });
    await executeServiceRequestCommand(pool, { ...base, command: 'REMATCH' });
    await executeServiceRequestCommand(
      pool,
      { ...base, command: 'ASSIGN', granteeId: 'adapter-2' },
      { disclosureGuard: guard },
    );

    // CONSENT.md §3.11: the new grantee gets its own decision.
    expect(grantees).toEqual(['adapter-1', 'adapter-2']);
  });

  it('produces one winner under concurrent assignment from MATCHING', async () => {
    const { base } = await matchingRequest();
    const guard = () => Promise.resolve();

    const outcomes = await Promise.allSettled([
      executeServiceRequestCommand(
        pool,
        { ...base, command: 'ASSIGN', granteeId: 'adapter-1' },
        { disclosureGuard: guard },
      ),
      executeServiceRequestCommand(
        pool,
        { ...base, command: 'ASSIGN', granteeId: 'adapter-2' },
        { disclosureGuard: guard },
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects an unknown category', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    await expect(
      withTransaction(pool, (tx) =>
        createServiceRequest(tx, {
          tenantId,
          caseId: supportCase.caseId,
          category: 'HOUSING',
          createdBy: responder.userId,
          actorType: 'RESPONDER',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('CONSENT.md §3.6 — the assignment verifier', () => {
  it('reports an active assignment for the assigned responder', async () => {
    const { tenantId, veteran, responder, other, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    const verify = createAssignmentVerifier(pool);
    expect(
      await verify({ tenantId, responderUserId: responder.userId, veteranUserId: veteran.userId }),
    ).toBe(true);
    expect(
      await verify({ tenantId, responderUserId: other.userId, veteranUserId: veteran.userId }),
    ).toBe(false);
  });

  it('lets the consent kernel grant responder access on that basis', async () => {
    const { tenantId, veteran, responder, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    // Slice 4 denied this basis for want of a verifier; Slice 5 supplies one.
    const decision = await evaluateDisclosure(
      pool,
      {
        tenantId,
        veteranUserId: veteran.userId,
        permission: 'can_view',
        scope: 'current_requests',
        granteeType: 'RESPONDER',
        granteeId: responder.userId,
        purpose: 'Coordinate an assigned case',
        systemBasis: 'RESPONDER_CASE_ASSIGNMENT',
      },
      { verifyActiveAssignment: createAssignmentVerifier(pool) },
    );

    expect(decision).toMatchObject({ allowed: true, basis: 'RESPONDER_CASE_ASSIGNMENT' });
  });

  it('denies once the assignment is released', async () => {
    const { tenantId, veteran, responder, other, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });
    await assignCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: other.userId,
      assignedBy: other.userId,
    });

    const decision = await evaluateDisclosure(
      pool,
      {
        tenantId,
        veteranUserId: veteran.userId,
        permission: 'can_view',
        scope: 'current_requests',
        granteeType: 'RESPONDER',
        granteeId: responder.userId,
        purpose: 'Coordinate a case I no longer hold',
        systemBasis: 'RESPONDER_CASE_ASSIGNMENT',
      },
      { verifyActiveAssignment: createAssignmentVerifier(pool) },
    );

    expect(decision.allowed).toBe(false);
  });
});

describe('RESPONDER_WORKFLOWS.md §4 — queue contract', () => {
  it('never returns another tenant’s cases', async () => {
    const a = await scenario();
    const b = await scenario();

    const page = await readCaseQueue(pool, a.tenantId);
    expect(page.cases.map((item) => item.caseId)).toEqual([a.supportCase.caseId]);
    expect(page.cases.map((item) => item.caseId)).not.toContain(b.supportCase.caseId);
  });

  it('bounds the page and paginates with a stable cursor', async () => {
    const tenantId = syntheticTenantId();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const veteran = await user(tenantId, `veteran-${i}`);
      const opened = await withTransaction(pool, (tx) =>
        openCase(tx, {
          tenantId,
          veteranUserId: veteran.userId,
          actorType: 'SYSTEM',
          actorId: 'seed',
        }),
      );
      created.push(opened.supportCase.caseId);
    }

    const first = await readCaseQueue(pool, tenantId, {}, { limit: 2 });
    expect(first.cases).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const cursor = first.nextCursor;
    if (cursor === undefined) throw new Error('Expected a next-page cursor.');
    const second = await readCaseQueue(pool, tenantId, {}, { limit: 2, cursor });
    expect(second.cases).toHaveLength(2);

    const seen = [...first.cases, ...second.cases].map((item) => item.caseId);
    expect(new Set(seen).size).toBe(4);
  });

  it('caps the page size regardless of what is asked for', async () => {
    const { tenantId } = await scenario();
    const page = await readCaseQueue(pool, tenantId, {}, { limit: 5000 });
    expect(page.cases.length).toBeLessThanOrEqual(100);
  });

  it('filters by ownership', async () => {
    const { tenantId, responder, supportCase } = await scenario();

    const unassignedBefore = await readCaseQueue(pool, tenantId, { ownership: 'unassigned' });
    expect(unassignedBefore.cases).toHaveLength(1);

    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    const unassignedAfter = await readCaseQueue(pool, tenantId, { ownership: 'unassigned' });
    expect(unassignedAfter.cases).toHaveLength(0);

    const mine = await readCaseQueue(pool, tenantId, {
      ownership: 'mine',
      responderUserId: responder.userId,
    });
    expect(mine.cases.map((item) => item.caseId)).toEqual([supportCase.caseId]);
  });

  it('filters by status', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });

    expect((await readCaseQueue(pool, tenantId, { statuses: ['ASSIGNED'] })).cases).toHaveLength(1);
    expect((await readCaseQueue(pool, tenantId, { statuses: ['OPEN'] })).cases).toHaveLength(0);
  });
});
