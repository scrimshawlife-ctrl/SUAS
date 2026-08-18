/**
 * Support Case state machine.
 *
 * Spec citations:
 * - SUAS-specs CASES.md §2 (exactly these states), §4 (the transition table),
 *   §4.1 (escalation is not a universal state jump), §4.2 (reopen), §10
 *   (no hidden state values)
 * - SUAS-specs RESPONDER_WORKFLOWS.md §2 (named actions), §8 (escalation is not
 *   a wildcard transition)
 * - SUAS-specs API.md §6 (`ILLEGAL_TRANSITION`, `STALE_STATE`)
 *
 * The released table is transcribed as data, not as branching logic, so an edge
 * that is not written down cannot be reached. CASES.md §4 says returns and skips
 * are allowed only where explicitly listed, and §4.1 calls out one specific
 * mistake — escalating an unassigned OPEN or TRIAGED case — that a permissive
 * implementation would allow.
 */

export const CASE_STATUSES = [
  'OPEN',
  'TRIAGED',
  'ASSIGNED',
  'ACTIVE',
  'FOLLOWUP',
  'RESOLVED',
  'CLOSED',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Named responder/admin actions. RESPONDER_WORKFLOWS.md §2. */
export const CASE_COMMANDS = [
  'TRIAGE',
  'CLAIM_CASE',
  'ASSIGN_CASE',
  'ACTIVATE',
  'MOVE_TO_FOLLOWUP',
  'RESUME_ACTIVE',
  'ESCALATE',
  'RESOLVE',
  'CLOSE',
  'REOPEN',
] as const;
export type CaseCommand = (typeof CASE_COMMANDS)[number];

/** Who may perform an edge. Enforced by the authorization layer, recorded here. */
export type CaseActorRole = 'RESPONDER' | 'ASSIGNED_RESPONDER' | 'ORG_ADMIN' | 'SYSTEM';

export interface CaseTransition {
  readonly from: CaseStatus;
  readonly to: CaseStatus;
  readonly command: CaseCommand;
  readonly actors: readonly CaseActorRole[];
  /** True when an active assignment must exist before the command is valid. */
  readonly requiresActiveAssignment: boolean;
  readonly requiresReason: boolean;
}

/**
 * The released transition table from CASES.md §4, plus §4.2 reopen.
 *
 * Note what is absent: there is no `OPEN → ACTIVE`, and no `ESCALATE` edge from
 * `OPEN` or `TRIAGED`. CASES.md §4.1 and §10 name that specific edge as one an
 * implementation must not permit, because no assignment exists to authorize it.
 */
export const CASE_TRANSITIONS: readonly CaseTransition[] = [
  {
    from: 'OPEN',
    to: 'TRIAGED',
    command: 'TRIAGE',
    actors: ['RESPONDER', 'ORG_ADMIN'],
    requiresActiveAssignment: false,
    requiresReason: false,
  },
  {
    from: 'OPEN',
    to: 'ASSIGNED',
    command: 'CLAIM_CASE',
    actors: ['RESPONDER'],
    requiresActiveAssignment: false,
    requiresReason: false,
  },
  {
    from: 'TRIAGED',
    to: 'ASSIGNED',
    command: 'CLAIM_CASE',
    actors: ['RESPONDER'],
    requiresActiveAssignment: false,
    requiresReason: false,
  },
  {
    from: 'OPEN',
    to: 'ASSIGNED',
    command: 'ASSIGN_CASE',
    actors: ['ORG_ADMIN'],
    requiresActiveAssignment: false,
    requiresReason: false,
  },
  {
    from: 'TRIAGED',
    to: 'ASSIGNED',
    command: 'ASSIGN_CASE',
    actors: ['ORG_ADMIN'],
    requiresActiveAssignment: false,
    requiresReason: false,
  },
  // Reassignment edges. CASES.md §4 rows for ASSIGNED/ACTIVE/FOLLOWUP → ASSIGNED.
  {
    from: 'ASSIGNED',
    to: 'ASSIGNED',
    command: 'ASSIGN_CASE',
    actors: ['ASSIGNED_RESPONDER', 'ORG_ADMIN'],
    requiresActiveAssignment: true,
    requiresReason: false,
  },
  {
    from: 'ACTIVE',
    to: 'ASSIGNED',
    command: 'ASSIGN_CASE',
    actors: ['ASSIGNED_RESPONDER', 'ORG_ADMIN'],
    requiresActiveAssignment: true,
    requiresReason: false,
  },
  {
    from: 'FOLLOWUP',
    to: 'ASSIGNED',
    command: 'ASSIGN_CASE',
    actors: ['ASSIGNED_RESPONDER', 'ORG_ADMIN'],
    requiresActiveAssignment: true,
    requiresReason: false,
  },
  {
    from: 'ASSIGNED',
    to: 'ACTIVE',
    command: 'ACTIVATE',
    actors: ['ASSIGNED_RESPONDER'],
    requiresActiveAssignment: true,
    requiresReason: false,
  },
  {
    from: 'ACTIVE',
    to: 'FOLLOWUP',
    command: 'MOVE_TO_FOLLOWUP',
    actors: ['ASSIGNED_RESPONDER'],
    requiresActiveAssignment: true,
    requiresReason: true,
  },
  {
    from: 'FOLLOWUP',
    to: 'ACTIVE',
    command: 'RESUME_ACTIVE',
    actors: ['ASSIGNED_RESPONDER'],
    requiresActiveAssignment: true,
    requiresReason: false,
  },
  // Escalation. CASES.md §4 allows it only from ASSIGNED, ACTIVE, and FOLLOWUP.
  {
    from: 'ASSIGNED',
    to: 'ACTIVE',
    command: 'ESCALATE',
    actors: ['ASSIGNED_RESPONDER'],
    requiresActiveAssignment: true,
    requiresReason: true,
  },
  {
    from: 'ACTIVE',
    to: 'ACTIVE',
    command: 'ESCALATE',
    actors: ['ASSIGNED_RESPONDER'],
    requiresActiveAssignment: true,
    requiresReason: true,
  },
  {
    from: 'FOLLOWUP',
    to: 'ACTIVE',
    command: 'ESCALATE',
    actors: ['ASSIGNED_RESPONDER'],
    requiresActiveAssignment: true,
    requiresReason: true,
  },
  {
    from: 'ACTIVE',
    to: 'RESOLVED',
    command: 'RESOLVE',
    actors: ['ASSIGNED_RESPONDER'],
    requiresActiveAssignment: true,
    requiresReason: false,
  },
  {
    from: 'FOLLOWUP',
    to: 'RESOLVED',
    command: 'RESOLVE',
    actors: ['ASSIGNED_RESPONDER'],
    requiresActiveAssignment: true,
    requiresReason: false,
  },
  {
    from: 'RESOLVED',
    to: 'CLOSED',
    command: 'CLOSE',
    actors: ['ASSIGNED_RESPONDER', 'ORG_ADMIN'],
    requiresActiveAssignment: false,
    requiresReason: false,
  },
  // CASES.md §4.2: reopen is a documented command with reason and audit.
  {
    from: 'CLOSED',
    to: 'OPEN',
    command: 'REOPEN',
    actors: ['ORG_ADMIN'],
    requiresActiveAssignment: false,
    requiresReason: true,
  },
];

/** API.md §6 canonical conflict code. */
export class IllegalCaseTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly httpStatus = 409;

  constructor(command: CaseCommand, from: CaseStatus) {
    super(
      `"${command}" is not a documented transition from case status "${from}" ` +
        `(SUAS-specs CASES.md §4).`,
    );
    this.name = 'IllegalCaseTransitionError';
  }
}

/**
 * Raised when the case moved between the queue read and the mutation.
 * CASES.md §5: queue read freshness is advisory; mutation-time checks are
 * authoritative.
 */
export class StaleCaseStateError extends Error {
  readonly code = 'STALE_STATE';
  readonly httpStatus = 409;

  constructor(expected: CaseStatus, actual: CaseStatus) {
    super(`Expected case status "${expected}" but found "${actual}".`);
    this.name = 'StaleCaseStateError';
  }
}

export class ReasonRequiredError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor(command: string) {
    super(`"${command}" requires a reason (SUAS-specs CASES.md §4; RESPONDER_WORKFLOWS.md §8).`);
    this.name = 'ReasonRequiredError';
  }
}

/** Look up a documented edge, or undefined when none exists. */
export function findCaseTransition(
  command: CaseCommand,
  from: CaseStatus,
): CaseTransition | undefined {
  return CASE_TRANSITIONS.find(
    (transition) => transition.command === command && transition.from === from,
  );
}

/**
 * Resolve the target status for a command, refusing undocumented edges.
 *
 * This is the single place a case status may change, so "only documented edges
 * succeed" (CASES.md §11) holds by construction rather than by review.
 */
export function resolveCaseTransition(
  command: CaseCommand,
  from: CaseStatus,
  options: { reason?: string } = {},
): CaseTransition {
  const transition = findCaseTransition(command, from);
  if (transition === undefined) {
    throw new IllegalCaseTransitionError(command, from);
  }
  if (transition.requiresReason && (options.reason === undefined || options.reason.trim() === '')) {
    throw new ReasonRequiredError(command);
  }
  return transition;
}
