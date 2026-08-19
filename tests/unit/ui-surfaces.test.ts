/**
 * Rendered-surface evidence.
 *
 * SUAS-specs MVP_REFERENCE.md §2 (no required element may silently disappear),
 * §4 (product principles), §7 (mandatory divergences), §8 (resource fidelity),
 * §9 (no fabricated metrics), §10 (WCAG 2.2 AA), §11 (deterministic fixtures).
 */

import { describe, expect, it } from 'vitest';
import {
  assertRequiredElementsPresent,
  auditAccessibility,
  CATEGORY_CARDS,
  MissingRequiredElementError,
  renderChat,
  renderResourceList,
  renderResponderDashboard,
  renderVeteranHome,
  VISUAL_FIXTURES,
} from '../../src/ui/index.js';

const shell = {
  title: 'Support',
  viewport: 'MOBILE',
  showMobileNav: true,
} as const;

describe('MVP_REFERENCE.md §11 — fixtures are deterministic', () => {
  it.each(VISUAL_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    '%s renders identically on repeated calls',
    (_id, fixture) => {
      expect(fixture.render()).toBe(fixture.render());
    },
  );

  it('renders every fixture without a clock, database, or network', () => {
    // Determinism above would not catch a fixture that throws on the first call.
    for (const fixture of VISUAL_FIXTURES) {
      expect(fixture.render().length, fixture.id).toBeGreaterThan(0);
    }
  });
});

describe('MVP_REFERENCE.md §10 — accessibility floor', () => {
  it.each(VISUAL_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    '%s has no decidable WCAG 2.2 AA failure',
    (_id, fixture) => {
      const findings = auditAccessibility(fixture.render(), fixture.markupKind);
      expect(
        findings,
        findings.map((finding) => `${finding.criterion}: ${finding.message}`).join('\n'),
      ).toEqual([]);
    },
  );

  it('detects a missing label rather than passing everything', () => {
    // Evidence that the audit can fail: a control with no accessible name.
    const findings = auditAccessibility('<a href="/x"></a>', 'FRAGMENT');
    expect(findings.map((finding) => finding.criterion)).toContain('4.1.2 Name, Role, Value');
  });

  it('detects a viewport that blocks zoom', () => {
    const markup =
      '<html lang="en"><head><meta name="viewport" content="width=device-width,user-scalable=no">' +
      '</head><body><main><h1>x</h1></main><a class="skip-link" href="#main">Skip</a></body></html>';
    const findings = auditAccessibility(markup, 'DOCUMENT');
    expect(findings.map((finding) => finding.criterion)).toContain('1.4.4 Resize Text');
  });
});

describe('MVP_REFERENCE.md §2 — required elements cannot silently disappear', () => {
  it('fails when a reference-critical action is missing', () => {
    expect(() => assertRequiredElementsPresent('LANDING', '<h1>Shut Up and Serve</h1>')).toThrow(
      MissingRequiredElementError,
    );
  });

  it('names which elements went missing', () => {
    try {
      assertRequiredElementsPresent('LANDING', '<h1>TAKE ACTION</h1>');
      expect.unreachable('expected a missing-element failure');
    } catch (error) {
      expect((error as MissingRequiredElementError).missing).toEqual([
        'I NEED SUPPORT',
        'I WANT TO SERVE',
      ]);
    }
  });
});

describe('MVP_REFERENCE.md §6 — non-operational cards stay visible and inert', () => {
  const markup = renderVeteranHome({ shell, categories: CATEGORY_CARDS });

  it('keeps every reference category label on the veteran home', () => {
    for (const card of CATEGORY_CARDS) {
      expect(markup, card.label).toContain(card.label);
    }
  });

  it('labels unreleased categories in text, not by styling alone', () => {
    expect(markup).toContain('Coming soon');
    expect(markup).toContain('Info only');
  });

  it('states that a non-operational card creates no request', () => {
    expect(markup).toContain('does not create a request');
  });
});

describe('MVP_REFERENCE.md §7.2 — the veteran home is truthful about QRF', () => {
  const markup = renderVeteranHome({ shell, categories: CATEGORY_CARDS });

  it('offers the deploy action as the dominant veteran action', () => {
    expect(markup).toContain('Deploy QRF');
  });

  it('does not imply emergency dispatch', () => {
    expect(markup).toContain('does not contact emergency services');
  });

  it('makes no proximity claim', () => {
    for (const phrase of ['near you', 'nearby', 'closest']) {
      expect(markup.toLowerCase(), phrase).not.toContain(phrase);
    }
  });

  it('places immediate resources above the broader catalog', () => {
    expect(markup.indexOf('Immediate Resources')).toBeLessThan(markup.indexOf('Find help'));
  });
});

describe('MVP_REFERENCE.md §8 — resource screens', () => {
  it('says so when no contact method is recorded', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [{ id: 'r1', name: 'Example Pantry', freshness: 'UNVERIFIED', staleWarning: true }],
    });
    expect(markup).toContain('No contact method recorded.');
  });

  it('never guesses a tel: or mailto: scheme from the unstructured field', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [
        {
          id: 'r1',
          name: 'Example Pantry',
          contactMethod: 'Phone +1-555-555-0101',
          freshness: 'FRESH',
          staleWarning: false,
        },
      ],
    });
    expect(markup).not.toContain('tel:');
    expect(markup).not.toContain('mailto:');
  });

  it('shows a truthful empty state rather than an empty page', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Transportation',
      backHref: '/app/resources',
      rows: [],
    });
    expect(markup).toContain('No verified resources are configured');
  });

  it('keeps back navigation', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [],
    });
    expect(markup).toContain('Back');
  });
});

describe('MVP_REFERENCE.md §9 — no fabricated responder metrics', () => {
  const markup = renderResponderDashboard({
    shell,
    onDuty: false,
    activeNeeds: [],
    alerts: [],
    quickShareCategories: [],
    metrics: [
      { label: 'Responses', state: 'NOT_COMPUTABLE', reason: 'No released definition' },
      { label: 'Avg Response', state: 'NOT_COMPUTABLE', reason: 'No released definition' },
    ],
  });

  it('states why a metric is unavailable instead of showing a zero', () => {
    expect(markup).toContain('No released definition');
    expect(markup).not.toMatch(/<dd[^>]*>\s*0\s*<\/dd>/);
  });

  it('keeps the §9 emphasis blocks present', () => {
    for (const block of ['On Duty', 'Active Needs', 'Alerts', 'Quick Resource Share']) {
      expect(markup, block).toContain(block);
    }
  });
});

describe('Chat is honest about being unimplemented', () => {
  it('states unavailability rather than rendering an empty inbox', () => {
    const markup = renderChat({
      shell,
      threads: [],
      unavailableReason: 'Messaging is not available yet.',
    });
    expect(markup).toContain('Messaging is not available yet.');
  });
});

describe('Veteran-authored text is data, not markup', () => {
  it('escapes a thread preview containing markup', () => {
    const markup = renderChat({
      shell,
      threads: [
        {
          threadId: 't1',
          counterpartLabel: 'Responder',
          lastMessagePreview: '<script>alert(1)</script>',
        },
      ],
    });
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});
