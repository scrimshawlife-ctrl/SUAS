/**
 * The immediate-resource slot, reserved and unfilled.
 *
 * Spec citations:
 * - SUAS-specs SAFETY.md §2 ("implementation may reserve a copy slot but must
 *   not invent crisis-resource wording presented as official"; D-012 is
 *   `DECISION_PENDING`)
 * - SUAS-specs SAFETY.md §3.1 (show the veteran the *approved* crisis-resource list)
 * - SUAS-specs SAFETY.md §9 (`RED` surfaces the approved-resource slot, or a
 *   placeholder when D-012 is open, and does not call an emergency API)
 * - SUAS-specs MVP_REFERENCE.md §7.3 (placement `MUST_MATCH`; exact copy
 *   `MUST_CHANGE_FOR_PRODUCTION` where not approved)
 * - SUAS-specs DECISIONS.md D-012 (`DECISION_PENDING`)
 *
 * This is the fail-closed seam of this slice. The reference gives crisis
 * resources a prominent, dominant placement, and §7.3 requires production to
 * *preserve that placement*. It also forbids shipping the wording. Both hold at
 * once: the slot renders in its reference position, and it renders empty with a
 * truthful explanation rather than wording this implementation made up.
 *
 * The registry below ships empty on purpose, the same shape as the Slice 7
 * projection contracts and the Slice 9 signal engines. Closing D-012 means
 * populating it from the released decision, not editing a template.
 */

/** DECISIONS.md D-012. Flipping this constant is a spec event, not a code edit. */
export const D_012_APPROVED_SAFETY_COPY = 'DECISION_PENDING' as const;

export interface ApprovedCrisisResource {
  readonly label: string;
  /** Destination approved by D-012. Not a link this implementation chose. */
  readonly destination: string;
  /** The released decision text this entry transcribes. */
  readonly approvedUnder: string;
}

/**
 * Approved crisis resources. Empty until D-012 closes.
 *
 * Deliberately not seeded with well-known public crisis lines: SAFETY.md §2
 * forbids inventing crisis-resource wording "presented as official", and a
 * nationally correct number shipped without the approved decision is exactly
 * the unapproved official-looking copy the rule names.
 */
const APPROVED_CRISIS_RESOURCES: readonly ApprovedCrisisResource[] = [];

export const IMMEDIATE_RESOURCE_SLOT_STATES = ['APPROVED', 'PLACEHOLDER'] as const;
export type ImmediateResourceSlotState = (typeof IMMEDIATE_RESOURCE_SLOT_STATES)[number];

export interface ImmediateResourceSlot {
  readonly state: ImmediateResourceSlotState;
  readonly resources: readonly ApprovedCrisisResource[];
  /**
   * Shown in the reserved slot when no approved copy exists. States the
   * unavailability as a fact about this system; it gives no crisis guidance,
   * no destination, and no clinical framing.
   */
  readonly placeholder?: string;
  readonly basis: string;
}

/**
 * Resolve what the reserved immediate-resource slot renders.
 *
 * Never throws: §7.3 requires the placement to survive even while the copy is
 * unavailable, so an empty registry produces a visible, labelled placeholder
 * rather than a missing section.
 */
export function resolveImmediateResourceSlot(): ImmediateResourceSlot {
  if (APPROVED_CRISIS_RESOURCES.length === 0) {
    return {
      state: 'PLACEHOLDER',
      resources: [],
      placeholder:
        'Approved immediate-resource information is not available in this build. ' +
        'This section is reserved and will show the approved resources once they are released.',
      basis: `SAFETY.md §2 and §9; D-012 ${D_012_APPROVED_SAFETY_COPY}`,
    };
  }
  return {
    state: 'APPROVED',
    resources: APPROVED_CRISIS_RESOURCES,
    basis: 'SAFETY.md §3.1 approved crisis-resource list',
  };
}

export class UnapprovedSafetyCopyError extends Error {
  readonly code = 'UNAPPROVED_SAFETY_COPY';
  readonly httpStatus = 409;
  constructor(context: string) {
    super(
      `${context} requires approved production safety copy, and D-012 is ` +
        `${D_012_APPROVED_SAFETY_COPY}. SAFETY.md §2: implementation may reserve a ` +
        'copy slot but must not invent crisis-resource wording presented as official.',
    );
    this.name = 'UnapprovedSafetyCopyError';
  }
}

/**
 * Refuse to present crisis copy as official while D-012 is open.
 *
 * Any future caller that wants to render authoritative safety wording — a red
 * check-in outcome, a veteran-initiated emergency screen (SAFETY.md §5) — goes
 * through here and is refused, rather than reaching for a string constant.
 */
export function assertApprovedSafetyCopyAvailable(context: string): void {
  if (APPROVED_CRISIS_RESOURCES.length === 0) {
    throw new UnapprovedSafetyCopyError(context);
  }
}
