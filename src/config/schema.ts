/**
 * Typed configuration contract.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §2 (canonical environments)
 * - SUAS-specs ENVIRONMENT.md §3 (canonical configuration variables)
 * - SUAS-specs ENVIRONMENT.md §4 (configuration precedence)
 * - SUAS-specs ENVIRONMENT.md §5 (startup validation, fail closed)
 * - SUAS-specs ENVIRONMENT.md §6 (secret classes)
 * - SUAS-specs HANDOFF.md §7 (environment contract)
 *
 * Configuration may select an implementation mechanism. It may not redefine
 * released product/domain semantics, and it may not enable a surface the
 * release manifest marks UNAVAILABLE or FUTURE (ENVIRONMENT.md §4).
 */

import { z } from 'zod';
import { RELEASE_MANIFEST, SPEC_018_PRODUCTION_AUTHORIZED, SPEC_VERSION } from '../release/pins.js';

/** ENVIRONMENT.md §2. Exactly these logical environment classes exist. */
export const ENVIRONMENT_CLASSES = ['LOCAL', 'TEST', 'STAGING', 'PRODUCTION'] as const;
export type EnvironmentClass = (typeof ENVIRONMENT_CLASSES)[number];

/** ENVIRONMENT.md §3 "Data / persistence". */
export const MIGRATIONS_MODES = ['off', 'validate', 'apply'] as const;
export type MigrationsMode = (typeof MIGRATIONS_MODES)[number];

/** ENVIRONMENT.md §3 "Notifications". Production external modes are not valid in v0.1.1. */
export const COMMUNICATION_MODES = ['disabled', 'fake', 'sink'] as const;
export type CommunicationMode = (typeof COMMUNICATION_MODES)[number];

/** ENVIRONMENT.md §3 "Fulfillment adapters". Real adapter modes require D-017–D-020. */
export const ADAPTER_MODES = ['manual', 'fake', 'disabled'] as const;
export type AdapterMode = (typeof ADAPTER_MODES)[number];

/** ENVIRONMENT.md §3 "Support Signal / safety / reporting". */
export const SUPPORT_SIGNAL_MODES = ['disabled', 'fixture'] as const;
export type SupportSignalMode = (typeof SUPPORT_SIGNAL_MODES)[number];

export const SAFETY_COPY_MODES = ['placeholder_test_only', 'disabled'] as const;
export type SafetyCopyMode = (typeof SAFETY_COPY_MODES)[number];

export const SENSITIVE_AGGREGATE_REPORTING_MODES = ['disabled'] as const;
export type SensitiveAggregateReporting = (typeof SENSITIVE_AGGREGATE_REPORTING_MODES)[number];

/**
 * Environment classes that must never reach real veteran data or real external
 * side effects. ENVIRONMENT.md §2 table; HANDOFF.md §7.
 */
export const SYNTHETIC_ONLY_ENVIRONMENTS: readonly EnvironmentClass[] = [
  'LOCAL',
  'TEST',
  'STAGING',
];

/**
 * Substrings that mark a connection target as a probable production data resource.
 *
 * ENVIRONMENT.md §5 requires startup to fail closed when LOCAL/TEST/STAGING points
 * at known production data resources. The released contract does not name a
 * detection mechanism, so this deny-list is an implementation-owned guard: it is a
 * safety net, not an authority. Environment class itself is always explicit and is
 * never inferred from a database name (ENVIRONMENT.md §2).
 */
export const PRODUCTION_DATA_MARKERS = ['prod', 'production', 'live'] as const;

const MIN_SESSION_SECRET_LENGTH = 32;

/** Treat an unset or whitespace-only variable as absent so it fails closed as "required". */
const optionalRaw = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, z.string().optional());

function requiredEnum<const T extends readonly string[]>(
  varName: string,
  allowed: T,
  guidance: string,
): z.ZodType<T[number], z.ZodTypeDef, unknown> {
  return optionalRaw.superRefine((value, ctx) => {
    if (value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${varName} is required and must be one of ${allowed.join(' | ')}. ${guidance}`,
      });
      return;
    }
    if (!allowed.includes(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${varName}="${value}" is not a released value. Allowed: ${allowed.join(' | ')}. ${guidance}`,
      });
    }
  }) as unknown as z.ZodType<T[number], z.ZodTypeDef, unknown>;
}

/** ENVIRONMENT.md §5: fail closed on invalid/unknown values, including booleans. */
function strictBoolean(
  varName: string,
  guidance: string,
): z.ZodType<boolean, z.ZodTypeDef, unknown> {
  return optionalRaw
    .superRefine((value, ctx) => {
      if (value === undefined || (value !== 'true' && value !== 'false')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${varName} is required and must be exactly "true" or "false". ${guidance}`,
        });
      }
    })
    .transform((value) => value === 'true');
}

const rawConfigSchema = z.object({
  // --- Required in every environment. ENVIRONMENT.md §3. ---
  SUAS_ENV: requiredEnum(
    'SUAS_ENV',
    ENVIRONMENT_CLASSES,
    'ENVIRONMENT.md §2: environment class is explicit and is never inferred from hostname, branch name, NODE_ENV, cloud account, or database name.',
  ),
  SUAS_SPEC_VERSION: optionalRaw,
  SUAS_RELEASE_MANIFEST: optionalRaw,
  SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: strictBoolean(
    'SUAS_ALLOW_REAL_EXTERNAL_EFFECTS',
    'ENVIRONMENT.md §3 rules 3-4.',
  ),

  // --- Data / persistence. ENVIRONMENT.md §3. ---
  DATABASE_URL: optionalRaw,
  DATABASE_POOL_MAX: optionalRaw,
  SUAS_MIGRATIONS_MODE: requiredEnum(
    'SUAS_MIGRATIONS_MODE',
    MIGRATIONS_MODES,
    'ENVIRONMENT.md §3 "Data / persistence"; production automatic-migration policy must be explicit in deployment runbooks.',
  ),

  // --- Auth / sessions. ENVIRONMENT.md §3, §6. ---
  SUAS_SESSION_SECRET: optionalRaw,

  // --- Notifications. ENVIRONMENT.md §3. ---
  SUAS_EMAIL_MODE: requiredEnum(
    'SUAS_EMAIL_MODE',
    COMMUNICATION_MODES,
    'Production external email is not valid in v0.1.1; the email provider decision has not closed.',
  ),
  SUAS_SMS_MODE: requiredEnum(
    'SUAS_SMS_MODE',
    COMMUNICATION_MODES,
    'Production external SMS is not valid in v0.1.1; the SMS provider decision has not closed.',
  ),

  // --- Fulfillment adapters. ENVIRONMENT.md §3. ---
  SUAS_TRANSPORTATION_ADAPTER_MODE: requiredEnum(
    'SUAS_TRANSPORTATION_ADAPTER_MODE',
    ADAPTER_MODES,
    'A real adapter mode requires the corresponding D-017–D-020 decision and a released manifest update.',
  ),
  SUAS_SHELTER_ADAPTER_MODE: requiredEnum(
    'SUAS_SHELTER_ADAPTER_MODE',
    ADAPTER_MODES,
    'A real adapter mode requires the corresponding D-017–D-020 decision and a released manifest update.',
  ),
  SUAS_FOOD_ADAPTER_MODE: requiredEnum(
    'SUAS_FOOD_ADAPTER_MODE',
    ADAPTER_MODES,
    'A real adapter mode requires the corresponding D-017–D-020 decision and a released manifest update.',
  ),
  SUAS_PEER_SUPPORT_ADAPTER_MODE: requiredEnum(
    'SUAS_PEER_SUPPORT_ADAPTER_MODE',
    ADAPTER_MODES,
    'A real adapter mode requires the corresponding D-017–D-020 decision and a released manifest update.',
  ),

  // --- Support Signal / safety / reporting. ENVIRONMENT.md §3, §5. ---
  SUAS_SUPPORT_SIGNAL_MODE: requiredEnum(
    'SUAS_SUPPORT_SIGNAL_MODE',
    SUPPORT_SIGNAL_MODES,
    'Production Support Signal scoring is unavailable while D-011 is unresolved; "fixture" is never production authority.',
  ),
  SUAS_SAFETY_COPY_MODE: requiredEnum(
    'SUAS_SAFETY_COPY_MODE',
    SAFETY_COPY_MODES,
    'Official safety/crisis copy is unavailable while D-012 is unresolved; "placeholder_test_only" is never production authority.',
  ),
  SUAS_SENSITIVE_AGGREGATE_REPORTING: requiredEnum(
    'SUAS_SENSITIVE_AGGREGATE_REPORTING',
    SENSITIVE_AGGREGATE_REPORTING_MODES,
    'Sensitive aggregate reporting stays disabled while D-025 is unresolved for that surface.',
  ),

  // --- Implementation-owned mechanism (not released product semantics). ---
  SUAS_HTTP_PORT: optionalRaw,
  SUAS_HTTP_HOST: optionalRaw,
  SUAS_LOG_LEVEL: optionalRaw,
});

/** Log levels. Implementation mechanism; ENVIRONMENT.md §6 governs what may be logged. */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Every configuration variable this build reads.
 * ENVIRONMENT.md §7 requires `.env.example` to carry the names with safe
 * placeholders; the repository-hygiene test asserts the two stay in step.
 */
export const CONFIG_VARIABLE_NAMES: readonly string[] = Object.keys(rawConfigSchema.shape);

export interface SuasConfig {
  readonly environment: EnvironmentClass;
  readonly specVersion: string;
  readonly releaseManifest: string;
  readonly allowRealExternalEffects: boolean;
  readonly database: {
    readonly url: string | undefined;
    readonly poolMax: number;
    readonly migrationsMode: MigrationsMode;
  };
  readonly sessionSecret: string | undefined;
  readonly notifications: {
    readonly email: CommunicationMode;
    readonly sms: CommunicationMode;
  };
  readonly adapters: {
    readonly transportation: AdapterMode;
    readonly shelter: AdapterMode;
    readonly food: AdapterMode;
    readonly peerSupport: AdapterMode;
  };
  readonly supportSignalMode: SupportSignalMode;
  readonly safetyCopyMode: SafetyCopyMode;
  readonly sensitiveAggregateReporting: SensitiveAggregateReporting;
  readonly http: {
    readonly host: string;
    readonly port: number;
  };
  readonly logLevel: LogLevel;
}

function parsePositiveInt(
  varName: string,
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
  ctx: z.RefinementCtx,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${varName}="${raw}" must be a positive integer.`,
    });
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (value < bounds.min || value > bounds.max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${varName}=${value} is out of the accepted range ${bounds.min}-${bounds.max}.`,
    });
    return fallback;
  }
  return value;
}

/**
 * Returns the production-data markers matched by a connection string, if any.
 * Only the host and database-name components are inspected; credentials are
 * never read or logged (ENVIRONMENT.md §6).
 */
export function productionDataMarkersIn(databaseUrl: string): string[] {
  let host = '';
  let databaseName = '';
  try {
    const parsed = new URL(databaseUrl);
    host = parsed.hostname.toLowerCase();
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  } catch {
    // Unparseable connection strings are reported by the DATABASE_URL check itself.
    return [];
  }
  const haystack = `${host} ${databaseName}`;
  const tokens = haystack.split(/[^a-z0-9]+/).filter(Boolean);
  return PRODUCTION_DATA_MARKERS.filter((marker) => tokens.includes(marker));
}

/**
 * Full configuration schema including the ENVIRONMENT.md §5 cross-field
 * startup-validation invariants. Every failure here is fail-closed by design.
 */
export const configSchema = rawConfigSchema.superRefine((raw, ctx) => {
  const environment = raw.SUAS_ENV;

  // ENVIRONMENT.md §3 rule 1 / §5 "spec version ... mismatch".
  if (raw.SUAS_SPEC_VERSION !== SPEC_VERSION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `SUAS_SPEC_VERSION must equal the released spec version this build pins ` +
        `("${SPEC_VERSION}"), received ${raw.SUAS_SPEC_VERSION === undefined ? '<unset>' : `"${raw.SUAS_SPEC_VERSION}"`}. ` +
        `ENVIRONMENT.md §3 rule 1.`,
    });
  }

  // ENVIRONMENT.md §3 rule 2 / §5 "release manifest ... mismatch".
  if (raw.SUAS_RELEASE_MANIFEST !== RELEASE_MANIFEST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `SUAS_RELEASE_MANIFEST must identify the manifest this build claims ` +
        `("${RELEASE_MANIFEST}"), received ${raw.SUAS_RELEASE_MANIFEST === undefined ? '<unset>' : `"${raw.SUAS_RELEASE_MANIFEST}"`}. ` +
        `ENVIRONMENT.md §3 rule 2.`,
    });
  }

  // ENVIRONMENT.md §3 rules 3-4 / §5 "real external effects enabled outside an
  // authorized production release". Rule 4 keeps this invalid even in PRODUCTION
  // until SPEC-018 makes production operation ready.
  if (raw.SUAS_ALLOW_REAL_EXTERNAL_EFFECTS) {
    const reason =
      environment === 'PRODUCTION'
        ? `production operation is not authorized until SPEC-018 (ENVIRONMENT.md §3 rule 4)`
        : `real external effects are invalid outside PRODUCTION (ENVIRONMENT.md §3 rule 3)`;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=true is rejected in ${environment}: ${reason}.`,
    });
  }

  // HANDOFF.md §2 "Production deployment: prohibited";
  // RELEASE_MANIFEST-0.1.1.md "Readiness boundary".
  if (environment === 'PRODUCTION' && !SPEC_018_PRODUCTION_AUTHORIZED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'SUAS_ENV=PRODUCTION is rejected: production deployment is prohibited until SPEC-018 ' +
        'records launch-readiness evidence (HANDOFF.md §2; RELEASE_MANIFEST-0.1.1.md "Readiness boundary").',
    });
  }

  // ENVIRONMENT.md §5 "required secrets are absent for an enabled capability".
  // Persistence is the only capability enabled in Slice 1; later slices extend this.
  const persistenceEnabled = raw.SUAS_MIGRATIONS_MODE !== 'off';
  if (persistenceEnabled && raw.DATABASE_URL === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'DATABASE_URL is required when SUAS_MIGRATIONS_MODE is "validate" or "apply" ' +
        '(ENVIRONMENT.md §3 "Data / persistence", §5 required-secrets rule).',
    });
  }

  if (raw.DATABASE_URL !== undefined) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(raw.DATABASE_URL);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL is not a parseable connection URL.',
      });
    }
    if (parsed !== undefined && !['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `DATABASE_URL must use a postgresql:// scheme; PostgreSQL is the logical system of ` +
          `record (ARCHITECTURE.md §3 invariant 2). Received scheme "${parsed.protocol}".`,
      });
    }

    // ENVIRONMENT.md §5 "LOCAL/TEST/STAGING points at known production data resources";
    // §3 "No application startup may silently point LOCAL/TEST/STAGING at a production database."
    if (SYNTHETIC_ONLY_ENVIRONMENTS.includes(environment)) {
      const markers = productionDataMarkersIn(raw.DATABASE_URL);
      if (markers.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `DATABASE_URL host/database name contains production marker(s) ${markers.map((m) => `"${m}"`).join(', ')} ` +
            `while SUAS_ENV=${environment}. LOCAL/TEST/STAGING must not point at production data resources ` +
            `(ENVIRONMENT.md §3 "Data / persistence", §5).`,
        });
      }
    }
  }

  // ENVIRONMENT.md §6: session secrets are a secret class. Reject weak material
  // wherever one is supplied; require one where sessions are operationally shared.
  if (raw.SUAS_SESSION_SECRET !== undefined) {
    if (raw.SUAS_SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `SUAS_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters ` +
          `(ENVIRONMENT.md §6 secret classes).`,
      });
    }
  } else if (environment === 'STAGING' || environment === 'PRODUCTION') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `SUAS_SESSION_SECRET is required in ${environment}; it must come from environment or ` +
        `platform secret storage, never a committed file (ENVIRONMENT.md §3 "Auth / sessions", §6).`,
    });
  }
});

/** Shape the validated raw record into the application configuration object. */
export function shapeConfig(
  raw: z.infer<typeof rawConfigSchema>,
  ctx: z.RefinementCtx,
): SuasConfig {
  return {
    environment: raw.SUAS_ENV,
    specVersion: SPEC_VERSION,
    releaseManifest: RELEASE_MANIFEST,
    allowRealExternalEffects: raw.SUAS_ALLOW_REAL_EXTERNAL_EFFECTS,
    database: {
      url: raw.DATABASE_URL,
      // ENVIRONMENT.md §3: the pool must be bounded. The exact production value
      // remains release/operations evidence, so no production default is invented.
      poolMax: parsePositiveInt(
        'DATABASE_POOL_MAX',
        raw.DATABASE_POOL_MAX,
        5,
        { min: 1, max: 100 },
        ctx,
      ),
      migrationsMode: raw.SUAS_MIGRATIONS_MODE,
    },
    sessionSecret: raw.SUAS_SESSION_SECRET,
    notifications: {
      email: raw.SUAS_EMAIL_MODE,
      sms: raw.SUAS_SMS_MODE,
    },
    adapters: {
      transportation: raw.SUAS_TRANSPORTATION_ADAPTER_MODE,
      shelter: raw.SUAS_SHELTER_ADAPTER_MODE,
      food: raw.SUAS_FOOD_ADAPTER_MODE,
      peerSupport: raw.SUAS_PEER_SUPPORT_ADAPTER_MODE,
    },
    supportSignalMode: raw.SUAS_SUPPORT_SIGNAL_MODE,
    safetyCopyMode: raw.SUAS_SAFETY_COPY_MODE,
    sensitiveAggregateReporting: raw.SUAS_SENSITIVE_AGGREGATE_REPORTING,
    http: {
      host: raw.SUAS_HTTP_HOST ?? '127.0.0.1',
      port: parsePositiveInt(
        'SUAS_HTTP_PORT',
        raw.SUAS_HTTP_PORT,
        3000,
        { min: 0, max: 65535 },
        ctx,
      ),
    },
    logLevel: resolveLogLevel(raw.SUAS_LOG_LEVEL, raw.SUAS_ENV, ctx),
  };
}

function resolveLogLevel(
  raw: string | undefined,
  environment: EnvironmentClass,
  ctx: z.RefinementCtx,
): LogLevel {
  const fallback: LogLevel = environment === 'TEST' ? 'silent' : 'info';
  if (raw === undefined) return fallback;
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `SUAS_LOG_LEVEL="${raw}" is invalid. Allowed: ${LOG_LEVELS.join(' | ')}.`,
    });
    return fallback;
  }
  return raw as LogLevel;
}

export const suasConfigSchema = configSchema.transform(shapeConfig);
