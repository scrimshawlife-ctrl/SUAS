/**
 * Service Request state machine.
 *
 * Spec citations:
 * - SUAS-specs DISPATCH.md §2 (states), §3 (command concurrency invariant),
 *   §4 (transition table and the explicit cancellation set), §5 (provider
 *   integration relationship), §7 (categories), §11 (non-goals)
 * - SUAS-specs API.md §6 (`ILLEGAL_TRANSITION`, `STALE_STATE`)
 *
 * DISPATCH.md §4 is explicit that the cancellation edges must be encoded as a
 * set, "not a wildcard that accidentally permits CLOSED or invalid historical
 * transitions" — so they are enumerated below rather than derived from
 * "anything non-terminal".
 */

export const SERVICE_REQUEST_STATUSES = [
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
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];

/** DISPATCH.md §7. Reserved future codes are deliberately not values. */
export const SERVICE_CATEGORIES = ['FOOD', 'TRANSPORTATION', 'SHELTER', 'PEER_SUPPORT'] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** DISPATCH.md §7 reserved future categories, rejected until a spec change. */
export const RESERVED_FUTURE_CATEGORIES = [
  'BENEFITS',
  'HOUSING',
  'HEALTHCARE_NAVIGATION',
  'COMMUNITY',
  'OTHER',
] as const;

export const SERVICE_REQUEST_COMMANDS = [
  'SUBMIT',
  'TRIAGE',
  'START_MATCHING',
  'ASSIGN',
  'ACCEPT',
  'START',
  'FULFILL',
  'CONFIRM',
  'CLOSE',
  'DECLINE',
  'REMATCH',
  'CANCEL',
  'EXPIRE',
  'MARK_UNFULFILLABLE',
  'ESCALATE',
  'RETURN_FROM_ESCALATION',
] as const;
export type ServiceRequestCommand = (typeof SERVICE_REQUEST_COMMANDS)[number];

export interface ServiceRequestTransition {
  readonly from: ServiceRequestStatus;
  readonly to: ServiceRequestStatus;
  readonly command: ServiceRequestCommand;
  readonly requiresReason: boolean;
  /**
   * True when the edge discloses veteran data outside SUAS and therefore
   * requires a use-time consent evaluation before it commits (DISPATCH.md §4
   * MATCHING → ASSIGNED, §8).
   */
  readonly mayDiscloseExternally: boolean;
}

/**
 * DISPATCH.md §4, transcribed.
 *
 * Absent by design: any edge that jumps from ASSIGNED to FULFILLED. §5 and §12
 * both call it out — a provider webhook cannot skip the intermediate commands,
 * and "ASSIGNED is not FULFILLED".
 */
export const SERVICE_REQUEST_TRANSITIONS: readonly ServiceRequestTransition[] = [
  {
    from: 'CREATED',
    to: 'SUBMITTED',
    command: 'SUBMIT',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'SUBMITTED',
    to: 'TRIAGED',
    command: 'TRIAGE',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'TRIAGED',
    to: 'MATCHING',
    command: 'START_MATCHING',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  // The one edge in this machine that can put veteran data in front of a third
  // party. DISPATCH.md §4 requires the disclosure basis to be checked here.
  {
    from: 'MATCHING',
    to: 'ASSIGNED',
    command: 'ASSIGN',
    requiresReason: false,
    mayDiscloseExternally: true,
  },
  {
    from: 'ASSIGNED',
    to: 'ACCEPTED',
    command: 'ACCEPT',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'ACCEPTED',
    to: 'IN_PROGRESS',
    command: 'START',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'IN_PROGRESS',
    to: 'FULFILLED',
    command: 'FULFILL',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'FULFILLED',
    to: 'CONFIRMED',
    command: 'CONFIRM',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'CONFIRMED',
    to: 'CLOSED',
    command: 'CLOSE',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'ASSIGNED',
    to: 'DECLINED',
    command: 'DECLINE',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'DECLINED',
    to: 'MATCHING',
    command: 'REMATCH',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  // Explicit cancellation set (DISPATCH.md §4 closing note): the pre-closed
  // workflow states only. CLOSED and the terminal exception states are absent.
  {
    from: 'CREATED',
    to: 'CANCELLED',
    command: 'CANCEL',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'SUBMITTED',
    to: 'CANCELLED',
    command: 'CANCEL',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'TRIAGED',
    to: 'CANCELLED',
    command: 'CANCEL',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'MATCHING',
    to: 'CANCELLED',
    command: 'CANCEL',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'ASSIGNED',
    to: 'CANCELLED',
    command: 'CANCEL',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'ACCEPTED',
    to: 'CANCELLED',
    command: 'CANCEL',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'IN_PROGRESS',
    to: 'CANCELLED',
    command: 'CANCEL',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  // Expiry: only from the documented pre-acceptance states.
  {
    from: 'CREATED',
    to: 'EXPIRED',
    command: 'EXPIRE',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'SUBMITTED',
    to: 'EXPIRED',
    command: 'EXPIRE',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'TRIAGED',
    to: 'EXPIRED',
    command: 'EXPIRE',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'MATCHING',
    to: 'EXPIRED',
    command: 'EXPIRE',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'ASSIGNED',
    to: 'EXPIRED',
    command: 'EXPIRE',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'TRIAGED',
    to: 'UNFULFILLABLE',
    command: 'MARK_UNFULFILLABLE',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'MATCHING',
    to: 'UNFULFILLABLE',
    command: 'MARK_UNFULFILLABLE',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'ASSIGNED',
    to: 'UNFULFILLABLE',
    command: 'MARK_UNFULFILLABLE',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'DECLINED',
    to: 'UNFULFILLABLE',
    command: 'MARK_UNFULFILLABLE',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  // Escalation from the assigned non-terminal workflow states.
  {
    from: 'TRIAGED',
    to: 'ESCALATED',
    command: 'ESCALATE',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'MATCHING',
    to: 'ESCALATED',
    command: 'ESCALATE',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'ASSIGNED',
    to: 'ESCALATED',
    command: 'ESCALATE',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'ACCEPTED',
    to: 'ESCALATED',
    command: 'ESCALATE',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'IN_PROGRESS',
    to: 'ESCALATED',
    command: 'ESCALATE',
    requiresReason: true,
    mayDiscloseExternally: false,
  },
  {
    from: 'ESCALATED',
    to: 'TRIAGED',
    command: 'RETURN_FROM_ESCALATION',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
  {
    from: 'ESCALATED',
    to: 'MATCHING',
    command: 'RETURN_FROM_ESCALATION',
    requiresReason: false,
    mayDiscloseExternally: false,
  },
];

/** Statuses from which no further transition is documented. */
export const TERMINAL_REQUEST_STATUSES: readonly ServiceRequestStatus[] = [
  'CLOSED',
  'CANCELLED',
  'EXPIRED',
  'UNFULFILLABLE',
];

export class IllegalRequestTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly httpStatus = 409;

  constructor(command: ServiceRequestCommand, from: ServiceRequestStatus) {
    super(
      `"${command}" is not a documented transition from service request status "${from}" ` +
        `(SUAS-specs DISPATCH.md §4).`,
    );
    this.name = 'IllegalRequestTransitionError';
  }
}

export class StaleRequestStateError extends Error {
  readonly code = 'STALE_STATE';
  readonly httpStatus = 409;

  constructor(expected: ServiceRequestStatus, actual: ServiceRequestStatus) {
    super(`Expected service request status "${expected}" but found "${actual}".`);
    this.name = 'StaleRequestStateError';
  }
}

export class UnknownServiceCategoryError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor(category: string) {
    const reserved = (RESERVED_FUTURE_CATEGORIES as readonly string[]).includes(category);
    super(
      reserved
        ? `Category "${category}" is reserved for a future release and is not an MVP category ` +
            `(SUAS-specs DISPATCH.md §7).`
        : `"${category}" is not a known service category. MVP categories: ` +
            `${SERVICE_CATEGORIES.join(', ')} (SUAS-specs DISPATCH.md §7).`,
    );
    this.name = 'UnknownServiceCategoryError';
  }
}

export function assertServiceCategory(category: string): asserts category is ServiceCategory {
  if (!(SERVICE_CATEGORIES as readonly string[]).includes(category)) {
    throw new UnknownServiceCategoryError(category);
  }
}

export function findRequestTransition(
  command: ServiceRequestCommand,
  from: ServiceRequestStatus,
  to?: ServiceRequestStatus,
): ServiceRequestTransition | undefined {
  return SERVICE_REQUEST_TRANSITIONS.find(
    (transition) =>
      transition.command === command &&
      transition.from === from &&
      (to === undefined || transition.to === to),
  );
}

/**
 * Resolve the target status for a command, refusing undocumented edges.
 *
 * `RETURN_FROM_ESCALATION` has two documented targets, so callers name the one
 * they intend rather than the implementation picking silently.
 */
export function resolveRequestTransition(
  command: ServiceRequestCommand,
  from: ServiceRequestStatus,
  options: { to?: ServiceRequestStatus; reason?: string } = {},
): ServiceRequestTransition {
  const transition = findRequestTransition(command, from, options.to);
  if (transition === undefined) {
    throw new IllegalRequestTransitionError(command, from);
  }
  if (transition.requiresReason && (options.reason === undefined || options.reason.trim() === '')) {
    throw new Error(`"${command}" requires a reason (SUAS-specs DISPATCH.md §4).`);
  }
  return transition;
}
