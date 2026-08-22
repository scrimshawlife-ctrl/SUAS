/**
 * Build provenance evidence.
 *
 * SUAS-specs ENVIRONMENT.md §8; VERSIONING.md §3-§4; HANDOFF.md §6.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { buildInfo, buildInfoSchema } from '../../src/provenance/build-info.js';
import {
  API_VERSION,
  EVENT_SCHEMA_VERSION,
  RELEASE_MANIFEST,
  SPEC_VERSION,
} from '../../src/release/pins.js';
import { validEnv } from '../helpers/env.js';

function info(env: Record<string, string | undefined> = {}) {
  const source = validEnv(env);
  return buildInfo({
    config: loadConfig(source),
    schemaVersion: 1,
    expectedSchemaVersion: 1,
    env: source,
  });
}

describe('ENVIRONMENT.md §8 — required provenance fields', () => {
  it('exposes commit, spec version, manifest, timestamp, and environment class', () => {
    const result = info({
      SUAS_BUILD_COMMIT: 'abc1234',
      SUAS_BUILD_TIMESTAMP: '2026-08-18T12:00:00Z',
    });
    expect(result.app_commit).toBe('abc1234');
    expect(result.spec_version).toBe(SPEC_VERSION);
    expect(result.release_manifest).toBe(RELEASE_MANIFEST);
    expect(result.build_timestamp).toBe('2026-08-18T12:00:00Z');
    expect(result.environment).toBe('TEST');
    expect(result.provenance_complete).toBe(true);
    expect(() => buildInfoSchema.parse(result)).not.toThrow();
  });

  it('marks an unstamped build as incomplete provenance', () => {
    const result = info({ SUAS_BUILD_COMMIT: 'abc1234', SUAS_BUILD_TIMESTAMP: undefined });
    expect(result.build_timestamp).toBe('unknown');
    expect(result.provenance_complete).toBe(false);
  });
});

describe('VERSIONING.md §3 — version identities stay separate', () => {
  it('reports spec, API, event schema, app, and schema versions independently', () => {
    const result = info();
    expect(result.spec_version).toBe('0.1.5');
    expect(result.api_version).toBe(API_VERSION);
    expect(result.event_schema_version).toBe(EVENT_SCHEMA_VERSION);
    expect(result.schema_version).toBe(1);
    // The application version is repository-owned and must not be the spec version.
    expect(result.app_version).not.toBe(result.spec_version);
  });

  it('reports the release boundary rather than implying readiness', () => {
    const result = info();
    expect(result.implementation_stage).toBe('SPEC-017');
    expect(result.production_readiness).toBe('NOT_READY');
  });
});

describe('ENVIRONMENT.md §6, §8 — no secrets in provenance', () => {
  it('omits secret values while reporting the availability boundary', () => {
    const serialized = JSON.stringify(
      info({ SUAS_SESSION_SECRET: 'z'.repeat(48), SUAS_BUILD_COMMIT: 'abc1234' }),
    );
    expect(serialized).not.toContain('z'.repeat(48));
    expect(serialized).not.toContain('suas:suas');
    expect(serialized).toContain('"support_signal_mode":"fixture"');
    expect(serialized).toContain('"sensitive_aggregate_reporting":"disabled"');
  });
});
