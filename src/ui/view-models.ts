/**
 * View models: the only inputs a surface may render.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §9 (no fabricated zero/placeholder values as
 *   production facts; summaries only when derived from real data)
 * - SUAS-specs MVP_REFERENCE.md §8 (resource data is not timeless hard-coded truth)
 * - SUAS-specs MVP_REFERENCE.md §11 (deterministic fixture data)
 * - SUAS-specs PRIVACY.md (minimum necessary; no veteran address in a surface
 *   that does not need it)
 *
 * Rendering is a pure function of these types. That is what makes §11's
 * fixtures deterministic without a browser or a database, and it keeps the
 * question "may this surface see this field?" answerable by reading one file.
 *
 * A value that is genuinely unknown is modelled as `undefined` or as an
 * explicit `NOT_COMPUTABLE` variant, never as `0` or `'—'`. §9 forbids
 * displaying fabricated placeholder values as production facts, and a metric
 * that defaults to zero is exactly that.
 */

import type { FreshnessBand } from '../fulfillment/index.js';
import type { CategoryCard } from './categories.js';
import type { QrfFacts } from './qrf.js';

/** MVP_REFERENCE.md §11 records a viewport/device class per fixture. */
export const VIEWPORT_CLASSES = ['MOBILE', 'DESKTOP'] as const;
export type ViewportClass = (typeof VIEWPORT_CLASSES)[number];

/** Shared chrome. Every authenticated surface renders the same simple nav. */
export interface ShellViewModel {
  readonly title: string;
  readonly viewport: ViewportClass;
  /** Which persistent nav entry is current, if the surface is in the nav. */
  readonly currentNav?: 'HOME' | 'CHAT';
  /** Rendered only on operational surfaces. §5 persistent mobile nav. */
  readonly showMobileNav: boolean;
}

export interface LandingViewModel {
  readonly shell: ShellViewModel;
  /**
   * Mission line. §7.4: brand may preserve urgency and service framing, but
   * unsupported statistics and clinical efficacy claims are not production
   * copy. No statistic field exists here on purpose.
   */
  readonly missionLine: string;
}

export interface EnrollmentViewModel {
  readonly shell: ShellViewModel;
  /**
   * §7.1: the passwordless contract needs a real channel, so enrollment states
   * the requirement instead of the reference's "No email" promise.
   */
  readonly contactChannelRequirement: string;
}

export interface QrfCardViewModel {
  readonly facts: QrfFacts;
  readonly authorizedVoicePath: boolean;
  readonly authorizedMessagePath: boolean;
}

export interface VeteranHomeViewModel {
  readonly shell: ShellViewModel;
  readonly categories: readonly CategoryCard[];
  /** Present when the veteran has a QRF request in flight. */
  readonly activeQrf?: QrfCardViewModel;
}

export interface QrfRequestViewModel {
  readonly shell: ShellViewModel;
  readonly qrf: QrfCardViewModel;
}

export interface ResourceCategoriesViewModel {
  readonly shell: ShellViewModel;
  readonly categories: readonly CategoryCard[];
}

/**
 * A resource row.
 *
 * §8 asks for "direct phone/email/web actions where allowed", but RESOURCES.md
 * §6 releases `contact_method` as a single unstructured string — the catalog
 * does not record whether a value is a number, an address, or a URL. Rendering
 * a `tel:` or `mailto:` action would mean guessing that structure, so the row
 * carries the released field as text and the surface renders no direct action.
 * Returned to specs as a gap rather than papered over with a parser.
 */
export interface ResourceRowViewModel {
  readonly id: string;
  readonly name: string;
  /** Coverage context, shown only where verified. §8. */
  readonly coverage?: string;
  /** RESOURCES.md §6 `contact_method`, verbatim and unparsed. */
  readonly contactMethod?: string;
  readonly hours?: string;
  readonly cost?: string;
  /** Verification freshness. §8 "visible freshness/availability truth when known". */
  readonly freshness: FreshnessBand;
  /** True when freshness requires an explicit staleness warning. */
  readonly staleWarning: boolean;
}

export interface ResourceListViewModel {
  readonly shell: ShellViewModel;
  readonly categoryLabel: string;
  readonly rows: readonly ResourceRowViewModel[];
  /** Keyset cursor for §8 progressive loading. Absent when the list is complete. */
  readonly nextCursor?: string;
  readonly backHref: string;
}

/**
 * A responder metric. §9 permits `Responses`, `Rating`, `This Month`, and
 * `Avg Response` "only if exact definitions/data are specified". No released
 * spec defines them, so the value variant carries that fact instead of a zero.
 */
export interface ResponderMetricViewModel {
  readonly label: string;
  readonly state: 'AVAILABLE' | 'NOT_COMPUTABLE';
  /** Present only when `state` is `AVAILABLE`. */
  readonly value?: string;
  /** Why it is not computable, when it is not. */
  readonly reason?: string;
}

export interface ActiveNeedViewModel {
  readonly caseId: string;
  /** Canonical Case status. §5 "canonical Case/Request state applies". */
  readonly caseStatus: string;
  readonly category: string;
  /** Human-readable age, derived from a real timestamp. */
  readonly openedLabel: string;
}

export interface ResponderDashboardViewModel {
  readonly shell: ShellViewModel;
  readonly onDuty: boolean;
  readonly activeNeeds: readonly ActiveNeedViewModel[];
  readonly alerts: readonly string[];
  /** §9.3 Quick Resource Share covers the released MVP capabilities only. */
  readonly quickShareCategories: readonly CategoryCard[];
  readonly metrics: readonly ResponderMetricViewModel[];
}

export interface ResponderAvailabilityViewModel {
  readonly shell: ShellViewModel;
  readonly onDuty: boolean;
  /** Coverage hours are D-009 `DECISION_PENDING`; absent rather than invented. */
  readonly coverageWindow?: string;
}

export interface ActiveNeedsViewModel {
  readonly shell: ShellViewModel;
  readonly needs: readonly ActiveNeedViewModel[];
}

export interface ChatThreadViewModel {
  readonly threadId: string;
  readonly counterpartLabel: string;
  readonly lastMessagePreview?: string;
}

/**
 * Chat is either unavailable with a stated reason, or available with a thread
 * list that may be empty.
 *
 * A union rather than an optional reason, because "no threads and no reason"
 * renders as an empty inbox — which implies working messaging. No released
 * slice stores a thread, so that state would always be a lie today, and the
 * type makes it unrepresentable rather than relying on every caller to
 * remember. The slice that implements messaging supplies `AVAILABLE`.
 */
export type ChatAvailability =
  | { readonly status: 'UNAVAILABLE'; readonly reason: string }
  | { readonly status: 'AVAILABLE'; readonly threads: readonly ChatThreadViewModel[] };

export interface ChatViewModel {
  readonly shell: ShellViewModel;
  readonly availability: ChatAvailability;
}

/** A capability's readiness, as the admin overview may state it. */
export interface AdminCapabilityViewModel {
  readonly name: string;
  /** ARCHITECTURE.md: presence only, never credential values. */
  readonly presence: 'CONFIGURED' | 'MISSING';
  readonly note?: string;
}

export interface AdminOverviewViewModel {
  readonly shell: ShellViewModel;
  /** §7.5: explicit `SUAS Admin` terminology, and a visible scope. */
  readonly tenantLabel: string;
  readonly capabilities: readonly AdminCapabilityViewModel[];
  /** Open decisions that currently block operation. */
  readonly blockingDecisions: readonly string[];
  readonly readiness: string;
}
