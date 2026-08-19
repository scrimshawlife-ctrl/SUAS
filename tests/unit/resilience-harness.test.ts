/**
 * Drill-harness contract evidence.
 *
 * SUAS-specs RESILIENCE.md §17 (thirteen drills; results recorded), §18 gate,
 * §19 non-goals; SCALING.md §13 load profiles, §15 gate, §16 non-goals;
 * DECISIONS.md D-021, D-023, D-024.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assembleDrillReport,
  assertPerformanceSloReleased,
  assertRecoveryObjectivesReleased,
  assertWorkloadEnvelopeReleased,
  D_021_WORKLOAD_ENVELOPE,
  D_023_PERFORMANCE_SLOS,
  D_024_RECOVERY_OBJECTIVES,
  DRILL_IDS,
  DrillEvidenceRequiredError,
  DuplicateDrillResultError,
  IncompleteDrillRunError,
  LOAD_PROFILES,
  NumericTargetUnavailableError,
  planProfile,
  ProductionDrillRunError,
  recordDrillResult,
  requireDrill,
  UnknownDrillError,
  type DrillId,
  type DrillResult,
} from '../../src/resilience/index.js';

const ENVIRONMENT = {
  environmentClass: 'TEST',
  databaseVersion: 'PostgreSQL 17',
  appInstances: 2,
  realExternalEffects: false,
};

function passing(drillId: DrillId): DrillResult {
  return { drillId, outcome: 'PASS', evidence: 'observed', caveats: [] };
}

function fullRun(): DrillResult[] {
  return DRILL_IDS.map((id) => passing(id));
}

describe('RESILIENCE.md §17 — the drill list is released, not invented', () => {
  it('carries all thirteen drills', () => {
    expect(DRILL_IDS).toHaveLength(13);
  });

  it('refuses a drill that is not in the released list', () => {
    expect(() => requireDrill('CHAOS_MONKEY')).toThrow(UnknownDrillError);
  });

  it('requires evidence on every recorded result', () => {
    expect(() =>
      recordDrillResult({
        drillId: 'QUEUE_BACKLOG_BURST',
        outcome: 'PASS',
        evidence: '  ',
        caveats: [],
      }),
    ).toThrow(DrillEvidenceRequiredError);
  });

  it('requires a stated reason when a drill is blocked', () => {
    expect(() =>
      recordDrillResult({
        drillId: 'RESTORE_REHEARSAL_WITH_PENDING_ATTEMPTS',
        outcome: 'BLOCKED',
        evidence: 'not executed',
        caveats: [],
      }),
    ).toThrow(DrillEvidenceRequiredError);
  });

  it('accepts a blocked result that names what is missing', () => {
    const result = recordDrillResult({
      drillId: 'RESTORE_REHEARSAL_WITH_PENDING_ATTEMPTS',
      outcome: 'BLOCKED',
      evidence: 'not executed',
      blockedReason: 'D-024 is DECISION_PENDING and no restore procedure is released',
      caveats: [],
    });
    expect(result.outcome).toBe('BLOCKED');
  });
});

describe('A partial run cannot be reported as a drill run', () => {
  it('refuses a report that is missing drills', () => {
    const results = fullRun().slice(0, 9);
    expect(() =>
      assembleDrillReport({ environment: ENVIRONMENT, dimensionsExercised: [], results }),
    ).toThrow(IncompleteDrillRunError);
  });

  it('names exactly which drills were missing', () => {
    const results = fullRun().filter((result) => result.drillId !== 'QUEUE_BACKLOG_BURST');
    try {
      assembleDrillReport({ environment: ENVIRONMENT, dimensionsExercised: [], results });
      expect.unreachable('expected an incomplete-run failure');
    } catch (error) {
      expect((error as IncompleteDrillRunError).missing).toEqual(['QUEUE_BACKLOG_BURST']);
    }
  });

  it('refuses a duplicate result for the same drill', () => {
    const results = [...fullRun(), passing('QUEUE_BACKLOG_BURST')];
    expect(() =>
      assembleDrillReport({ environment: ENVIRONMENT, dimensionsExercised: [], results }),
    ).toThrow(DuplicateDrillResultError);
  });

  it('refuses to record a run against PRODUCTION', () => {
    expect(() =>
      assembleDrillReport({
        environment: { ...ENVIRONMENT, environmentClass: 'PRODUCTION' },
        dimensionsExercised: [],
        results: fullRun(),
      }),
    ).toThrow(ProductionDrillRunError);
  });
});

describe('SCALING.md §13/§16 and RESILIENCE.md §19 — no numeric target is invented', () => {
  it('records all three owning decisions as pending', () => {
    expect(D_021_WORKLOAD_ENVELOPE).toBe('DECISION_PENDING');
    expect(D_023_PERFORMANCE_SLOS).toBe('DECISION_PENDING');
    expect(D_024_RECOVERY_OBJECTIVES).toBe('DECISION_PENDING');
  });

  it('refuses a load rate, a latency target, and a recovery objective', () => {
    expect(() => assertWorkloadEnvelopeReleased('A burst rate')).toThrow(
      NumericTargetUnavailableError,
    );
    expect(() => assertPerformanceSloReleased('A p99 latency target')).toThrow(
      NumericTargetUnavailableError,
    );
    expect(() => assertRecoveryObjectivesReleased('An RTO')).toThrow(NumericTargetUnavailableError);
  });

  it('marks the three volume-defined profiles as not executable without an envelope', () => {
    for (const profile of ['STEADY_STATE', 'BURST', 'DEGRADED_DEPENDENCY'] as const) {
      expect(planProfile(profile).executable, profile).toBe(false);
    }
  });

  it('marks the concurrency profile executable, since it is defined by contention', () => {
    expect(planProfile('CONCURRENCY_CORRECTNESS').executable).toBe(true);
  });

  it('plans every §13 profile with its envelope status stated', () => {
    for (const profile of LOAD_PROFILES) {
      expect(planProfile(profile).envelopeStatus, profile).toContain('D-021');
    }
  });

  it('ships no numeric rate, latency, or recovery constant', () => {
    // A number invented here would read as a released target.
    const source = readFileSync(
      new URL('../../src/resilience/envelope.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/\b\d+\s*(rps|qps|ms|seconds|minutes|hours)\b/i);
    expect(source).not.toMatch(/\b(rto|rpo)\s*[:=]\s*\d/i);
  });
});

describe('A report cannot claim readiness', () => {
  const report = assembleDrillReport({
    environment: ENVIRONMENT,
    dimensionsExercised: ['SUPPORT_REQUEST_RATE'],
    results: fullRun(),
  });

  it('states both gates remain NOT_READY even when every drill passed', () => {
    expect(report.passed).toHaveLength(13);
    expect(report.blocked).toEqual([]);
    expect(report.readiness).toContain('NOT_READY');
  });

  it('lists every open decision that bounds the run', () => {
    expect(report.openDecisions.join(' ')).toContain('D-021');
    expect(report.openDecisions.join(' ')).toContain('D-023');
    expect(report.openDecisions.join(' ')).toContain('D-024');
  });

  it('carries the caveat that only correctness was proven', () => {
    expect(report.caveats.join(' ')).toContain('Correctness invariants only');
  });
});
