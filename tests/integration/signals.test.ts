/**
 * Check-In and Support Signal integration evidence (requires PostgreSQL).
 *
 * SUAS-specs CHECKINS.md §4-§7, §10; SUPPORT_SIGNALS.md §2-§7, §11;
 * EVENT_MODEL.md §3.1-§3.2; TESTING.md §3.1, §12.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAggregateEvents } from '../../src/events/index.js';
import { InMemoryJobQueue } from '../../src/jobs/index.js';
import {
  abandonCheckIn,
  canonicalInputFor,
  CheckInStateError,
  clearSignalEngines,
  completeCheckIn,
  computationKey,
  computeSignal,
  createQuestionnaireVersion,
  currentPublishedVersion,
  effectiveSignal,
  findCheckIn,
  IncompleteInputError,
  listQuestions,
  listSignals,
  listUnsettledCheckIns,
  overrideSignal,
  publishQuestionnaireVersion,
  QuestionnaireError,
  registeredSignalVersions,
  registerSignalEngine,
  saveResponse,
  settlePrimarySignal,
  SignalScoringUnavailableError,
  startCheckIn,
  UnreleasedEngineError,
  type CanonicalSignalInput,
  type SignalEngine,
} from '../../src/signals/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterEach(() => {
  clearSignalEngines();
});
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

/**
 * A published questionnaire with one required and one optional question.
 * No real instrument: CHECKINS.md §3 marks exact questions NOT_COMPUTABLE.
 */
async function publishedQuestionnaire(tenantId: string, adminId: string, suffix = 'a') {
  const version = `qv-test-${suffix}-${randomUUID().slice(0, 8)}`;
  await createQuestionnaireVersion(pool, {
    questionnaireVersion: version,
    tenantId,
    title: 'Synthetic test questionnaire',
    questions: [
      {
        questionKey: 'sleep_quality',
        prompt: 'Synthetic prompt',
        dimension: 'sleep',
        required: true,
        options: [
          { optionKey: 'good', label: 'Good' },
          { optionKey: 'poor', label: 'Poor' },
        ],
      },
      {
        questionKey: 'notes',
        prompt: 'Synthetic optional prompt',
        required: false,
      },
    ],
  });
  await publishQuestionnaireVersion(pool, {
    questionnaireVersion: version,
    tenantId,
    publishedBy: adminId,
  });
  return version;
}

/**
 * A clearly labelled unreleased fixture engine.
 * SUPPORT_SIGNALS.md §2 permits exactly this: a pure function contract and
 * unreleased fixtures. It encodes no released weight or threshold.
 */
function fixtureEngine(signalVersion = 'sv-unreleased-fixture-1'): SignalEngine {
  return {
    signalVersion,
    released: false,
    handlesIncompleteInput: false,
    compute(input: CanonicalSignalInput) {
      const poor = input.answers.some((answer) => answer.optionKey === 'poor');
      return {
        level: poor ? 'YELLOW' : 'GREEN',
        basis: {
          fixture: true,
          note: 'UNRELEASED_FIXTURE — not production authority',
          answered: input.answers.filter((answer) => answer.optionKey !== undefined).length,
        },
      };
    },
  };
}

describe('SUPPORT_SIGNALS.md §2 — no scoring is shipped', () => {
  it('registers no engine by default', () => {
    expect(registeredSignalVersions()).toEqual([]);
  });

  it('refuses to compute when no engine is registered', () => {
    expect(() =>
      computeSignal('sv-1', {
        checkInId: 'c1',
        sourceReference: undefined,
        questionnaireVersion: 'qv-1',
        answers: [],
        incomplete: false,
      }),
    ).toThrow(SignalScoringUnavailableError);
  });

  it('names D-011 in the refusal, so the gap is legible', () => {
    try {
      computeSignal('sv-1', {
        checkInId: 'c1',
        sourceReference: undefined,
        questionnaireVersion: 'qv-1',
        answers: [],
        incomplete: false,
      });
    } catch (error) {
      expect((error as Error).message).toContain('D-011');
    }
  });

  it('refuses an unreleased fixture engine unless it is explicitly allowed', () => {
    registerSignalEngine(fixtureEngine());
    const input: CanonicalSignalInput = {
      checkInId: 'c1',
      sourceReference: undefined,
      questionnaireVersion: 'qv-1',
      answers: [],
      incomplete: false,
    };

    expect(() => computeSignal('sv-unreleased-fixture-1', input)).toThrow(UnreleasedEngineError);
    expect(
      computeSignal('sv-unreleased-fixture-1', input, { allowUnreleasedFixture: true }).level,
    ).toBe('GREEN');
  });

  it('refuses incomplete input when the engine defines no missing-input behavior', () => {
    registerSignalEngine(fixtureEngine());
    expect(() =>
      computeSignal(
        'sv-unreleased-fixture-1',
        {
          checkInId: 'c1',
          sourceReference: undefined,
          questionnaireVersion: 'qv-1',
          answers: [],
          incomplete: true,
        },
        { allowUnreleasedFixture: true },
      ),
    ).toThrow(IncompleteInputError);
  });

  it('is deterministic for the same canonical inputs', () => {
    registerSignalEngine(fixtureEngine());
    const input: CanonicalSignalInput = {
      checkInId: 'c1',
      sourceReference: undefined,
      questionnaireVersion: 'qv-1',
      answers: [{ questionKey: 'sleep_quality', dimension: 'sleep', optionKey: 'poor' }],
      incomplete: false,
    };

    const first = computeSignal('sv-unreleased-fixture-1', input, {
      allowUnreleasedFixture: true,
    });
    const second = computeSignal('sv-unreleased-fixture-1', input, {
      allowUnreleasedFixture: true,
    });
    expect(second).toEqual(first);
  });
});

describe('CHECKINS.md §5 — questionnaire publication', () => {
  it('publishes atomically and resolves a new Check-In to the published version', async () => {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const version = await publishedQuestionnaire(tenantId, admin.userId);

    expect((await currentPublishedVersion(pool, tenantId))?.questionnaireVersion).toBe(version);
    expect(await listQuestions(pool, version)).toHaveLength(2);
  });

  it('refuses to publish an already-published version', async () => {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const version = await publishedQuestionnaire(tenantId, admin.userId);

    await expect(
      publishQuestionnaireVersion(pool, {
        questionnaireVersion: version,
        tenantId,
        publishedBy: admin.userId,
      }),
    ).rejects.toThrow(QuestionnaireError);
  });

  it('supersedes the prior version so exactly one is published', async () => {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const first = await publishedQuestionnaire(tenantId, admin.userId, 'first');
    const second = await publishedQuestionnaire(tenantId, admin.userId, 'second');

    expect((await currentPublishedVersion(pool, tenantId))?.questionnaireVersion).toBe(second);

    const statuses = await pool.query<{ questionnaire_version: string; status: string }>(
      'SELECT questionnaire_version, status FROM questionnaire_versions WHERE tenant_id = $1',
      [tenantId],
    );
    const firstStatus = statuses.rows.find((row) => row.questionnaire_version === first);
    expect(firstStatus?.status).toBe('SUPERSEDED');
  });

  it('keeps an in-flight Check-In on its original version after a publish', async () => {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const veteran = await user(tenantId, 'veteran');
    const first = await publishedQuestionnaire(tenantId, admin.userId, 'first');

    const checkIn = await startCheckIn(pool, { tenantId, veteranUserId: veteran.userId });
    expect(checkIn.questionnaireVersion).toBe(first);

    await publishedQuestionnaire(tenantId, admin.userId, 'second');

    // CHECKINS.md §4.5: in-flight Check-Ins continue on their original version.
    expect((await findCheckIn(pool, tenantId, checkIn.checkInId))?.questionnaireVersion).toBe(
      first,
    );
  });

  it('refuses to start a Check-In with no published version', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await user(tenantId, 'veteran');
    await expect(startCheckIn(pool, { tenantId, veteranUserId: veteran.userId })).rejects.toThrow(
      QuestionnaireError,
    );
  });
});

describe('CHECKINS.md §4, §6, §7 — Check-In lifecycle', () => {
  async function started() {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const veteran = await user(tenantId, 'veteran');
    const version = await publishedQuestionnaire(tenantId, admin.userId);
    const checkIn = await startCheckIn(pool, { tenantId, veteranUserId: veteran.userId });
    const questions = await listQuestions(pool, version);
    return { tenantId, veteran, version, checkIn, questions };
  }

  it('moves to IN_PROGRESS on the first saved response', async () => {
    const { tenantId, checkIn, questions } = await started();
    const required = questions.find((question) => question.required);
    if (required === undefined) throw new Error('fixture has no required question');

    await saveResponse(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      questionId: required.questionId,
    });
    expect((await findCheckIn(pool, tenantId, checkIn.checkInId))?.status).toBe('IN_PROGRESS');
  });

  it('completes and emits exactly one CHECKIN_COMPLETED', async () => {
    const { tenantId, veteran, checkIn, questions } = await started();
    const required = questions.find((question) => question.required);
    if (required === undefined) throw new Error('fixture has no required question');
    await saveResponse(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      questionId: required.questionId,
    });

    const first = await completeCheckIn(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      actorId: veteran.userId,
    });
    const replay = await completeCheckIn(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      actorId: veteran.userId,
    });

    expect(first.alreadyCompleted).toBe(false);
    expect(replay.alreadyCompleted).toBe(true);

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'CheckIn',
      aggregateId: checkIn.checkInId,
    });
    expect(events.filter((event) => event.eventType === 'CHECKIN_COMPLETED')).toHaveLength(1);
  });

  it('marks a submission missing required answers INCOMPLETE and emits nothing', async () => {
    const { tenantId, veteran, checkIn } = await started();

    const result = await completeCheckIn(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      actorId: veteran.userId,
    });

    expect(result.incomplete).toBe(true);
    expect(result.checkIn.status).toBe('INCOMPLETE');

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'CheckIn',
      aggregateId: checkIn.checkInId,
    });
    expect(events.map((event) => event.eventType)).not.toContain('CHECKIN_COMPLETED');
  });

  it('does not emit CHECKIN_COMPLETED for an abandoned Check-In', async () => {
    const { tenantId, checkIn } = await started();
    const abandoned = await abandonCheckIn(pool, { tenantId, checkInId: checkIn.checkInId });
    expect(abandoned.status).toBe('ABANDONED');

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'CheckIn',
      aggregateId: checkIn.checkInId,
    });
    expect(events).toEqual([]);
  });

  it('refuses to edit a completed Check-In, at the database level', async () => {
    const { tenantId, veteran, checkIn, questions } = await started();
    const required = questions.find((question) => question.required);
    const optional = questions.find((question) => !question.required);
    if (required === undefined || optional === undefined) throw new Error('bad fixture');

    await saveResponse(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      questionId: required.questionId,
    });
    await completeCheckIn(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      actorId: veteran.userId,
    });

    await expect(
      saveResponse(pool, {
        tenantId,
        checkInId: checkIn.checkInId,
        questionId: optional.questionId,
      }),
    ).rejects.toThrow(CheckInStateError);

    // Even a direct write is refused: CHECKINS.md §4.3 forbids silent rewriting.
    await expect(
      pool.query(`UPDATE check_in_responses SET free_text = 'tampered' WHERE check_in_id = $1`, [
        checkIn.checkInId,
      ]),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('requests durable signal computation on completion', async () => {
    const { tenantId, veteran, checkIn, questions } = await started();
    const required = questions.find((question) => question.required);
    if (required === undefined) throw new Error('bad fixture');
    await saveResponse(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      questionId: required.questionId,
    });

    const jobQueue = new InMemoryJobQueue();
    await completeCheckIn(
      pool,
      { tenantId, checkInId: checkIn.checkInId, actorId: veteran.userId },
      { jobQueue },
    );

    expect(jobQueue.enqueued()).toHaveLength(1);
    expect(jobQueue.enqueued()[0]?.jobType).toBe('support-signal.compute');
    // Completion requests computation; it does not mean a signal settled.
    expect(await listSignals(pool, tenantId, veteran.userId)).toEqual([]);
  });

  it('excludes free text from the canonical signal input', async () => {
    const { tenantId, checkIn, questions } = await started();
    const optional = questions.find((question) => !question.required);
    if (optional === undefined) throw new Error('bad fixture');

    await saveResponse(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      questionId: optional.questionId,
      freeText: 'sensitive free text that must never reach an engine',
    });

    const canonical = await canonicalInputFor(pool, tenantId, checkIn.checkInId);
    // SUPPORT_SIGNALS.md §10: no generative interpretation of free text as a
    // primary signal. The safest guarantee is never handing it over.
    expect(JSON.stringify(canonical)).not.toContain('sensitive free text');
  });
});

describe('SUPPORT_SIGNALS.md §3, §5 — computation identity and settlement', () => {
  async function veteranFixture() {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const veteran = await user(tenantId, 'veteran');
    const version = await publishedQuestionnaire(tenantId, admin.userId);
    const checkIn = await startCheckIn(pool, { tenantId, veteranUserId: veteran.userId });
    return { tenantId, admin, veteran, version, checkIn };
  }

  function settleInput(context: Awaited<ReturnType<typeof veteranFixture>>) {
    return {
      tenantId: context.tenantId,
      veteranUserId: context.veteran.userId,
      sourceType: 'CHECK_IN' as const,
      checkInId: context.checkIn.checkInId,
      level: 'YELLOW' as const,
      signalVersion: 'sv-unreleased-fixture-1',
      inputQuestionnaireVersion: context.version,
      basis: { fixture: true },
    };
  }

  it('settles one primary calculation and emits one change event', async () => {
    const context = await veteranFixture();
    const input = settleInput(context);

    const first = await settlePrimarySignal(pool, input);
    const replay = await settlePrimarySignal(pool, input);

    expect(first.deduplicated).toBe(false);
    expect(replay.deduplicated).toBe(true);
    expect(replay.signal.supportSignalId).toBe(first.signal.supportSignalId);

    const events = await listAggregateEvents(pool, {
      tenantId: context.tenantId,
      aggregateType: 'SupportSignal',
      aggregateId: first.signal.supportSignalId,
    });
    expect(events.filter((event) => event.eventType === 'SUPPORT_SIGNAL_CHANGED')).toHaveLength(1);
  });

  it('settles one row under concurrent duplicate computation', async () => {
    const context = await veteranFixture();
    const input = settleInput(context);

    const results = await Promise.all([
      settlePrimarySignal(pool, input),
      settlePrimarySignal(pool, input),
      settlePrimarySignal(pool, input),
    ]);

    const settled = results.filter((result) => !result.deduplicated);
    expect(settled).toHaveLength(1);
    expect(await listSignals(pool, context.tenantId, context.veteran.userId)).toHaveLength(1);
  });

  it('treats a new signal version as a distinct computation', async () => {
    const context = await veteranFixture();
    const first = await settlePrimarySignal(pool, settleInput(context));
    const second = await settlePrimarySignal(pool, {
      ...settleInput(context),
      signalVersion: 'sv-unreleased-fixture-2',
      level: 'ORANGE',
    });

    expect(second.deduplicated).toBe(false);
    expect(second.signal.supportSignalId).not.toBe(first.signal.supportSignalId);
    expect(await listSignals(pool, context.tenantId, context.veteran.userId)).toHaveLength(2);
  });

  it('refuses a primary identity with no check-in and no source reference', () => {
    expect(() => computationKey({ sourceType: 'EXPLICIT_NEED', signalVersion: 'sv-1' })).toThrow(
      /stable source reference/,
    );
  });

  it('accepts an explicit need with a stable source reference', () => {
    const key = computationKey({
      sourceType: 'EXPLICIT_NEED',
      sourceReference: 'need-123',
      signalVersion: 'sv-1',
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps settled signals immutable', async () => {
    const context = await veteranFixture();
    const settled = await settlePrimarySignal(pool, settleInput(context));

    await expect(
      pool.query(`UPDATE support_signals SET level = 'RED' WHERE support_signal_id = $1`, [
        settled.signal.supportSignalId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM support_signals WHERE support_signal_id = $1', [
        settled.signal.supportSignalId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('surfaces a completed Check-In whose signal has not settled', async () => {
    const context = await veteranFixture();
    const questions = await listQuestions(pool, context.version);
    const required = questions.find((question) => question.required);
    if (required === undefined) throw new Error('bad fixture');
    await saveResponse(pool, {
      tenantId: context.tenantId,
      checkInId: context.checkIn.checkInId,
      questionId: required.questionId,
    });
    await completeCheckIn(pool, {
      tenantId: context.tenantId,
      checkInId: context.checkIn.checkInId,
      actorId: context.veteran.userId,
    });

    const unsettled = await listUnsettledCheckIns(pool, context.tenantId);
    expect(unsettled.map((item) => item.checkInId)).toContain(context.checkIn.checkInId);

    await settlePrimarySignal(pool, settleInput(context));
    expect(await listUnsettledCheckIns(pool, context.tenantId)).toEqual([]);
  });
});

describe('SUPPORT_SIGNALS.md §6, §7 — overrides and effective selection', () => {
  async function settled() {
    const tenantId = syntheticTenantId();
    const admin = await user(tenantId, 'admin');
    const veteran = await user(tenantId, 'veteran');
    const responder = await user(tenantId, 'responder');
    const version = await publishedQuestionnaire(tenantId, admin.userId);
    const checkIn = await startCheckIn(pool, { tenantId, veteranUserId: veteran.userId });

    const primary = await settlePrimarySignal(pool, {
      tenantId,
      veteranUserId: veteran.userId,
      sourceType: 'CHECK_IN',
      checkInId: checkIn.checkInId,
      level: 'YELLOW',
      signalVersion: 'sv-unreleased-fixture-1',
      inputQuestionnaireVersion: version,
      basis: { fixture: true },
    });
    return { tenantId, veteran, responder, primary: primary.signal };
  }

  it('writes an override as a new linked immutable row', async () => {
    const { tenantId, veteran, responder, primary } = await settled();

    const override = await overrideSignal(pool, {
      tenantId,
      overrideOfSignalId: primary.supportSignalId,
      level: 'ORANGE',
      actorId: responder.userId,
      reason: 'spoke with the veteran; coordination priority is higher than computed',
    });

    expect(override.computationKind).toBe('OVERRIDE');
    expect(override.overrideOfSignalId).toBe(primary.supportSignalId);

    // §6: the original computed signal remains immutable and present.
    const history = await listSignals(pool, tenantId, veteran.userId);
    expect(history).toHaveLength(2);
    expect(history.map((item) => item.level)).toContain('YELLOW');
  });

  it('requires a reason to override', async () => {
    const { tenantId, responder, primary } = await settled();
    await expect(
      overrideSignal(pool, {
        tenantId,
        overrideOfSignalId: primary.supportSignalId,
        level: 'ORANGE',
        actorId: responder.userId,
        reason: '   ',
      }),
    ).rejects.toThrow(/requires a reason/);
  });

  it('selects the override as the effective signal, deterministically', async () => {
    const { tenantId, veteran, responder, primary } = await settled();

    expect((await effectiveSignal(pool, tenantId, veteran.userId))?.supportSignalId).toBe(
      primary.supportSignalId,
    );

    const override = await overrideSignal(pool, {
      tenantId,
      overrideOfSignalId: primary.supportSignalId,
      level: 'ORANGE',
      actorId: responder.userId,
      reason: 'documented disagreement',
    });

    const effective = await effectiveSignal(pool, tenantId, veteran.userId);
    expect(effective?.supportSignalId).toBe(override.supportSignalId);
    expect(effective?.level).toBe('ORANGE');

    // Repeated evaluation is stable, not insertion-order dependent.
    expect((await effectiveSignal(pool, tenantId, veteran.userId))?.supportSignalId).toBe(
      override.supportSignalId,
    );
  });

  it('does not let an override erase the computed signal from history', async () => {
    const { tenantId, veteran, responder, primary } = await settled();
    await overrideSignal(pool, {
      tenantId,
      overrideOfSignalId: primary.supportSignalId,
      level: 'GREEN',
      actorId: responder.userId,
      reason: 'lowering after direct contact',
    });

    const history = await listSignals(pool, tenantId, veteran.userId);
    const original = history.find((item) => item.supportSignalId === primary.supportSignalId);
    expect(original?.level).toBe('YELLOW');
  });
});
