/**
 * Reference conformance contract evidence.
 *
 * SUAS-specs MVP_REFERENCE.md §2 (no required element may silently disappear),
 * §5 (required surface inventory), §6 (category/display mapping), §7.2 (QRF
 * truthfulness), §7.3 + SAFETY.md §2/§9 (D-012 reserved copy slot), §11
 * (fixture contract).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertApprovedSafetyCopyAvailable,
  CATEGORY_CARDS,
  categoryForCard,
  contactAffordances,
  D_012_APPROVED_SAFETY_COPY,
  NonOperationalCategoryError,
  presentQrfState,
  REQUIRED_FIXTURE_COVERAGE,
  REQUIRED_SURFACES,
  requireSurface,
  resolveImmediateResourceSlot,
  UnapprovedSafetyCopyError,
  UnknownSurfaceError,
  VISUAL_FIXTURES,
  type QrfFacts,
} from '../../src/ui/index.js';

function facts(overrides: Partial<QrfFacts> = {}): QrfFacts {
  return {
    requestStatus: 'SUBMITTED',
    responderAssigned: false,
    responderNotificationDelivered: false,
    coordinationDegraded: false,
    matchingExhausted: false,
    ...overrides,
  };
}

describe('MVP_REFERENCE.md §5 — required surface inventory', () => {
  it('declares every surface the released table lists', () => {
    expect(REQUIRED_SURFACES).toHaveLength(13);
  });

  it('refuses a surface that is not in the released inventory', () => {
    expect(() => requireSurface('GOD_MODE')).toThrow(UnknownSurfaceError);
  });

  it('covers every §11 fixture requirement with at least one fixture', () => {
    const covered = new Set(VISUAL_FIXTURES.map((fixture) => fixture.surfaceId));
    const missing = REQUIRED_FIXTURE_COVERAGE.filter((surface) => !covered.has(surface));
    expect(missing, `uncovered surfaces: ${missing.join(', ')}`).toEqual([]);
  });

  it('records the six fields §11 requires on every fixture', () => {
    for (const fixture of VISUAL_FIXTURES) {
      expect(fixture.viewport, fixture.id).toBeDefined();
      expect(fixture.role, fixture.id).toBeDefined();
      expect(fixture.conformance, fixture.id).toBeDefined();
      expect(fixture.divergences, fixture.id).toBeDefined();
      expect(fixture.description, fixture.id).not.toBe('');
    }
  });
});

describe('MVP_REFERENCE.md §6 — category/display mapping', () => {
  it('keeps all six reference labels visible', () => {
    const labels = CATEGORY_CARDS.map((card) => card.label);
    expect(labels).toEqual([
      'Housing',
      'Food',
      'Transportation',
      'Counseling',
      'Activities',
      'Job Training',
    ]);
  });

  it('maps Housing to temporary SHELTER, not the FUTURE HOUSING workflow', () => {
    expect(categoryForCard('Housing')).toBe('SHELTER');
  });

  it('maps Food and Transportation to their released categories', () => {
    expect(categoryForCard('Food')).toBe('FOOD');
    expect(categoryForCard('Transportation')).toBe('TRANSPORTATION');
  });

  it.each(['Counseling', 'Activities', 'Job Training'])(
    'refuses to turn the %s card into a Service Request',
    (label) => {
      expect(() => categoryForCard(label)).toThrow(NonOperationalCategoryError);
    },
  );

  it('refuses an unknown card outright', () => {
    expect(() => categoryForCard('Benefits')).toThrow(NonOperationalCategoryError);
  });
});

describe('MVP_REFERENCE.md §7.2 — QRF truthfulness', () => {
  it('reports a recorded request as REQUESTED', () => {
    expect(presentQrfState(facts({ requestStatus: 'SUBMITTED' })).state).toBe('REQUESTED');
  });

  it('reports matching as SEARCHING', () => {
    expect(presentQrfState(facts({ requestStatus: 'MATCHING' })).state).toBe('SEARCHING');
  });

  it('does not claim a responder was notified from an assignment alone', () => {
    const presentation = presentQrfState(
      facts({ requestStatus: 'ASSIGNED', responderAssigned: true }),
    );
    expect(presentation.state).toBe('SEARCHING');
    expect(presentation.basis).toContain('no recorded notification delivery');
  });

  it('reports RESPONDER_NOTIFIED only with a recorded delivery', () => {
    const presentation = presentQrfState(
      facts({
        requestStatus: 'ASSIGNED',
        responderAssigned: true,
        responderNotificationDelivered: true,
      }),
    );
    expect(presentation.state).toBe('RESPONDER_NOTIFIED');
  });

  it('reports an exhausted match as no responder currently available', () => {
    expect(
      presentQrfState(facts({ requestStatus: 'MATCHING', matchingExhausted: true })).state,
    ).toBe('NO_RESPONDER_CURRENTLY_AVAILABLE');
  });

  it('surfaces a failed dependency as DEGRADED rather than a calm search', () => {
    expect(
      presentQrfState(facts({ requestStatus: 'MATCHING', coordinationDegraded: true })).state,
    ).toBe('DEGRADED');
  });

  it('leaves a cancelled request non-cancellable', () => {
    const presentation = presentQrfState(facts({ requestStatus: 'CANCELLED' }));
    expect(presentation.state).toBe('CANCELLED');
    expect(presentation.cancellable).toBe(false);
  });

  it('maps every released request status to a label without falling through', () => {
    const statuses = [
      'CREATED',
      'SUBMITTED',
      'TRIAGED',
      'MATCHING',
      'ASSIGNED',
      'ACCEPTED',
      'IN_PROGRESS',
      'FULFILLED',
      'CONFIRMED',
      'CLOSED',
      'CANCELLED',
      'DECLINED',
      'EXPIRED',
      'UNFULFILLABLE',
      'ESCALATED',
    ] as const;
    for (const status of statuses) {
      expect(presentQrfState(facts({ requestStatus: status })).state, status).toBeDefined();
    }
  });

  it('hides Call and Message until a counterpart exists', () => {
    expect(
      contactAffordances({
        state: 'SEARCHING',
        authorizedVoicePath: true,
        authorizedMessagePath: true,
      }),
    ).toEqual({ call: false, message: false });
  });

  it('hides Call and Message when no authorized path exists', () => {
    expect(
      contactAffordances({
        state: 'RESPONDER_ACCEPTED',
        authorizedVoicePath: false,
        authorizedMessagePath: false,
      }),
    ).toEqual({ call: false, message: false });
  });

  it('shows only the authorized path', () => {
    expect(
      contactAffordances({
        state: 'RESPONDER_ACCEPTED',
        authorizedVoicePath: false,
        authorizedMessagePath: true,
      }),
    ).toEqual({ call: false, message: true });
  });
});

describe('SAFETY.md §2 and §9 — the reserved crisis copy slot', () => {
  it('records D-012 as still pending', () => {
    expect(D_012_APPROVED_SAFETY_COPY).toBe('DECISION_PENDING');
  });

  it('renders a placeholder rather than approved copy', () => {
    const slot = resolveImmediateResourceSlot();
    expect(slot.state).toBe('PLACEHOLDER');
    expect(slot.resources).toEqual([]);
    expect(slot.placeholder).toBeDefined();
  });

  it('refuses to present safety copy as official while D-012 is open', () => {
    expect(() => assertApprovedSafetyCopyAvailable('A red check-in outcome')).toThrow(
      UnapprovedSafetyCopyError,
    );
  });

  it('ships no crisis destination or hotline in the safety module', () => {
    // A well-known number shipped without D-012 is exactly the unapproved
    // official-looking copy SAFETY.md §2 forbids.
    const source = readFileSync(new URL('../../src/ui/safety.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b988\b/);
    expect(source).not.toMatch(/\b1-?800-?\d{3}-?\d{4}\b/);
    expect(source).not.toMatch(/https?:\/\//);
  });

  it('states unavailability without giving crisis guidance', () => {
    const placeholder = resolveImmediateResourceSlot().placeholder ?? '';
    for (const forbidden of ['call', 'text', 'emergency', 'suicide', 'crisis line']) {
      expect(placeholder.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});
