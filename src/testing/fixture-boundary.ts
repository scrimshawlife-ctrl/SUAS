/**
 * Synthetic fixture boundary.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §2 (LOCAL/TEST/STAGING forbid real veteran data)
 * - SUAS-specs ENVIRONMENT.md §7 (no real addresses/phone numbers or copied
 *   production data in the repository)
 * - SUAS-specs TESTING.md §12 "Fixtures / non-goals" — synthetic veterans only;
 *   no production veteran data in non-production tests
 * - SUAS-specs HANDOFF.md §5 (test-fixture/synthetic-data boundary)
 *
 * Fixture data must be recognizably fictitious. This module defines what
 * "synthetic" means mechanically so tests and CI can enforce it rather than
 * relying on reviewer discipline.
 */

import type { EnvironmentClass, SuasConfig } from '../config/index.js';

export class FixtureBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureBoundaryError';
  }
}

/** Environment classes permitted to load fixtures at all. ENVIRONMENT.md §2. */
const FIXTURE_ENVIRONMENTS: readonly EnvironmentClass[] = ['LOCAL', 'TEST', 'STAGING'];

/** Reserved, non-routable email domains. RFC 2606. */
export const RESERVED_EMAIL_DOMAINS = ['example.com', 'example.net', 'example.org'] as const;

/** Reserved top-level domains that can never resolve to a real recipient. RFC 2606/6761. */
export const RESERVED_TLDS = ['.invalid', '.test', '.example', '.localhost'] as const;

/**
 * Refuse to load fixtures outside the synthetic environment classes.
 * PRODUCTION must never see fixture data, and the check is explicit rather than
 * inferred from NODE_ENV (ENVIRONMENT.md §2).
 */
export function assertSyntheticEnvironment(config: SuasConfig): void {
  if (!FIXTURE_ENVIRONMENTS.includes(config.environment)) {
    throw new FixtureBoundaryError(
      `Synthetic fixtures cannot be loaded in ${config.environment} ` +
        `(SUAS-specs ENVIRONMENT.md §2; TESTING.md §12).`,
    );
  }
  if (config.allowRealExternalEffects) {
    throw new FixtureBoundaryError(
      'Synthetic fixtures cannot be loaded while real external effects are enabled ' +
        '(SUAS-specs ENVIRONMENT.md §2).',
    );
  }
}

export function isSyntheticEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex < 1 || atIndex === normalized.length - 1) return false;
  const domain = normalized.slice(atIndex + 1);
  return (
    RESERVED_EMAIL_DOMAINS.some(
      (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
    ) || RESERVED_TLDS.some((tld) => domain.endsWith(tld))
  );
}

/**
 * NANP fictitious range: any area code with the 555-0100..555-0199 subscriber
 * block. Numbers outside it could reach a real person, so they are rejected.
 */
export function isSyntheticPhone(phone: string): boolean {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  if (digits.length !== 10) return false;
  return digits.slice(3, 6) === '555' && digits.slice(6, 8) === '01';
}

export function syntheticEmail(localPart: string): string {
  const value = `${localPart}@example.invalid`;
  assertSyntheticContact(value);
  return value;
}

/** `index` is 0-99, mapping into the reserved 555-0100..555-0199 block. */
export function syntheticPhone(index: number, areaCode = '555'): string {
  if (!Number.isInteger(index) || index < 0 || index > 99) {
    throw new FixtureBoundaryError('Synthetic phone index must be an integer between 0 and 99.');
  }
  const formatted = `+1-${areaCode}-555-01${String(index).padStart(2, '0')}`;
  assertSyntheticContact(formatted);
  return formatted;
}

/** Throw unless the value is recognizably fictitious contact data. */
export function assertSyntheticContact(value: string): void {
  if (value.includes('@')) {
    if (!isSyntheticEmail(value)) {
      throw new FixtureBoundaryError(
        `Fixture email "${value}" is not in a reserved non-routable domain ` +
          `(${[...RESERVED_EMAIL_DOMAINS, ...RESERVED_TLDS].join(', ')}). ` +
          `SUAS-specs ENVIRONMENT.md §7; TESTING.md §12.`,
      );
    }
    return;
  }
  if (!isSyntheticPhone(value)) {
    throw new FixtureBoundaryError(
      `Fixture phone "${value}" is not in the reserved 555-0100..555-0199 fictitious range. ` +
        `SUAS-specs ENVIRONMENT.md §7; TESTING.md §12.`,
    );
  }
}

export interface ContactDataFinding {
  readonly value: string;
  readonly kind: 'email' | 'phone';
  readonly reason: string;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Digit boundaries keep the scan off checksums, timestamps, and other long digit
// runs that are not phone numbers.
const PHONE_PATTERN = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;

/** True when the match sits inside a URL's userinfo section rather than free text. */
function isInsideUrl(text: string, index: number): boolean {
  const wordStart = text.lastIndexOf(' ', index) + 1;
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const segment = text.slice(Math.max(wordStart, lineStart), index);
  return segment.includes('://');
}

/**
 * Scan text for contact data that is not recognizably fictitious.
 * Used by the repository-hygiene test over fixture directories.
 */
export function scanForNonSyntheticContactData(text: string): ContactDataFinding[] {
  const findings: ContactDataFinding[] = [];

  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const value = match[0];
    if (isInsideUrl(text, match.index)) {
      // `user:pass@host` inside a connection string is not contact data; the
      // DATABASE_URL production-marker check governs those separately.
      continue;
    }
    if (!isSyntheticEmail(value)) {
      findings.push({
        value,
        kind: 'email',
        reason: 'email is not in a reserved non-routable domain',
      });
    }
  }

  for (const match of text.matchAll(PHONE_PATTERN)) {
    const value = match[0];
    if (!isSyntheticPhone(value)) {
      findings.push({
        value,
        kind: 'phone',
        reason: 'phone number is not in the reserved 555-0100..555-0199 range',
      });
    }
  }

  return findings;
}
