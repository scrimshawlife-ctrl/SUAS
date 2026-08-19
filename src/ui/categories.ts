/**
 * Reference category labels mapped to canonical product state.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §6 (category/display mapping)
 * - SUAS-specs MVP_REFERENCE.md §5 (recognizable category surface)
 * - SUAS-specs DISPATCH.md §7 / request-transitions (reserved future categories)
 *
 * §6's operative sentence is "Display continuity is not permission to create an
 * unreleased domain category." A card may keep its familiar MVP label while
 * being explicitly non-operational, so this table pairs each label with either
 * a released `ServiceCategory` or an explicit non-operational disposition.
 * Nothing else may turn a card into a Service Request.
 */

import type { ServiceCategory } from '../coordination/index.js';

/** What tapping a category card is actually allowed to do. */
export const CATEGORY_DISPOSITIONS = [
  /** Creates a canonical Service Request in a released category. */
  'OPERATIONAL',
  /** Visible for continuity; opens information only, never a Service Request. */
  'INFORMATION_ONLY',
  /** Visible and explicitly labelled as not yet available. */
  'COMING_SOON',
] as const;
export type CategoryDisposition = (typeof CATEGORY_DISPOSITIONS)[number];

export interface CategoryCard {
  /** The MVP label the veteran recognizes. §6 permits familiar vocabulary. */
  readonly label: string;
  readonly disposition: CategoryDisposition;
  /** Present only when `disposition` is `OPERATIONAL`. */
  readonly category?: ServiceCategory;
  /** Shown to the veteran when the card is not operational. */
  readonly note?: string;
  /** The §6 row this card implements, for the conformance record. */
  readonly basis: string;
}

/**
 * MVP_REFERENCE.md §5 requires all six reference labels remain recognizable,
 * and §6 fixes what each one may actually do.
 */
export const CATEGORY_CARDS: readonly CategoryCard[] = [
  {
    label: 'Housing',
    disposition: 'OPERATIONAL',
    category: 'SHELTER',
    note: 'Temporary shelter. Long-term housing placement is not available yet.',
    basis: '§6 Housing → operational only as temporary SHELTER; permanent HOUSING is FUTURE',
  },
  {
    label: 'Food',
    disposition: 'OPERATIONAL',
    category: 'FOOD',
    basis: '§6 Food → operational FOOD',
  },
  {
    label: 'Transportation',
    disposition: 'OPERATIONAL',
    category: 'TRANSPORTATION',
    basis: '§6 Transportation → operational TRANSPORTATION',
  },
  {
    label: 'Counseling',
    disposition: 'COMING_SOON',
    note: 'Not available yet. This does not create a request.',
    basis: '§6 Counseling → HEALTHCARE_NAVIGATION remains FUTURE; information-only, not hidden',
  },
  {
    label: 'Activities',
    disposition: 'INFORMATION_ONLY',
    note: 'Community listings only. This does not create a request.',
    basis: '§6 Activities/Community → COMMUNITY remains FUTURE; informational card permitted',
  },
  {
    label: 'Job Training',
    disposition: 'COMING_SOON',
    note: 'Not available yet. This does not create a request.',
    basis: '§6 Job Training → future/unreleased; visibly COMING_SOON/information-only',
  },
];

export class NonOperationalCategoryError extends Error {
  readonly code = 'CATEGORY_NOT_OPERATIONAL';
  readonly httpStatus = 409;
  constructor(
    readonly label: string,
    readonly disposition: CategoryDisposition,
  ) {
    super(
      `Category card "${label}" is ${disposition} and cannot create a Service Request. ` +
        'MVP_REFERENCE.md §6: display continuity is not permission to create an ' +
        'unreleased domain category.',
    );
    this.name = 'NonOperationalCategoryError';
  }
}

/**
 * Resolve a tapped card to the canonical category it may request.
 *
 * A non-operational card refuses here rather than at the domain boundary, so
 * the refusal names the display rule that was violated. The domain layer
 * refuses these categories too (`assertServiceCategory`); this is the second of
 * the two locks, not the only one.
 */
export function categoryForCard(label: string): ServiceCategory {
  const card = CATEGORY_CARDS.find((entry) => entry.label === label);
  if (card === undefined) {
    throw new NonOperationalCategoryError(label, 'COMING_SOON');
  }
  if (card.disposition !== 'OPERATIONAL' || card.category === undefined) {
    throw new NonOperationalCategoryError(label, card.disposition);
  }
  return card.category;
}
