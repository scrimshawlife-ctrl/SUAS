/**
 * Support Signal computation engine interface.
 *
 * Spec citations:
 * - SUAS-specs SUPPORT_SIGNALS.md §1 (a coordination priority label, not a
 *   diagnosis or suicidality determination), §2 (computation contract:
 *   deterministic, inspectable, versioned, unit-tested, reproducible, idempotently
 *   settled; "No generative model may produce the primary signal"; exact scoring
 *   rules and thresholds remain D-011 `DECISION_PENDING` and implementation "must
 *   not ship invented weights or thresholds"), §3 (computation identity), §10
 *   (non-goals)
 * - SUAS-specs CHECKINS.md §4.1 (do not compute a production signal from
 *   incomplete input until D-011 closes; unreleased fixtures may exercise the
 *   interface but must be labeled)
 * - SUAS-specs TESTING.md §12 (D-011 golden vectors remain `UNRELEASED_FIXTURE`)
 * - SUAS-specs ENVIRONMENT.md §3 (`SUAS_SUPPORT_SIGNAL_MODE` = `disabled|fixture`;
 *   "fixture ... is never production authority")
 *
 * §2 permits exactly this much: a pure function contract and unreleased fixtures.
 * The registry therefore ships **empty**, and a registered engine must declare
 * whether it is released. No engine here contains a weight, a threshold, or a
 * rule — because none has been released to contain.
 */

import type { JsonObject } from '../jobs/index.js';

/** SUPPORT_SIGNALS.md §1. Exactly these values. */
export const SIGNAL_LEVELS = ['GREEN', 'YELLOW', 'ORANGE', 'RED'] as const;
export type SignalLevel = (typeof SIGNAL_LEVELS)[number];

/** One canonical answer, as the engine sees it. Free text is deliberately absent. */
export interface CanonicalAnswer {
  readonly questionKey: string;
  readonly dimension: string | undefined;
  readonly optionKey: string | undefined;
}

/**
 * The canonical inputs to a computation.
 *
 * SUPPORT_SIGNALS.md §2 requires determinism over *canonical* inputs, and §10
 * forbids generative interpretation of free text as a primary signal — so free
 * text is not part of this structure at all. It cannot be read by an engine
 * because it is never handed to one.
 */
export interface CanonicalSignalInput {
  readonly checkInId: string | undefined;
  readonly sourceReference: string | undefined;
  readonly questionnaireVersion: string | undefined;
  readonly answers: readonly CanonicalAnswer[];
  /** True when required answers are missing. CHECKINS.md §4.1. */
  readonly incomplete: boolean;
}

export interface SignalComputation {
  readonly level: SignalLevel;
  /**
   * Inspectable record of the canonical inputs and rules used.
   * §2: without unnecessary sensitive payload duplication.
   */
  readonly basis: JsonObject;
}

export interface SignalEngine {
  /** Published immutable identifier. SUPPORT_SIGNALS.md §2. */
  readonly signalVersion: string;
  /**
   * Whether this engine implements a released scoring contract.
   *
   * False for every engine that can exist today: D-011 is open, so a fixture
   * engine is a test instrument and never production authority
   * (ENVIRONMENT.md §3).
   */
  readonly released: boolean;
  /** Whether the engine defines deterministic missing-input behavior (§4.1). */
  readonly handlesIncompleteInput: boolean;
  /** Pure function. Same canonical inputs and version produce the same result. */
  compute(input: CanonicalSignalInput): SignalComputation;
}

export class SignalScoringUnavailableError extends Error {
  readonly code = 'SIGNAL_SCORING_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(detail: string) {
    super(
      `Support Signal scoring is unavailable: ${detail}. Exact scoring rules and thresholds ` +
        `remain D-011 DECISION_PENDING, and implementation must not ship invented weights or ` +
        `thresholds (SUAS-specs SUPPORT_SIGNALS.md §2).`,
    );
    this.name = 'SignalScoringUnavailableError';
  }
}

export class UnreleasedEngineError extends Error {
  readonly code = 'SIGNAL_SCORING_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(signalVersion: string) {
    super(
      `Signal version "${signalVersion}" is an unreleased fixture and is never production ` +
        `authority (SUAS-specs ENVIRONMENT.md §3; TESTING.md §12).`,
    );
    this.name = 'UnreleasedEngineError';
  }
}

export class IncompleteInputError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super(
      'This Check-In is incomplete and the signal version defines no deterministic ' +
        'missing-input behavior, so no production Support Signal is computed ' +
        '(SUAS-specs CHECKINS.md §4.1).',
    );
    this.name = 'IncompleteInputError';
  }
}

/**
 * Registered engines by signal version.
 *
 * Deliberately empty: v0.1.1 releases no scoring rules. Tests register a clearly
 * labelled unreleased fixture, which is exactly what §2 permits.
 */
const ENGINES = new Map<string, SignalEngine>();

export function registerSignalEngine(engine: SignalEngine): void {
  ENGINES.set(engine.signalVersion, engine);
}

export function clearSignalEngines(): void {
  ENGINES.clear();
}

export function findSignalEngine(signalVersion: string): SignalEngine | undefined {
  return ENGINES.get(signalVersion);
}

export function registeredSignalVersions(): string[] {
  return [...ENGINES.keys()].sort();
}

export interface ComputeOptions {
  /**
   * Allow an unreleased fixture engine to run. Only valid under
   * `SUAS_SUPPORT_SIGNAL_MODE=fixture`, and the result is never production
   * authority.
   */
  readonly allowUnreleasedFixture?: boolean;
}

/**
 * Compute a primary signal, or refuse.
 *
 * Refusal is the expected outcome today. Every path that could produce a level
 * requires a registered engine, and no released engine exists to register.
 */
export function computeSignal(
  signalVersion: string,
  input: CanonicalSignalInput,
  options: ComputeOptions = {},
): SignalComputation {
  const engine = findSignalEngine(signalVersion);
  if (engine === undefined) {
    throw new SignalScoringUnavailableError(
      `no engine is registered for signal version "${signalVersion}"`,
    );
  }

  if (!engine.released && options.allowUnreleasedFixture !== true) {
    throw new UnreleasedEngineError(signalVersion);
  }

  // CHECKINS.md §4.1: incomplete input needs deterministic missing-input
  // behavior defined by the published signal version.
  if (input.incomplete && !engine.handlesIncompleteInput) {
    throw new IncompleteInputError();
  }

  return engine.compute(input);
}
