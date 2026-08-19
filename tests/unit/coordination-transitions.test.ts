/**
 * State-machine evidence, no database required.
 *
 * SUAS-specs CASES.md §2, §4, §4.1, §4.2, §10, §11;
 * DISPATCH.md §2, §4, §7, §11, §12; RESPONDER_WORKFLOWS.md §8.
 */

import { describe, expect, it } from 'vitest';
import {
  assertServiceCategory,
  CASE_STATUSES,
  CASE_TRANSITIONS,
  findCaseTransition,
  findRequestTransition,
  IllegalCaseTransitionError,
  IllegalRequestTransitionError,
  ReasonRequiredError,
  RESERVED_FUTURE_CATEGORIES,
  resolveCaseTransition,
  resolveRequestTransition,
  SERVICE_CATEGORIES,
  SERVICE_REQUEST_STATUSES,
  SERVICE_REQUEST_TRANSITIONS,
  UnknownServiceCategoryError,
  type CaseStatus,
} from '../../src/coordination/index.js';

describe('CASES.md §2, §10 — exactly the released states', () => {
  it('defines the seven released case states and no others', () => {
    expect(CASE_STATUSES).toEqual([
      'OPEN',
      'TRIAGED',
      'ASSIGNED',
      'ACTIVE',
      'FOLLOWUP',
      'RESOLVED',
      'CLOSED',
    ]);
  });

  it('references no state outside that set in any transition', () => {
    for (const transition of CASE_TRANSITIONS) {
      expect(CASE_STATUSES).toContain(transition.from);
      expect(CASE_STATUSES).toContain(transition.to);
    }
  });
});

describe('CASES.md §4 — only documented edges succeed', () => {
  it('allows the documented happy path', () => {
    expect(resolveCaseTransition('TRIAGE', 'OPEN').to).toBe('TRIAGED');
    expect(resolveCaseTransition('CLAIM_CASE', 'TRIAGED').to).toBe('ASSIGNED');
    expect(resolveCaseTransition('ACTIVATE', 'ASSIGNED').to).toBe('ACTIVE');
    expect(
      resolveCaseTransition('MOVE_TO_FOLLOWUP', 'ACTIVE', { reason: 'awaiting ride' }).to,
    ).toBe('FOLLOWUP');
    expect(resolveCaseTransition('RESOLVE', 'ACTIVE').to).toBe('RESOLVED');
    expect(resolveCaseTransition('CLOSE', 'RESOLVED').to).toBe('CLOSED');
  });

  it.each([
    ['ACTIVATE', 'OPEN'],
    ['RESOLVE', 'OPEN'],
    ['CLOSE', 'ACTIVE'],
    ['TRIAGE', 'ASSIGNED'],
    ['CLAIM_CASE', 'ASSIGNED'],
    ['CLOSE', 'CLOSED'],
  ] as const)('refuses %s from %s', (command, from) => {
    expect(() => resolveCaseTransition(command, from)).toThrow(IllegalCaseTransitionError);
  });

  it('has no OPEN → ACTIVE edge at all', () => {
    // CASES.md §10 lists "impossible unassigned OPEN → ACTIVE escalation" as a
    // non-goal, so no command may produce it.
    const edges = CASE_TRANSITIONS.filter(
      (transition) => transition.from === 'OPEN' && transition.to === 'ACTIVE',
    );
    expect(edges).toEqual([]);
  });
});

describe('CASES.md §4.1 — escalation is not a universal state jump', () => {
  it.each(['OPEN', 'TRIAGED'] as CaseStatus[])('refuses ESCALATE from unassigned %s', (from) => {
    expect(() => resolveCaseTransition('ESCALATE', from, { reason: 'urgent' })).toThrow(
      IllegalCaseTransitionError,
    );
  });

  it.each(['ASSIGNED', 'ACTIVE', 'FOLLOWUP'] as CaseStatus[])(
    'allows ESCALATE from %s, and requires an active assignment',
    (from) => {
      const transition = resolveCaseTransition('ESCALATE', from, { reason: 'urgent' });
      expect(transition.to).toBe('ACTIVE');
      expect(transition.requiresActiveAssignment).toBe(true);
    },
  );

  it('requires a reason to escalate', () => {
    expect(() => resolveCaseTransition('ESCALATE', 'ACTIVE')).toThrow(ReasonRequiredError);
    expect(() => resolveCaseTransition('ESCALATE', 'ACTIVE', { reason: '  ' })).toThrow(
      ReasonRequiredError,
    );
  });
});

describe('CASES.md §4.2 — reopen', () => {
  it('allows CLOSED → OPEN with a reason', () => {
    expect(resolveCaseTransition('REOPEN', 'CLOSED', { reason: 'new need' }).to).toBe('OPEN');
  });

  it('requires a reason', () => {
    expect(() => resolveCaseTransition('REOPEN', 'CLOSED')).toThrow(ReasonRequiredError);
  });

  it('is the only edge out of CLOSED', () => {
    const outbound = CASE_TRANSITIONS.filter((transition) => transition.from === 'CLOSED');
    expect(outbound.map((transition) => transition.command)).toEqual(['REOPEN']);
  });
});

describe('CASES.md §4 — reassignment edges', () => {
  it.each(['ASSIGNED', 'ACTIVE', 'FOLLOWUP'] as CaseStatus[])(
    'allows ASSIGN_CASE from %s and lands on ASSIGNED',
    (from) => {
      expect(resolveCaseTransition('ASSIGN_CASE', from).to).toBe('ASSIGNED');
    },
  );

  it('does not allow reassignment of a resolved case', () => {
    expect(() => resolveCaseTransition('ASSIGN_CASE', 'RESOLVED')).toThrow(
      IllegalCaseTransitionError,
    );
  });
});

describe('DISPATCH.md §2, §4 — Service Request machine', () => {
  it('allows the documented happy path', () => {
    expect(resolveRequestTransition('SUBMIT', 'CREATED').to).toBe('SUBMITTED');
    expect(resolveRequestTransition('TRIAGE', 'SUBMITTED').to).toBe('TRIAGED');
    expect(resolveRequestTransition('START_MATCHING', 'TRIAGED').to).toBe('MATCHING');
    expect(resolveRequestTransition('ASSIGN', 'MATCHING').to).toBe('ASSIGNED');
    expect(resolveRequestTransition('ACCEPT', 'ASSIGNED').to).toBe('ACCEPTED');
    expect(resolveRequestTransition('START', 'ACCEPTED').to).toBe('IN_PROGRESS');
    expect(resolveRequestTransition('FULFILL', 'IN_PROGRESS').to).toBe('FULFILLED');
    expect(resolveRequestTransition('CONFIRM', 'FULFILLED').to).toBe('CONFIRMED');
    expect(resolveRequestTransition('CLOSE', 'CONFIRMED').to).toBe('CLOSED');
  });

  it('has no edge that jumps assignment straight to fulfilled', () => {
    // DISPATCH.md §12: "ASSIGNED is not FULFILLED"; §5 forbids a provider
    // webhook skipping the intermediate commands.
    const jumps = SERVICE_REQUEST_TRANSITIONS.filter(
      (transition) => transition.from === 'ASSIGNED' && transition.to === 'FULFILLED',
    );
    expect(jumps).toEqual([]);
  });

  it('does not let a provider completion auto-confirm', () => {
    expect(() => resolveRequestTransition('CONFIRM', 'IN_PROGRESS')).toThrow(
      IllegalRequestTransitionError,
    );
  });

  it('marks only the MATCHING → ASSIGNED edge as externally disclosing', () => {
    const disclosing = SERVICE_REQUEST_TRANSITIONS.filter(
      (transition) => transition.mayDiscloseExternally,
    );
    expect(disclosing).toHaveLength(1);
    expect(disclosing[0]).toMatchObject({ from: 'MATCHING', to: 'ASSIGNED' });
  });
});

describe('DISPATCH.md §4 — cancellation is an explicit set, not a wildcard', () => {
  it.each(['CREATED', 'SUBMITTED', 'TRIAGED', 'MATCHING', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'])(
    'allows cancelling from %s',
    (from) => {
      expect(
        resolveRequestTransition('CANCEL', from as never, { reason: 'veteran declined' }).to,
      ).toBe('CANCELLED');
    },
  );

  it.each(['CLOSED', 'CANCELLED', 'EXPIRED', 'UNFULFILLABLE', 'CONFIRMED'])(
    'refuses cancelling from %s',
    (from) => {
      expect(() =>
        resolveRequestTransition('CANCEL', from as never, { reason: 'too late' }),
      ).toThrow(IllegalRequestTransitionError);
    },
  );

  it('requires a reason to cancel', () => {
    expect(() => resolveRequestTransition('CANCEL', 'TRIAGED')).toThrow();
  });
});

describe('DISPATCH.md §4, §10 — expiry edges', () => {
  it.each(['CREATED', 'SUBMITTED', 'TRIAGED', 'MATCHING', 'ASSIGNED'])(
    'allows expiry from %s',
    (from) => {
      expect(resolveRequestTransition('EXPIRE', from as never).to).toBe('EXPIRED');
    },
  );

  it.each(['ACCEPTED', 'IN_PROGRESS', 'FULFILLED', 'CONFIRMED', 'CLOSED'])(
    'refuses expiry from %s, so a stale job cannot expire advanced work',
    (from) => {
      expect(() => resolveRequestTransition('EXPIRE', from as never)).toThrow(
        IllegalRequestTransitionError,
      );
    },
  );
});

describe('DISPATCH.md §4 — escalation return has two documented targets', () => {
  it('requires the caller to name which one', () => {
    expect(
      resolveRequestTransition('RETURN_FROM_ESCALATION', 'ESCALATED', { to: 'TRIAGED' }).to,
    ).toBe('TRIAGED');
    expect(
      resolveRequestTransition('RETURN_FROM_ESCALATION', 'ESCALATED', { to: 'MATCHING' }).to,
    ).toBe('MATCHING');
  });

  it('refuses an undocumented return target', () => {
    expect(() =>
      resolveRequestTransition('RETURN_FROM_ESCALATION', 'ESCALATED', { to: 'ASSIGNED' }),
    ).toThrow(IllegalRequestTransitionError);
  });
});

describe('DISPATCH.md §7 — categories', () => {
  it.each(SERVICE_CATEGORIES)('accepts MVP category %s', (category) => {
    expect(() => assertServiceCategory(category)).not.toThrow();
  });

  it.each(RESERVED_FUTURE_CATEGORIES)('rejects reserved future category %s', (category) => {
    expect(() => assertServiceCategory(category)).toThrow(UnknownServiceCategoryError);
  });

  it('says why a reserved category is refused', () => {
    try {
      assertServiceCategory('HOUSING');
    } catch (error) {
      expect((error as Error).message).toContain('reserved for a future release');
    }
  });

  it('rejects an unknown code', () => {
    expect(() => assertServiceCategory('PONY_RIDES')).toThrow(UnknownServiceCategoryError);
  });
});

describe('transition tables are internally consistent', () => {
  it('references only released request statuses', () => {
    for (const transition of SERVICE_REQUEST_TRANSITIONS) {
      expect(SERVICE_REQUEST_STATUSES).toContain(transition.from);
      expect(SERVICE_REQUEST_STATUSES).toContain(transition.to);
    }
  });

  it('exposes lookups that agree with the resolver', () => {
    expect(findCaseTransition('TRIAGE', 'OPEN')?.to).toBe('TRIAGED');
    expect(findCaseTransition('TRIAGE', 'CLOSED')).toBeUndefined();
    expect(findRequestTransition('SUBMIT', 'CREATED')?.to).toBe('SUBMITTED');
    expect(findRequestTransition('SUBMIT', 'CLOSED')).toBeUndefined();
  });
});
