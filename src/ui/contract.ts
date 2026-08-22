/**
 * The reference conformance contract, transcribed as data.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §2 (conformance classes; no required element
 *   may silently disappear)
 * - SUAS-specs MVP_REFERENCE.md §5 (required surface inventory)
 * - SUAS-specs MVP_REFERENCE.md §11 (visual-regression fixture contract)
 * - SUAS-specs MVP_REFERENCE.md §12 (`UI_CONFORMANCE` gate)
 *
 * The inventory is transcribed rather than inferred from the routes that happen
 * to exist, so a surface that is deleted or never built fails a test instead of
 * quietly vanishing — which is exactly what §2's "no required element may
 * silently disappear" asks the implementation to make mechanical.
 */

/** MVP_REFERENCE.md §2. */
export const CONFORMANCE_CLASSES = [
  'MUST_MATCH',
  'MUST_PRESERVE_BEHAVIOR',
  'MAY_EVOLVE',
  'MUST_CHANGE_FOR_PRODUCTION',
] as const;
export type ConformanceClass = (typeof CONFORMANCE_CLASSES)[number];

/** The identities used by routes, fixtures, and the inventory test alike. */
export const SURFACE_IDS = [
  'LANDING',
  'ENROLLMENT',
  'VETERAN_HOME',
  'QRF_REQUEST',
  'IMMEDIATE_RESOURCES',
  'RESOURCE_CATEGORIES',
  'RESOURCE_LIST',
  'RESPONDER_DASHBOARD',
  'RESPONDER_AVAILABILITY',
  'ACTIVE_NEEDS',
  'CHAT',
  'MOBILE_NAV',
  'ADMIN_OVERVIEW',
] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

/** The role a surface is rendered for. MVP_REFERENCE.md §4.4 role recognition. */
export const SURFACE_AUDIENCES = ['PUBLIC', 'VETERAN', 'RESPONDER', 'ADMIN'] as const;
export type SurfaceAudience = (typeof SURFACE_AUDIENCES)[number];

export interface SurfaceRequirement {
  readonly id: SurfaceId;
  /** The §5 "reference anchor" column, kept verbatim enough to be checkable. */
  readonly referenceAnchor: string;
  readonly conformance: ConformanceClass;
  readonly audience: SurfaceAudience;
  /**
   * Actions or landmarks §3/§5 require to be recognizable. A render that drops
   * one of these fails `assertRequiredElementsPresent`, which is the mechanical
   * form of §2's "no required element may silently disappear".
   */
  readonly requiredElements: readonly string[];
  /**
   * Required elements for a named state of the same surface.
   *
   * A surface legitimately changes its dominant action with state: once a QRF
   * request is in flight, offering a second Deploy button would be wrong, so
   * the in-flight home carries the request block in that position instead. §2
   * still applies — the landmark must be *replaced*, never dropped — so each
   * state names its own required elements rather than relaxing the assert.
   */
  readonly stateVariants?: Readonly<Record<string, readonly string[]>>;
  /** Divergences from §7 that this surface must implement, if any. */
  readonly divergences: readonly string[];
}

/** MVP_REFERENCE.md §5, in the order the table lists them. */
export const REQUIRED_SURFACES: readonly SurfaceRequirement[] = [
  {
    id: 'LANDING',
    referenceAnchor: 'TAKE ACTION; I NEED SUPPORT; I WANT TO SERVE',
    conformance: 'MUST_MATCH',
    audience: 'PUBLIC',
    requiredElements: ['TAKE ACTION', 'I NEED SUPPORT', 'I WANT TO SERVE'],
    divergences: ['§7.4 mission/statistic/clinical language'],
  },
  {
    id: 'ENROLLMENT',
    referenceAnchor: 'Join the Mission; Veteran vs Responder',
    conformance: 'MUST_PRESERVE_BEHAVIOR',
    audience: 'PUBLIC',
    requiredElements: ['Join the Mission', 'Veteran', 'Responder'],
    divergences: ['§7.1 enrollment copy'],
  },
  {
    id: 'VETERAN_HOME',
    referenceAnchor: 'QRF dominant action + Immediate Resources + categories',
    conformance: 'MUST_MATCH',
    audience: 'VETERAN',
    requiredElements: ['Deploy QRF', 'Immediate Resources', 'Housing', 'Food'],
    stateVariants: {
      // §7.2 preserves the deploy → searching → contact/cancel sequence, so the
      // in-flight home shows the request in the dominant slot. Everything else
      // §5 requires stays exactly where it was.
      QRF_IN_FLIGHT: ['Your QRF request', 'Immediate Resources', 'Housing', 'Food'],
    },
    divergences: ['§7.2 QRF deployment truthfulness'],
  },
  {
    id: 'QRF_REQUEST',
    referenceAnchor: 'tap/deploy → searching/pending → contact/cancel',
    conformance: 'MUST_PRESERVE_BEHAVIOR',
    audience: 'VETERAN',
    requiredElements: ['Cancel'],
    divergences: ['§7.2 QRF deployment truthfulness'],
  },
  {
    id: 'IMMEDIATE_RESOURCES',
    referenceAnchor: 'crisis/help resources above general catalog',
    conformance: 'MUST_MATCH',
    audience: 'VETERAN',
    requiredElements: ['Immediate Resources'],
    divergences: ['§7.3 crisis/immediate-resource copy (D-012 approved wording)'],
  },
  {
    id: 'RESOURCE_CATEGORIES',
    referenceAnchor: 'Housing/Food/Counseling/Transportation/Activities/Job Training',
    conformance: 'MUST_MATCH',
    audience: 'VETERAN',
    requiredElements: [
      'Housing',
      'Food',
      'Counseling',
      'Transportation',
      'Activities',
      'Job Training',
    ],
    divergences: ['§6 category/display mapping'],
  },
  {
    id: 'RESOURCE_LIST',
    referenceAnchor: 'category heading + direct contact actions + back nav',
    conformance: 'MUST_PRESERVE_BEHAVIOR',
    audience: 'VETERAN',
    requiredElements: ['Back'],
    divergences: ['§8 resource-screen fidelity'],
  },
  {
    id: 'RESPONDER_DASHBOARD',
    referenceAnchor: 'on-duty state, active-work emphasis, Quick Resource Share',
    conformance: 'MUST_MATCH',
    audience: 'RESPONDER',
    requiredElements: ['On Duty', 'Quick Resource Share', 'Alerts'],
    divergences: ['§9 responder/QRF dashboard fidelity'],
  },
  {
    id: 'RESPONDER_AVAILABILITY',
    referenceAnchor: 'on-duty/readiness state',
    conformance: 'MUST_PRESERVE_BEHAVIOR',
    audience: 'RESPONDER',
    requiredElements: ['On Duty'],
    divergences: [],
  },
  {
    id: 'ACTIVE_NEEDS',
    referenceAnchor: 'alerts/current work',
    conformance: 'MUST_PRESERVE_BEHAVIOR',
    audience: 'RESPONDER',
    requiredElements: ['Active Needs'],
    divergences: [],
  },
  {
    id: 'CHAT',
    referenceAnchor: 'persistent Chat entry',
    conformance: 'MUST_PRESERVE_BEHAVIOR',
    audience: 'VETERAN',
    requiredElements: ['Chat'],
    divergences: [],
  },
  {
    id: 'MOBILE_NAV',
    referenceAnchor: 'Home + Chat simplicity',
    conformance: 'MUST_MATCH',
    audience: 'VETERAN',
    requiredElements: ['Home', 'Chat'],
    divergences: [],
  },
  {
    id: 'ADMIN_OVERVIEW',
    referenceAnchor: 'distinct privileged overview',
    conformance: 'MAY_EVOLVE',
    audience: 'ADMIN',
    requiredElements: ['SUAS Admin'],
    divergences: ['§7.5 admin terminology'],
  },
];

const BY_ID = new Map<SurfaceId, SurfaceRequirement>(
  REQUIRED_SURFACES.map((surface) => [surface.id, surface]),
);

export class UnknownSurfaceError extends Error {
  readonly code = 'UNKNOWN_SURFACE';
  readonly httpStatus = 404;
  constructor(id: string) {
    super(
      `Surface "${id}" is not in the MVP_REFERENCE.md §5 required inventory. ` +
        'Adding a surface means adding it to the released inventory first.',
    );
    this.name = 'UnknownSurfaceError';
  }
}

export function requireSurface(id: string): SurfaceRequirement {
  const surface = BY_ID.get(id as SurfaceId);
  if (surface === undefined) throw new UnknownSurfaceError(id);
  return surface;
}

export class MissingRequiredElementError extends Error {
  readonly code = 'MISSING_REQUIRED_ELEMENT';
  readonly httpStatus = 500;
  constructor(
    readonly surfaceId: SurfaceId,
    readonly missing: readonly string[],
    readonly variant?: string,
  ) {
    super(
      `Surface ${surfaceId}${variant === undefined ? '' : ` (${variant})`} rendered without ` +
        `required element(s): ${missing.join(', ')}. ` +
        'MVP_REFERENCE.md §2: no required element may silently disappear.',
    );
    this.name = 'MissingRequiredElementError';
  }
}

export class UnknownSurfaceStateError extends Error {
  readonly code = 'UNKNOWN_SURFACE_STATE';
  readonly httpStatus = 500;
  constructor(surfaceId: SurfaceId, variant: string) {
    super(
      `Surface ${surfaceId} declares no required elements for state "${variant}". ` +
        'A new surface state names what it must still show before it can render.',
    );
    this.name = 'UnknownSurfaceStateError';
  }
}

/**
 * Assert that a rendered surface still contains its required anchors.
 *
 * This is a text containment check, not a semantic one: it catches deletion and
 * rename, which is the drift §2 names. Hierarchy and emphasis are reviewed
 * against the fixtures in §11, which no automated check can replace.
 */
export function assertRequiredElementsPresent(
  id: SurfaceId,
  markup: string,
  variant?: string,
): void {
  const surface = requireSurface(id);

  let required = surface.requiredElements;
  if (variant !== undefined) {
    // An unnamed state fails closed: a new surface state must declare what it
    // still has to show, rather than inheriting an assert that cannot hold.
    const variantElements = surface.stateVariants?.[variant];
    if (variantElements === undefined) throw new UnknownSurfaceStateError(id, variant);
    required = variantElements;
  }

  const missing = required.filter((element) => !markup.includes(element));
  if (missing.length > 0) throw new MissingRequiredElementError(id, missing, variant);
}
