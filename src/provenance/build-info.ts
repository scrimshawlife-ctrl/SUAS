/**
 * Build provenance surface.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §8 "Build provenance" — every build intended for
 *   shared testing exposes commit SHA, released spec version, release manifest
 *   identifier, build timestamp/version, and environment class, without secrets
 *   or veteran PII.
 * - SUAS-specs VERSIONING.md §3 (identities stay separate), §4 (machine-readable
 *   build-info object including schema/migration version).
 * - SUAS-specs HANDOFF.md §6.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { describeConfig, type SuasConfig } from '../config/index.js';
import {
  API_VERSION,
  EVENT_SCHEMA_VERSION,
  IMPLEMENTATION_STAGE,
  PRODUCTION_READINESS,
  RELEASE_MANIFEST,
  SPEC_VERSION,
  SPECS_COMMIT,
} from '../release/pins.js';

const UNKNOWN = 'unknown' as const;

export interface BuildInfo {
  /** Application version, owned by this repository. VERSIONING.md §3.2. */
  readonly app_version: string;
  /** Application commit SHA. Provenance, not a version. VERSIONING.md §2. */
  readonly app_commit: string;
  readonly build_timestamp: string;
  /** Specification stack this build implements. VERSIONING.md §3.1. */
  readonly spec_version: string;
  readonly release_manifest: string;
  readonly specs_commit: string;
  /** API version selector. VERSIONING.md §3.3; API.md §2. */
  readonly api_version: string;
  /** Event schema version. VERSIONING.md §3.4. */
  readonly event_schema_version: string;
  /** Explicit DB migration/schema version. VERSIONING.md §3.5. */
  readonly schema_version: number | null;
  readonly expected_schema_version: number;
  readonly environment: string;
  readonly implementation_stage: string;
  readonly production_readiness: string;
  /**
   * False when commit or build timestamp is unstamped. ENVIRONMENT.md §8 requires
   * these for builds intended for shared testing, so an unstamped build is visibly
   * incomplete rather than silently passing as provenanced.
   */
  readonly provenance_complete: boolean;
  /** Redacted capability/availability boundary. ENVIRONMENT.md §6, §8. */
  readonly capabilities: Record<string, string | number | boolean>;
}

export const buildInfoSchema = z.object({
  app_version: z.string(),
  app_commit: z.string(),
  build_timestamp: z.string(),
  spec_version: z.string(),
  release_manifest: z.string(),
  specs_commit: z.string(),
  api_version: z.string(),
  event_schema_version: z.string(),
  schema_version: z.number().nullable(),
  expected_schema_version: z.number(),
  environment: z.string(),
  implementation_stage: z.string(),
  production_readiness: z.string(),
  provenance_complete: z.boolean(),
  capabilities: z.record(z.union([z.string(), z.number(), z.boolean()])),
});

function readAppVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' ? version : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/**
 * Commit SHA, preferring the value stamped at build time. The git fallback is a
 * developer convenience for LOCAL working copies and is not authoritative for a
 * shared build.
 */
function readCommit(env: Record<string, string | undefined>): string {
  const stamped = env.SUAS_BUILD_COMMIT?.trim();
  if (stamped !== undefined && stamped !== '') return stamped;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return UNKNOWN;
  }
}

export interface BuildInfoInput {
  readonly config: SuasConfig;
  readonly schemaVersion: number | null;
  readonly expectedSchemaVersion: number;
  readonly env?: Record<string, string | undefined>;
}

export function buildInfo(input: BuildInfoInput): BuildInfo {
  const env = input.env ?? process.env;
  const commit = readCommit(env);
  const timestamp = env.SUAS_BUILD_TIMESTAMP?.trim();
  const buildTimestamp = timestamp === undefined || timestamp === '' ? UNKNOWN : timestamp;

  return {
    app_version: readAppVersion(),
    app_commit: commit,
    build_timestamp: buildTimestamp,
    spec_version: SPEC_VERSION,
    release_manifest: RELEASE_MANIFEST,
    specs_commit: SPECS_COMMIT,
    api_version: API_VERSION,
    event_schema_version: EVENT_SCHEMA_VERSION,
    schema_version: input.schemaVersion,
    expected_schema_version: input.expectedSchemaVersion,
    environment: input.config.environment,
    implementation_stage: IMPLEMENTATION_STAGE,
    production_readiness: PRODUCTION_READINESS,
    provenance_complete: commit !== UNKNOWN && buildTimestamp !== UNKNOWN,
    capabilities: describeConfig(input.config),
  };
}
