/**
 * The drill-run artifact.
 *
 * Spec citations:
 * - SUAS-specs RESILIENCE.md §17 ("Results/remediation are recorded")
 * - SUAS-specs RESILIENCE.md §18 (`RESILIENCE` gate)
 * - SUAS-specs SCALING.md §15 ("test artifacts record workload dimensions,
 *   environment, results, and caveats")
 * - SUAS-specs ENVIRONMENT.md §5 (LOCAL/TEST forbid real external effects)
 *
 * A report records what ran, where, and what is still missing. It deliberately
 * cannot say a gate is ready: readiness is accepted evidence recorded in
 * `STATUS.md`, never a value an implementation computes about itself.
 */

import { DRILL_IDS, requireDrill, type DrillId, type DrillResult } from './drills.js';
import {
  D_021_WORKLOAD_ENVELOPE,
  D_023_PERFORMANCE_SLOS,
  D_024_RECOVERY_OBJECTIVES,
  LOAD_PROFILES,
  planProfile,
  WORKLOAD_DIMENSIONS,
  type LoadProfile,
  type ProfilePlan,
  type WorkloadDimension,
} from './envelope.js';

export class IncompleteDrillRunError extends Error {
  readonly code = 'INCOMPLETE_DRILL_RUN';
  constructor(readonly missing: readonly DrillId[]) {
    super(
      `Drill run is missing results for: ${missing.join(', ')}. RESILIENCE.md §17 ` +
        'requires every drill to be exercised, so a partial run cannot be reported ' +
        'as a drill run.',
    );
    this.name = 'IncompleteDrillRunError';
  }
}

export class DuplicateDrillResultError extends Error {
  readonly code = 'DUPLICATE_DRILL_RESULT';
  constructor(readonly drillId: DrillId) {
    super(`Drill ${drillId} has more than one result in the same run.`);
    this.name = 'DuplicateDrillResultError';
  }
}

export interface DrillRunEnvironment {
  /** ENVIRONMENT.md environment class. Never `PRODUCTION` for a drill run. */
  readonly environmentClass: string;
  readonly databaseVersion: string;
  /** How many application instances served the run. SCALING.md §15. */
  readonly appInstances: number;
  /** True only where the run may cause real external effects. */
  readonly realExternalEffects: boolean;
}

export interface DrillReport {
  readonly environment: DrillRunEnvironment;
  /** SCALING.md §3 axes touched. Magnitudes are unreleased; see `envelopeStatus`. */
  readonly dimensionsExercised: readonly WorkloadDimension[];
  readonly profiles: readonly ProfilePlan[];
  readonly results: readonly DrillResult[];
  readonly passed: readonly DrillId[];
  readonly blocked: readonly DrillId[];
  /** Every open decision that bounds what this run could prove. */
  readonly openDecisions: readonly string[];
  readonly caveats: readonly string[];
  /**
   * Always a statement that the gates do not advance. The harness has no way
   * to express readiness, by construction.
   */
  readonly readiness: string;
}

export class ProductionDrillRunError extends Error {
  readonly code = 'PRODUCTION_DRILL_RUN';
  constructor() {
    super(
      'A drill run cannot be recorded against PRODUCTION. ENVIRONMENT.md §5 keeps ' +
        'drills on synthetic data, and SPEC-018 has not authorized production operation.',
    );
    this.name = 'ProductionDrillRunError';
  }
}

/**
 * Assemble a report, refusing an incomplete or production run.
 *
 * The completeness check is the point: §17 names thirteen drills, and a run
 * that silently covers nine of them would otherwise produce a clean-looking
 * artifact. Missing drills fail here rather than going unmentioned.
 */
export function assembleDrillReport(input: {
  readonly environment: DrillRunEnvironment;
  readonly dimensionsExercised: readonly WorkloadDimension[];
  readonly results: readonly DrillResult[];
  readonly caveats?: readonly string[];
}): DrillReport {
  if (input.environment.environmentClass === 'PRODUCTION') {
    throw new ProductionDrillRunError();
  }

  const seen = new Set<DrillId>();
  for (const result of input.results) {
    requireDrill(result.drillId);
    if (seen.has(result.drillId)) throw new DuplicateDrillResultError(result.drillId);
    seen.add(result.drillId);
  }

  const missing = DRILL_IDS.filter((id) => !seen.has(id));
  if (missing.length > 0) throw new IncompleteDrillRunError(missing);

  const passed = input.results.filter((r) => r.outcome === 'PASS').map((r) => r.drillId);
  const blocked = input.results.filter((r) => r.outcome === 'BLOCKED').map((r) => r.drillId);

  return {
    environment: input.environment,
    dimensionsExercised: input.dimensionsExercised,
    profiles: LOAD_PROFILES.map((profile: LoadProfile) => planProfile(profile)),
    results: input.results,
    passed,
    blocked,
    openDecisions: [
      `D-021 target workload envelope: ${D_021_WORKLOAD_ENVELOPE}`,
      `D-023 performance SLOs and alerts: ${D_023_PERFORMANCE_SLOS}`,
      `D-024 recovery objectives (RTO/RPO): ${D_024_RECOVERY_OBJECTIVES}`,
    ],
    caveats: [
      ...(input.caveats ?? []),
      'Correctness invariants only. No rate, latency, throughput, RTO, or RPO is ' +
        'asserted, because D-021, D-023, and D-024 are all DECISION_PENDING.',
      `Workload dimensions exercised without a released magnitude: ${WORKLOAD_DIMENSIONS.join(', ')}.`,
    ],
    readiness:
      'RESILIENCE and SCALE both remain NOT_READY. Both gates require recorded ' +
      'numeric targets (D-021, D-023, D-024), none of which are released. Readiness ' +
      'is recorded in STATUS.md on accepted evidence, never claimed by a harness run.',
  };
}
