/**
 * Fail-closed configuration loading.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §5 "Startup validation" — validation runs in tests
 *   and at runtime startup, and fails closed.
 * - SUAS-specs ENVIRONMENT.md §6 "Secret classes" — secret values are never
 *   written to logs or error output.
 */

import type { ZodError } from 'zod';
import { suasConfigSchema, type SuasConfig } from './schema.js';

/** Raised when configuration is invalid. Startup must not continue past this. */
export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `SUAS configuration is invalid; startup refused (SUAS-specs ENVIRONMENT.md §5).\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export type ConfigSource = Record<string, string | undefined>;

/**
 * Validate a configuration source and return the typed configuration object.
 * Throws {@link ConfigurationError} listing every violated invariant.
 */
export function loadConfig(source: ConfigSource): SuasConfig {
  const result = suasConfigSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigurationError(formatIssues(result.error));
  }
  return result.data;
}

/** Non-throwing variant, for surfaces that need to report rather than crash. */
export function tryLoadConfig(
  source: ConfigSource,
): { ok: true; config: SuasConfig } | { ok: false; issues: readonly string[] } {
  const result = suasConfigSchema.safeParse(source);
  return result.success
    ? { ok: true, config: result.data }
    : { ok: false, issues: formatIssues(result.error) };
}

function formatIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}

/**
 * Redacted configuration summary safe for logs, build-info surfaces, and
 * screenshots. ENVIRONMENT.md §6 forbids writing secret values anywhere; §8
 * allows showing provenance without secrets or veteran PII.
 */
export function describeConfig(config: SuasConfig): Record<string, string | number | boolean> {
  return {
    environment: config.environment,
    spec_version: config.specVersion,
    release_manifest: config.releaseManifest,
    allow_real_external_effects: config.allowRealExternalEffects,
    database_configured: config.database.url !== undefined,
    database_pool_max: config.database.poolMax,
    migrations_mode: config.database.migrationsMode,
    session_secret_configured: config.sessionSecret !== undefined,
    email_mode: config.notifications.email,
    sms_mode: config.notifications.sms,
    transportation_adapter_mode: config.adapters.transportation,
    shelter_adapter_mode: config.adapters.shelter,
    food_adapter_mode: config.adapters.food,
    peer_support_adapter_mode: config.adapters.peerSupport,
    support_signal_mode: config.supportSignalMode,
    safety_copy_mode: config.safetyCopyMode,
    sensitive_aggregate_reporting: config.sensitiveAggregateReporting,
  };
}
