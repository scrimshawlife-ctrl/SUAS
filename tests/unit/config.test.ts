/**
 * Configuration conformance evidence.
 *
 * Each case maps to a released invariant:
 * - SUAS-specs ENVIRONMENT.md §2 (explicit environment class)
 * - SUAS-specs ENVIRONMENT.md §3 rules 1-5 (spec/manifest match, real-effect ban)
 * - SUAS-specs ENVIRONMENT.md §5 (startup validation fails closed)
 * - SUAS-specs ENVIRONMENT.md §6 (secret classes never logged)
 * - SUAS-specs HANDOFF.md §2 (production deployment prohibited)
 */

import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  describeConfig,
  loadConfig,
  productionDataMarkersIn,
  tryLoadConfig,
} from '../../src/config/index.js';
import { validEnv } from '../helpers/env.js';

const STRONG_SECRET = 'a'.repeat(48);

function issuesFor(env: Record<string, string | undefined>): readonly string[] {
  const result = tryLoadConfig(env);
  expect(result.ok, 'expected configuration to be rejected').toBe(false);
  return result.ok ? [] : result.issues;
}

describe('valid configuration', () => {
  it('accepts a released-conformant TEST configuration', () => {
    const config = loadConfig(validEnv());
    expect(config.environment).toBe('TEST');
    expect(config.specVersion).toBe('0.1.4');
    expect(config.releaseManifest).toBe('RELEASE_MANIFEST-0.1.4.md');
    expect(config.allowRealExternalEffects).toBe(false);
    expect(config.adapters.peerSupport).toBe('manual');
    expect(config.supportSignalMode).toBe('fixture');
  });

  it('accepts STAGING when a session secret is supplied', () => {
    const config = loadConfig(
      validEnv({ SUAS_ENV: 'STAGING', SUAS_SESSION_SECRET: STRONG_SECRET }),
    );
    expect(config.environment).toBe('STAGING');
  });
});

describe('ENVIRONMENT.md §2 — environment class is explicit', () => {
  it('rejects an unknown SUAS_ENV', () => {
    const issues = issuesFor(validEnv({ SUAS_ENV: 'DEV' }));
    expect(issues.join('\n')).toContain('SUAS_ENV="DEV" is not a released value');
  });

  it('rejects a missing SUAS_ENV rather than inferring it from NODE_ENV', () => {
    const issues = issuesFor(validEnv({ SUAS_ENV: undefined, NODE_ENV: 'production' }));
    expect(issues.join('\n')).toContain('SUAS_ENV is required');
  });

  it('treats a whitespace-only value as absent', () => {
    const issues = issuesFor(validEnv({ SUAS_ENV: '   ' }));
    expect(issues.join('\n')).toContain('SUAS_ENV is required');
  });
});

describe('ENVIRONMENT.md §3 rules 1-2 — spec and manifest must match the build', () => {
  it('rejects a spec version mismatch', () => {
    const issues = issuesFor(validEnv({ SUAS_SPEC_VERSION: '0.1.0' }));
    expect(issues.join('\n')).toContain('SUAS_SPEC_VERSION must equal');
  });

  it('rejects a release manifest mismatch', () => {
    const issues = issuesFor(validEnv({ SUAS_RELEASE_MANIFEST: 'RELEASE_MANIFEST-0.1.0.md' }));
    expect(issues.join('\n')).toContain('SUAS_RELEASE_MANIFEST must identify');
  });
});

describe('ENVIRONMENT.md §3 rules 3-4 — real external effects', () => {
  it.each(['LOCAL', 'TEST', 'STAGING'])('rejects real external effects in %s', (environment) => {
    const issues = issuesFor(
      validEnv({
        SUAS_ENV: environment,
        SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'true',
        SUAS_SESSION_SECRET: STRONG_SECRET,
      }),
    );
    expect(issues.join('\n')).toContain('invalid outside PRODUCTION');
  });

  it('rejects real external effects in PRODUCTION until SPEC-018', () => {
    const issues = issuesFor(
      validEnv({
        SUAS_ENV: 'PRODUCTION',
        SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'true',
        SUAS_SESSION_SECRET: STRONG_SECRET,
      }),
    );
    expect(issues.join('\n')).toContain('not authorized until SPEC-018');
  });

  it('rejects a non-boolean value rather than coercing it', () => {
    const issues = issuesFor(validEnv({ SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'yes' }));
    expect(issues.join('\n')).toContain('must be exactly "true" or "false"');
  });
});

describe('HANDOFF.md §2 — production deployment is prohibited', () => {
  it('refuses to start in PRODUCTION even with real effects disabled', () => {
    const issues = issuesFor(
      validEnv({ SUAS_ENV: 'PRODUCTION', SUAS_SESSION_SECRET: STRONG_SECRET }),
    );
    expect(issues.join('\n')).toContain('production deployment is prohibited until SPEC-018');
  });
});

describe('ENVIRONMENT.md §5 — non-production must not point at production data', () => {
  it.each([
    ['postgresql://u:p@db.production.internal:5432/suas', 'production'],
    ['postgresql://u:p@localhost:5432/suas_prod', 'prod'],
    ['postgresql://u:p@live-db:5432/suas', 'live'],
  ])('rejects %s', (url, marker) => {
    const issues = issuesFor(validEnv({ DATABASE_URL: url }));
    expect(issues.join('\n')).toContain(`"${marker}"`);
    expect(issues.join('\n')).toContain('must not point at production data resources');
  });

  it('accepts an unmarked local database', () => {
    expect(productionDataMarkersIn('postgresql://u:p@localhost:5432/suas_local')).toEqual([]);
  });

  it('never echoes credentials from the connection string', () => {
    const issues = issuesFor(
      validEnv({ DATABASE_URL: 'postgresql://someuser:supersecret@localhost:5432/suas_prod' }),
    );
    expect(issues.join('\n')).not.toContain('supersecret');
    expect(issues.join('\n')).not.toContain('someuser');
  });
});

describe('ENVIRONMENT.md §5 — required configuration for enabled capabilities', () => {
  it('requires DATABASE_URL when migrations are validated', () => {
    const issues = issuesFor(
      validEnv({ DATABASE_URL: undefined, SUAS_MIGRATIONS_MODE: 'validate' }),
    );
    expect(issues.join('\n')).toContain('DATABASE_URL is required');
  });

  it('allows an absent DATABASE_URL when migrations are off', () => {
    const config = loadConfig(validEnv({ DATABASE_URL: undefined, SUAS_MIGRATIONS_MODE: 'off' }));
    expect(config.database.url).toBeUndefined();
  });

  it('rejects a non-postgresql scheme', () => {
    const issues = issuesFor(validEnv({ DATABASE_URL: 'mysql://u:p@localhost:3306/suas' }));
    expect(issues.join('\n')).toContain('must use a postgresql:// scheme');
  });

  it('rejects an out-of-range pool bound', () => {
    const issues = issuesFor(validEnv({ DATABASE_POOL_MAX: '5000' }));
    expect(issues.join('\n')).toContain('out of the accepted range');
  });
});

describe('SECURITY.md — provider endpoint configuration', () => {
  it('rejects cleartext non-loopback Amadeus endpoints', () => {
    const issues = issuesFor(
      validEnv({
        SUAS_AMADEUS_LODGING_TOKEN_URL: 'http://metadata.internal/token',
        SUAS_AMADEUS_LODGING_API_BASE_URL: 'http://example.test',
      }),
    );
    expect(issues.join('\n')).toContain('must use HTTPS');
  });

  it('rejects URL-embedded credentials', () => {
    const issues = issuesFor(
      validEnv({ SUAS_AMADEUS_LODGING_TOKEN_URL: 'https://user:password@auth.example/token' }),
    );
    expect(issues.join('\n')).toContain('must not contain URL-embedded credentials');
    expect(issues.join('\n')).not.toContain('password');
  });

  it('allows loopback HTTP only in LOCAL or TEST', () => {
    expect(() =>
      loadConfig(
        validEnv({
          SUAS_AMADEUS_LODGING_TOKEN_URL: 'http://127.0.0.1:4010/token',
          SUAS_AMADEUS_LODGING_API_BASE_URL: 'http://localhost:4010',
        }),
      ),
    ).not.toThrow();
  });
});

describe('ENVIRONMENT.md §3 — unavailable vendor surfaces stay unavailable', () => {
  it('rejects a real fulfillment adapter and cites the owning decisions', () => {
    const issues = issuesFor(validEnv({ SUAS_TRANSPORTATION_ADAPTER_MODE: 'uber' }));
    expect(issues.join('\n')).toContain('D-017–D-020');
  });

  it.each([
    ['SUAS_EMAIL_MODE', 'sendgrid'],
    ['SUAS_SMS_MODE', 'twilio'],
  ])('rejects a production communications vendor in %s', (varName, value) => {
    const issues = issuesFor(validEnv({ [varName]: value }));
    expect(issues.join('\n')).toContain(`${varName}="${value}" is not a released value`);
  });

  it('rejects production Support Signal scoring and cites D-011', () => {
    const issues = issuesFor(validEnv({ SUAS_SUPPORT_SIGNAL_MODE: 'production' }));
    expect(issues.join('\n')).toContain('D-011');
  });

  it('rejects official safety copy and cites D-012', () => {
    const issues = issuesFor(validEnv({ SUAS_SAFETY_COPY_MODE: 'official' }));
    expect(issues.join('\n')).toContain('D-012');
  });

  it('rejects enabling sensitive aggregate reporting and cites D-025', () => {
    const issues = issuesFor(validEnv({ SUAS_SENSITIVE_AGGREGATE_REPORTING: 'enabled' }));
    expect(issues.join('\n')).toContain('D-025');
  });
});

describe('ENVIRONMENT.md §6 — secret handling', () => {
  it('rejects weak session secret material', () => {
    const issues = issuesFor(validEnv({ SUAS_SESSION_SECRET: 'short' }));
    expect(issues.join('\n')).toContain('at least 32 characters');
  });

  it.each(['LOCAL', 'TEST', 'STAGING'])(
    'requires a session secret in %s, because authentication is an enabled capability',
    (environment) => {
      const issues = issuesFor(validEnv({ SUAS_ENV: environment, SUAS_SESSION_SECRET: undefined }));
      expect(issues.join('\n')).toContain(`SUAS_SESSION_SECRET is required in ${environment}`);
    },
  );

  it('never includes secret values in the redacted description', () => {
    const config = loadConfig(validEnv({ SUAS_SESSION_SECRET: STRONG_SECRET }));
    const described = JSON.stringify(describeConfig(config));
    expect(described).not.toContain(STRONG_SECRET);
    expect(described).not.toContain('suas:suas');
    expect(described).toContain('session_secret_configured');
  });
});

describe('fail-closed reporting', () => {
  it('reports every violated invariant together, not just the first', () => {
    const issues = issuesFor(
      validEnv({
        SUAS_SPEC_VERSION: '0.0.9',
        SUAS_RELEASE_MANIFEST: 'wrong.md',
        SUAS_EMAIL_MODE: 'mailgun',
      }),
    );
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('throws ConfigurationError from loadConfig', () => {
    expect(() => loadConfig(validEnv({ SUAS_ENV: 'NOPE' }))).toThrow(ConfigurationError);
  });
});
