/**
 * Multi-factor authentication port.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §4 — responders, org admins, and SUAS admins "complete MFA
 *   before privileged session elevation"; the factor type is "selected later; no
 *   vendor lock in the domain contract".
 * - SUAS-specs SECURITY.md §2 — MFA required for Responder, Org-admin,
 *   SUAS-admin.
 * - SUAS-specs ENVIRONMENT.md §2 — LOCAL/TEST/STAGING forbid real external
 *   effects; STAGING exercises fake adapters and failure drills.
 *
 * No factor vendor is selected here. The port is the contract; the only
 * implementation is a test factor that produces no external effect.
 */

import type { EnvironmentClass, SuasConfig } from '../config/index.js';

export type MfaFactorType = 'TEST_FACTOR';

export class MfaRequiredError extends Error {
  readonly code = 'MFA_REQUIRED';
  readonly httpStatus = 403;

  constructor(action: string) {
    super(`${action} requires an MFA-elevated session (SUAS-specs AUTH.md §4; SECURITY.md §2).`);
    this.name = 'MfaRequiredError';
  }
}

export class MfaUnavailableError extends Error {
  readonly code = 'MFA_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(environment: EnvironmentClass) {
    super(
      `No MFA factor is available for ${environment}. The MVP factor type is selected by a ` +
        `later released decision (SUAS-specs AUTH.md §4), and a test factor must never carry ` +
        `production elevation.`,
    );
    this.name = 'MfaUnavailableError';
  }
}

export interface MfaChallenge {
  readonly challengeId: string;
  readonly factorType: MfaFactorType;
}

export interface MfaPort {
  readonly factorType: MfaFactorType;
  readonly implementation: string;
  /** Begin a factor challenge for a user. */
  begin(userId: string): Promise<MfaChallenge>;
  /** Verify a factor response. A true result authorizes elevation, nothing more. */
  verify(challengeId: string, response: string): Promise<boolean>;
}

/**
 * Deterministic test factor for the synthetic environment classes.
 *
 * It proves the elevation boundary — that privileged work is refused until a
 * factor is verified — without standing in for a real second factor. The code is
 * returned by `begin` because there is no channel to deliver it on; that is only
 * acceptable because these environments forbid real users.
 */
export class TestMfaFactor implements MfaPort {
  readonly factorType: MfaFactorType = 'TEST_FACTOR';
  readonly implementation = 'test-factor';

  private readonly pending = new Map<string, { userId: string; response: string }>();
  private counter = 0;

  begin(userId: string): Promise<MfaChallenge> {
    this.counter += 1;
    const challengeId = `mfa-test-${this.counter}`;
    this.pending.set(challengeId, { userId, response: this.expectedResponse(challengeId) });
    return Promise.resolve({ challengeId, factorType: this.factorType });
  }

  verify(challengeId: string, response: string): Promise<boolean> {
    const entry = this.pending.get(challengeId);
    if (entry === undefined) return Promise.resolve(false);
    // Single-use, mirroring the challenge contract of AUTH.md §3.
    this.pending.delete(challengeId);
    return Promise.resolve(entry.response === response);
  }

  /** Test-only: the response this factor will accept. */
  expectedResponse(challengeId: string): string {
    return `ok-${challengeId}`;
  }
}

/**
 * Select the MFA implementation for this environment.
 *
 * PRODUCTION fails closed: elevating a real privileged session on a test factor
 * would be a security control in name only. LOCAL, TEST, and STAGING receive the
 * test factor, which is what lets STAGING run privileged-path drills.
 */
export function createMfaPort(config: SuasConfig): MfaPort {
  if (config.environment === 'PRODUCTION') {
    throw new MfaUnavailableError(config.environment);
  }
  return new TestMfaFactor();
}
