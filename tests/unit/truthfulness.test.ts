/**
 * SAFETY_COPY.md §4 / §5 state-truthfulness evidence.
 *
 * The five conditions are presentation labels over recorded Service Request /
 * Fulfillment / Attempt facts. This file proves a later condition is never
 * returned without its own evidence, that ARRIVED stays fail-closed without an
 * explicit arrived fact, and that an emergency referral alone is not RESOLVED.
 */

import { describe, expect, it } from 'vitest';
import {
  conditionProven,
  containsForbiddenCrisisPhrase,
  FORBIDDEN_CRISIS_PHRASES,
  presentQrfState,
  presentTruthfulnessCondition,
  QRF_UI_STATES,
  TRUTHFULNESS_CONDITIONS,
  type QrfFacts,
  type TruthfulnessFacts,
} from '../../src/ui/index.js';

function facts(overrides: TruthfulnessFacts = {}): TruthfulnessFacts {
  return overrides;
}

function qrf(overrides: Partial<QrfFacts> = {}): QrfFacts {
  return {
    requestStatus: 'SUBMITTED',
    responderAssigned: false,
    responderNotificationDelivered: false,
    coordinationDegraded: false,
    matchingExhausted: false,
    ...overrides,
  };
}

describe('SAFETY_COPY.md §5 — REQUESTED ≠ ACCEPTED ≠ DISPATCHED ≠ ARRIVED ≠ RESOLVED', () => {
  it('declares the five released conditions in order', () => {
    expect(TRUTHFULNESS_CONDITIONS).toEqual([
      'REQUESTED',
      'ACCEPTED',
      'DISPATCHED',
      'ARRIVED',
      'RESOLVED',
    ]);
  });

  it('returns nothing when no request has been recorded', () => {
    expect(presentTruthfulnessCondition(facts())).toBeUndefined();
  });

  it('reports a recorded request as REQUESTED and implies no provider action', () => {
    const presented = presentTruthfulnessCondition(facts({ requestStatus: 'SUBMITTED' }));
    expect(presented?.condition).toBe('REQUESTED');
    expect(presented?.headline).toContain('does not mean that assistance has been confirmed');
    expect(conditionProven(facts({ requestStatus: 'SUBMITTED' }), 'ACCEPTED')).toBe(false);
    expect(conditionProven(facts({ requestStatus: 'SUBMITTED' }), 'DISPATCHED')).toBe(false);
  });

  it('does not treat assignment or matching as ACCEPTED', () => {
    for (const requestStatus of ['TRIAGED', 'MATCHING', 'ASSIGNED'] as const) {
      expect(presentTruthfulnessCondition(facts({ requestStatus }))?.condition, requestStatus).toBe(
        'REQUESTED',
      );
    }
  });

  it('reports ACCEPTED only from recorded provider-acceptance evidence', () => {
    expect(presentTruthfulnessCondition(facts({ requestStatus: 'ACCEPTED' }))?.condition).toBe(
      'ACCEPTED',
    );
    expect(
      presentTruthfulnessCondition(facts({ attemptStatus: 'PROVIDER_ACCEPTED' }))?.condition,
    ).toBe('ACCEPTED');
    expect(presentTruthfulnessCondition(facts({ fulfillmentState: 'ACCEPTED' }))?.condition).toBe(
      'ACCEPTED',
    );
    expect(conditionProven(facts({ requestStatus: 'ACCEPTED' }), 'DISPATCHED')).toBe(false);
  });

  it('reports DISPATCHED only from en-route / actioned provider evidence', () => {
    expect(
      presentTruthfulnessCondition(facts({ attemptStatus: 'PROVIDER_IN_PROGRESS' }))?.condition,
    ).toBe('DISPATCHED');
    expect(presentTruthfulnessCondition(facts({ fulfillmentState: 'STARTED' }))?.condition).toBe(
      'DISPATCHED',
    );
    expect(conditionProven(facts({ attemptStatus: 'PROVIDER_IN_PROGRESS' }), 'ARRIVED')).toBe(
      false,
    );
  });

  it('never reports ARRIVED without an explicit arrived fact', () => {
    const candidates: TruthfulnessFacts[] = [
      { requestStatus: 'IN_PROGRESS' },
      { attemptStatus: 'PROVIDER_IN_PROGRESS' },
      { fulfillmentState: 'STARTED' },
      { attemptStatus: 'PROVIDER_COMPLETED' },
      { fulfillmentState: 'COMPLETED' },
    ];
    for (const candidate of candidates) {
      expect(conditionProven(candidate, 'ARRIVED'), JSON.stringify(candidate)).toBe(false);
    }
    expect(
      presentTruthfulnessCondition(facts({ providerArrived: true, requestStatus: 'IN_PROGRESS' }))
        ?.condition,
    ).toBe('ARRIVED');
  });

  it('reports RESOLVED from recorded completion, not from an emergency referral', () => {
    expect(presentTruthfulnessCondition(facts({ requestStatus: 'FULFILLED' }))?.condition).toBe(
      'RESOLVED',
    );
    expect(
      presentTruthfulnessCondition(facts({ attemptStatus: 'PROVIDER_COMPLETED' }))?.condition,
    ).toBe('RESOLVED');
    expect(presentTruthfulnessCondition(facts({ fulfillmentState: 'CONFIRMED' }))?.condition).toBe(
      'RESOLVED',
    );
    expect(presentTruthfulnessCondition(facts({ requestStatus: 'ESCALATED' }))?.condition).toBe(
      'REQUESTED',
    );
    expect(
      presentTruthfulnessCondition(
        facts({ requestStatus: 'FULFILLED', emergencyReferralOnly: true }),
      )?.condition,
    ).toBe('REQUESTED');
  });

  it('never collapses a later condition onto an earlier fact', () => {
    const requested = facts({ requestStatus: 'SUBMITTED' });
    expect(conditionProven(requested, 'ACCEPTED')).toBe(false);
    expect(conditionProven(requested, 'DISPATCHED')).toBe(false);
    expect(conditionProven(requested, 'ARRIVED')).toBe(false);
    expect(conditionProven(requested, 'RESOLVED')).toBe(false);

    const accepted = facts({ requestStatus: 'ACCEPTED' });
    expect(conditionProven(accepted, 'DISPATCHED')).toBe(false);
    expect(conditionProven(accepted, 'ARRIVED')).toBe(false);
    expect(conditionProven(accepted, 'RESOLVED')).toBe(false);
  });
});

describe('SAFETY_COPY.md §4 — forbidden crisis language', () => {
  it('flags every released forbidden phrase', () => {
    for (const phrase of FORBIDDEN_CRISIS_PHRASES) {
      expect(containsForbiddenCrisisPhrase(phrase), phrase).toBe(phrase);
    }
  });

  it('does not flag the approved request-received wording', () => {
    expect(
      containsForbiddenCrisisPhrase(
        'Your request has been received. This does not mean that assistance has been confirmed.',
      ),
    ).toBeUndefined();
  });

  it('keeps every QRF headline free of forbidden phrases', () => {
    const statuses = [
      'CREATED',
      'SUBMITTED',
      'MATCHING',
      'ASSIGNED',
      'ACCEPTED',
      'IN_PROGRESS',
      'FULFILLED',
      'CANCELLED',
      'UNFULFILLABLE',
    ] as const;
    for (const requestStatus of statuses) {
      const headline = presentQrfState(qrf({ requestStatus })).headline;
      expect(
        containsForbiddenCrisisPhrase(headline),
        `${requestStatus}: ${headline}`,
      ).toBeUndefined();
    }
    expect(QRF_UI_STATES).not.toContain('DISPATCHED');
    expect(QRF_UI_STATES).not.toContain('ARRIVED');
  });
});
