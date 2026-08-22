/**
 * The visual-regression fixture catalog.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §11 (fixture contract: the twelve covered
 *   surfaces and the fields each fixture records)
 * - SUAS-specs MVP_REFERENCE.md §4 (reference observation metadata)
 * - SUAS-specs TESTING.md §12 (fixtures are synthetic)
 *
 * §11 asks for "repeatable screenshot/reference comparison". This catalog
 * supplies the deterministic half: fixed view models, fixed markup, no clock,
 * no database, no network. Capturing images from it and reviewing them against
 * the reference is a human step that this slice does not perform and does not
 * claim — see §10 of the conformance record.
 *
 * Every fixture records the six fields §11 requires: viewport/device class,
 * role, deterministic fixture data, reference source/revision/observation date,
 * conformance class, and approved divergence references.
 */

import { syntheticEmail, syntheticPhone } from '../testing/fixture-boundary.js';
import { CATEGORY_CARDS } from './categories.js';
import { requireSurface, type ConformanceClass, type SurfaceId } from './contract.js';
import {
  renderActiveNeeds,
  renderAdminOverview,
  renderChat,
  renderEnrollment,
  renderImmediateResources,
  renderLanding,
  renderMobileNav,
  renderQrfRequest,
  renderResourceCategories,
  renderResourceList,
  renderResponderAvailability,
  renderResponderDashboard,
  renderVeteranHome,
} from './surfaces.js';
import type { MarkupKind } from './a11y.js';
import type { ShellViewModel, ViewportClass } from './view-models.js';

/** MVP_REFERENCE.md §4 header block. Recorded on every fixture. */
export const REFERENCE_SOURCE = 'https://suasqrf.org/app/' as const;
export const REFERENCE_REVISION = 'MVP_REFERENCE.md 0.1.0 (draft)' as const;
export const REFERENCE_OBSERVED_AT = '2026-08-18 PT' as const;

export interface VisualFixture {
  readonly id: string;
  readonly surfaceId: SurfaceId;
  /** §11 "viewport/device class". */
  readonly viewport: ViewportClass;
  /** §11 "role". */
  readonly role: 'PUBLIC' | 'VETERAN' | 'RESPONDER' | 'ADMIN';
  /** §11 "conformance class", carried from the §5 inventory. */
  readonly conformance: ConformanceClass;
  /** §11 "approved divergence references". */
  readonly divergences: readonly string[];
  /** What state this fixture pins, in review language. */
  readonly description: string;
  readonly markupKind: MarkupKind;
  /** Deterministic: same output on every call, in any environment. */
  readonly render: () => string;
}

function shell(overrides: Partial<ShellViewModel> = {}): ShellViewModel {
  return {
    title: overrides.title ?? 'SUAS',
    viewport: overrides.viewport ?? 'MOBILE',
    showMobileNav: overrides.showMobileNav ?? true,
    ...(overrides.currentNav === undefined ? {} : { currentNav: overrides.currentNav }),
  };
}

/** Operational categories only, as §9.3 scopes Quick Resource Share. */
const OPERATIONAL_CARDS = CATEGORY_CARDS.filter((card) => card.disposition === 'OPERATIONAL');

/**
 * §9: `Responses`, `Rating`, `This Month`, and `Avg Response` have no released
 * definitions, so the fixture pins the not-computable rendering. If a future
 * spec defines them, this fixture changes and the change is reviewable.
 */
const UNDEFINED_METRICS = [
  {
    label: 'Responses',
    state: 'NOT_COMPUTABLE' as const,
    reason: 'No released definition',
  },
  {
    label: 'Avg Response',
    state: 'NOT_COMPUTABLE' as const,
    reason: 'No released definition',
  },
];

function fixture(
  id: string,
  surfaceId: SurfaceId,
  description: string,
  render: () => string,
  options: { viewport?: ViewportClass; markupKind?: MarkupKind } = {},
): VisualFixture {
  const requirement = requireSurface(surfaceId);
  return {
    id,
    surfaceId,
    viewport: options.viewport ?? 'MOBILE',
    role: requirement.audience,
    conformance: requirement.conformance,
    divergences: requirement.divergences,
    description,
    markupKind: options.markupKind ?? 'DOCUMENT',
    render,
  };
}

/** The twelve coverage items §11 enumerates, in its order. */
export const VISUAL_FIXTURES: readonly VisualFixture[] = [
  fixture('landing', 'LANDING', '§11.1 landing/action surface', () =>
    renderLanding({
      shell: shell({ title: 'Shut Up and Serve', showMobileNav: false }),
      missionLine: 'Veteran peer support, coordinated by people who served.',
    }),
  ),

  fixture('enrollment', 'ENROLLMENT', '§11.2 role/enrollment surface', () =>
    renderEnrollment({
      shell: shell({ title: 'Join the Mission', showMobileNav: false }),
      contactChannelRequirement:
        'We need an email address or mobile number to send your sign-in code.',
    }),
  ),

  fixture('veteran-home', 'VETERAN_HOME', '§11.3 veteran support home', () =>
    renderVeteranHome({
      shell: shell({ title: 'Support', currentNav: 'HOME' }),
      categories: CATEGORY_CARDS,
    }),
  ),

  // The state the live /app/home serves once a request is in flight. Without
  // this fixture the §5 required-element assert was never exercised against the
  // in-flight home, and the route raised a 500 there.
  fixture('veteran-home-qrf-in-flight', 'VETERAN_HOME', '§11.3 veteran home, QRF in flight', () =>
    renderVeteranHome({
      shell: shell({ title: 'Support', currentNav: 'HOME' }),
      categories: CATEGORY_CARDS,
      activeQrf: {
        facts: {
          requestStatus: 'MATCHING',
          responderAssigned: false,
          responderNotificationDelivered: false,
          coordinationDegraded: false,
          matchingExhausted: false,
        },
        authorizedVoicePath: false,
        authorizedMessagePath: false,
      },
    }),
  ),

  fixture('qrf-searching', 'QRF_REQUEST', '§11.4 QRF request/searching state', () =>
    renderQrfRequest({
      shell: shell({ title: 'QRF request' }),
      qrf: {
        facts: {
          requestStatus: 'MATCHING',
          responderAssigned: false,
          responderNotificationDelivered: false,
          coordinationDegraded: false,
          matchingExhausted: false,
        },
        authorizedVoicePath: false,
        authorizedMessagePath: false,
      },
    }),
  ),

  fixture('qrf-no-availability', 'QRF_REQUEST', '§11.5 QRF no-availability state', () =>
    renderQrfRequest({
      shell: shell({ title: 'QRF request' }),
      qrf: {
        facts: {
          requestStatus: 'MATCHING',
          responderAssigned: false,
          responderNotificationDelivered: false,
          coordinationDegraded: false,
          matchingExhausted: true,
        },
        authorizedVoicePath: false,
        authorizedMessagePath: false,
      },
    }),
  ),

  fixture('qrf-degraded', 'QRF_REQUEST', '§11.5 QRF degraded state', () =>
    renderQrfRequest({
      shell: shell({ title: 'QRF request' }),
      qrf: {
        facts: {
          requestStatus: 'SUBMITTED',
          responderAssigned: false,
          responderNotificationDelivered: false,
          coordinationDegraded: true,
          matchingExhausted: false,
        },
        authorizedVoicePath: false,
        authorizedMessagePath: false,
      },
    }),
  ),

  fixture(
    'immediate-resources',
    'IMMEDIATE_RESOURCES',
    '§11 reserved D-012 slot (placeholder mode)',
    () => renderImmediateResources(shell({ title: 'Immediate Resources' })),
  ),

  fixture(
    'immediate-resources-approved',
    'IMMEDIATE_RESOURCES',
    '§11 D-012 approved 911/988 copy',
    () => renderImmediateResources(shell({ title: 'Immediate Resources' }), 'approved'),
  ),

  fixture('resource-categories', 'RESOURCE_CATEGORIES', '§11.6 resource category surface', () =>
    renderResourceCategories({
      shell: shell({ title: 'Find help' }),
      categories: CATEGORY_CARDS,
    }),
  ),

  fixture('resource-list', 'RESOURCE_LIST', '§11.7 resource list/detail', () =>
    renderResourceList({
      shell: shell({ title: 'Food' }),
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [
        {
          id: 'res-0001',
          name: 'Example County Food Pantry',
          coverage: 'Example County',
          // P-13: a recorded PHONE scheme becomes a direct `tel:` action.
          contactMethod: syntheticPhone(1),
          contactMethodKind: 'PHONE',
          hours: 'Weekdays, 9am to 4pm',
          freshness: 'FRESH',
          staleWarning: false,
        },
        {
          id: 'res-0002',
          name: 'Example Community Meal Program',
          coverage: 'Example County',
          // P-13: a recorded EMAIL scheme becomes a direct `mailto:` action.
          contactMethod: syntheticEmail('meals'),
          contactMethodKind: 'EMAIL',
          cost: 'No cost',
          freshness: 'AGING',
          staleWarning: true,
        },
        {
          id: 'res-0003',
          name: 'Example Mobile Pantry',
          coverage: 'Example County',
          // No contact_method recorded: the row says so rather than going blank.
          freshness: 'UNVERIFIED',
          staleWarning: true,
        },
      ],
      nextCursor: 'cursor-0002',
    }),
  ),

  fixture('resource-list-empty', 'RESOURCE_LIST', '§11.7 resource list with no listings', () =>
    renderResourceList({
      shell: shell({ title: 'Transportation' }),
      categoryLabel: 'Transportation',
      backHref: '/app/resources',
      rows: [],
    }),
  ),

  fixture(
    'responder-dashboard',
    'RESPONDER_DASHBOARD',
    '§11.8 responder dashboard, on duty',
    () =>
      renderResponderDashboard({
        shell: shell({ title: 'Responder', viewport: 'DESKTOP' }),
        onDuty: true,
        activeNeeds: [
          {
            caseId: 'case-0001',
            caseStatus: 'ASSIGNED',
            category: 'PEER_SUPPORT',
            openedLabel: 'Opened 20 minutes ago',
          },
        ],
        alerts: ['One request is waiting for acknowledgement.'],
        quickShareCategories: OPERATIONAL_CARDS,
        metrics: UNDEFINED_METRICS,
      }),
    { viewport: 'DESKTOP' },
  ),

  fixture('responder-availability', 'RESPONDER_AVAILABILITY', '§11.8 off-duty state', () =>
    renderResponderAvailability({
      shell: shell({ title: 'On Duty' }),
      onDuty: false,
      // D-009 coverage hours are DECISION_PENDING, so no window is shown.
    }),
  ),

  fixture(
    'active-needs',
    'ACTIVE_NEEDS',
    '§11.9 active needs/alerts',
    () =>
      renderActiveNeeds({
        shell: shell({ title: 'Active Needs', viewport: 'DESKTOP' }),
        needs: [
          {
            caseId: 'case-0001',
            caseStatus: 'ACTIVE',
            category: 'FOOD',
            openedLabel: 'Opened 2 hours ago',
          },
        ],
      }),
    { viewport: 'DESKTOP' },
  ),

  fixture('chat-unavailable', 'CHAT', '§11.10 chat entry while messaging is unavailable', () =>
    renderChat({
      shell: shell({ title: 'Chat', currentNav: 'CHAT' }),
      // Pins the state the live route actually serves. An AVAILABLE fixture
      // would pin an empty inbox that no released slice can produce.
      availability: {
        status: 'UNAVAILABLE',
        reason:
          'Messaging is not available yet. Your responder will contact you through ' +
          'the channels you have consented to.',
      },
    }),
  ),

  fixture(
    'admin-overview',
    'ADMIN_OVERVIEW',
    '§11.11 admin overview',
    () =>
      renderAdminOverview({
        shell: shell({ title: 'SUAS Admin', viewport: 'DESKTOP', showMobileNav: false }),
        tenantLabel: 'Example Partner Organization',
        capabilities: [
          { name: 'Peer support (manual)', presence: 'CONFIGURED' },
          {
            name: 'Transportation provider',
            presence: 'MISSING',
            note: 'D-017 pending',
          },
          {
            name: 'Support signal scoring',
            presence: 'MISSING',
            note: 'D-011 pending',
          },
        ],
        blockingDecisions: [
          'D-011 Support Signal scoring rules and thresholds',
          'D-017 Production transportation adapter',
        ],
        readiness: 'SPEC-017 implementation. Not authorized for pilot or production operation.',
      }),
    { viewport: 'DESKTOP' },
  ),

  fixture(
    'mobile-nav',
    'MOBILE_NAV',
    '§11.12 persistent mobile navigation',
    () => renderMobileNav(shell({ title: 'Support', currentNav: 'HOME' })),
    { markupKind: 'FRAGMENT' },
  ),
];

/** §11 requires coverage of these twelve items; the catalog is checked against it. */
export const REQUIRED_FIXTURE_COVERAGE: readonly SurfaceId[] = [
  'LANDING',
  'ENROLLMENT',
  'VETERAN_HOME',
  'QRF_REQUEST',
  'RESOURCE_CATEGORIES',
  'RESOURCE_LIST',
  'RESPONDER_DASHBOARD',
  'RESPONDER_AVAILABILITY',
  'ACTIVE_NEEDS',
  'CHAT',
  'ADMIN_OVERVIEW',
  'MOBILE_NAV',
];
