/**
 * The failure drills, transcribed as data.
 *
 * Spec citations:
 * - SUAS-specs RESILIENCE.md §17 (the thirteen drills staging must exercise;
 *   "Results/remediation are recorded")
 * - SUAS-specs RESILIENCE.md §18 (`RESILIENCE` gate: "failure drills pass or
 *   have accepted mitigations")
 * - SUAS-specs SCALING.md §15 (`SCALE` gate: "test artifacts record workload
 *   dimensions, environment, results, and caveats")
 *
 * §17 enumerates thirteen drills. Transcribing them means a run cannot quietly
 * skip one: assembling a report requires a result for every drill, and a drill
 * with no result fails the assembly rather than producing a shorter report that
 * reads as complete.
 */

/** RESILIENCE.md §17, in the order the spec lists them. */
export const DRILL_IDS = [
  'NOTIFICATION_PROVIDER_UNAVAILABLE',
  'FULFILLMENT_TIMEOUT_AFTER_POSSIBLE_ACCEPTANCE',
  'DUPLICATE_OR_OUT_OF_ORDER_WEBHOOK',
  'WORKER_RESTART_WITH_QUEUED_WORK',
  'QUEUE_BACKLOG_BURST',
  'DB_TRANSIENT_FAILURE_AROUND_COMMIT',
  'PROVIDER_RATE_LIMIT_MANUAL_FALLBACK',
  'DUPLICATE_API_COMMAND_AFTER_LOST_RESPONSE',
  'CONCURRENT_SETTLEMENT_RESOLVE',
  'STALE_FOLLOW_UP_AFTER_RESCHEDULE',
  'REVOKE_THEN_REQUEST_ON_ANOTHER_INSTANCE',
  'OUTBOX_PUBLISHER_CRASH_AFTER_COMMIT',
  'RESTORE_REHEARSAL_WITH_PENDING_ATTEMPTS',
] as const;
export type DrillId = (typeof DRILL_IDS)[number];

export interface DrillDefinition {
  readonly id: DrillId;
  /** The §17 item, close enough to the released text to be checkable. */
  readonly description: string;
  /** The invariant the drill is evidence for, from §18 or SCALING.md §15. */
  readonly invariant: string;
}

export const DRILLS: readonly DrillDefinition[] = [
  {
    id: 'NOTIFICATION_PROVIDER_UNAVAILABLE',
    description: '§17.1 notification provider unavailable',
    invariant: '§18 provider/notification outages preserve parent workflow correctness',
  },
  {
    id: 'FULFILLMENT_TIMEOUT_AFTER_POSSIBLE_ACCEPTANCE',
    description: '§17.2 fulfillment provider timeout after possible acceptance',
    invariant: '§18 ambiguous provider mutations reconcile',
  },
  {
    id: 'DUPLICATE_OR_OUT_OF_ORDER_WEBHOOK',
    description: '§17.3 duplicate/out-of-order provider webhook',
    invariant: '§18 duplicate jobs/webhooks/API retries are safe',
  },
  {
    id: 'WORKER_RESTART_WITH_QUEUED_WORK',
    description: '§17.4 worker restart with queued work',
    invariant: '§18 production-critical work survives restart',
  },
  {
    id: 'QUEUE_BACKLOG_BURST',
    description: '§17.5 queue backlog/burst',
    // §18 pairs backpressure with tenant fairness. Only the bounded-response
    // half is provable here: fairness needs a released policy and D-021's
    // envelope, so claiming it in the invariant would overstate the drill.
    invariant: '§18 backpressure, bounded-response half only; tenant fairness is not claimed',
  },
  {
    id: 'DB_TRANSIENT_FAILURE_AROUND_COMMIT',
    description: '§17.6 DB transient failure/lost response around domain commit',
    invariant: '§18 retries/replays are bounded/idempotent',
  },
  {
    id: 'PROVIDER_RATE_LIMIT_MANUAL_FALLBACK',
    description: '§17.7 provider rate limiting/manual fallback',
    invariant: '§18 provider outages preserve parent workflow correctness',
  },
  {
    id: 'DUPLICATE_API_COMMAND_AFTER_LOST_RESPONSE',
    description: '§17.8 duplicate API command after lost response',
    invariant: '§18 duplicate API retries are safe',
  },
  {
    id: 'CONCURRENT_SETTLEMENT_RESOLVE',
    description: '§17.9 concurrent Settlement resolve using same/different idempotency keys',
    invariant: 'SCALING.md §15 contested Settlement operations are atomic',
  },
  {
    id: 'STALE_FOLLOW_UP_AFTER_RESCHEDULE',
    description: '§17.10 Follow-Up reschedule followed by stale due job',
    invariant: '§18 stale scheduled work is suppressed',
  },
  {
    id: 'REVOKE_THEN_REQUEST_ON_ANOTHER_INSTANCE',
    description: '§17.11 session/membership revoke followed by request on another app instance',
    invariant: '§18 session revocation remains authoritative across instances',
  },
  {
    id: 'OUTBOX_PUBLISHER_CRASH_AFTER_COMMIT',
    description: '§17.12 event/outbox publisher crash after domain commit before publication',
    invariant: '§18 event publication recovers without lost logical business facts',
  },
  {
    id: 'RESTORE_REHEARSAL_WITH_PENDING_ATTEMPTS',
    description: '§17.13 restore rehearsal with pending/unknown provider attempts',
    invariant: '§18 D-024 recovery objectives are set and restore procedure is tested',
  },
];

const BY_ID = new Map<DrillId, DrillDefinition>(DRILLS.map((drill) => [drill.id, drill]));

export class UnknownDrillError extends Error {
  readonly code = 'UNKNOWN_DRILL';
  constructor(id: string) {
    super(
      `"${id}" is not a RESILIENCE.md §17 drill. The drill list is released; ` +
        'adding one means changing the spec first.',
    );
    this.name = 'UnknownDrillError';
  }
}

export function requireDrill(id: string): DrillDefinition {
  const drill = BY_ID.get(id as DrillId);
  if (drill === undefined) throw new UnknownDrillError(id);
  return drill;
}

/**
 * A drill outcome.
 *
 * `BLOCKED` is a first-class result, not a failure to run: §18 accepts drills
 * that "pass or have accepted mitigations", and a drill whose dependency is an
 * unreleased decision has neither passed nor failed. It must state why.
 */
export const DRILL_OUTCOMES = ['PASS', 'BLOCKED'] as const;
export type DrillOutcome = (typeof DRILL_OUTCOMES)[number];

export interface DrillResult {
  readonly drillId: DrillId;
  readonly outcome: DrillOutcome;
  /** What was actually observed. Required for both outcomes. */
  readonly evidence: string;
  /** Required when `BLOCKED`: what is missing, naming the decision or gap. */
  readonly blockedReason?: string;
  readonly caveats: readonly string[];
}

export class DrillEvidenceRequiredError extends Error {
  readonly code = 'DRILL_EVIDENCE_REQUIRED';
  constructor(drillId: DrillId, what: string) {
    super(`Drill ${drillId} recorded no ${what}. RESILIENCE.md §17: results are recorded.`);
    this.name = 'DrillEvidenceRequiredError';
  }
}

/** Validate a result before it can enter a report. */
export function recordDrillResult(result: DrillResult): DrillResult {
  requireDrill(result.drillId);
  if (result.evidence.trim() === '') {
    throw new DrillEvidenceRequiredError(result.drillId, 'evidence');
  }
  if (result.outcome === 'BLOCKED' && (result.blockedReason ?? '').trim() === '') {
    throw new DrillEvidenceRequiredError(result.drillId, 'blocked reason');
  }
  return result;
}
