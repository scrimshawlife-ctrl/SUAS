/**
 * Authentication constants.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §3 — challenge TTL "remains an explicit documented
 *   constant (`DECISION_PENDING`, with any recommendation labeled `INFERRED`)".
 * - SUAS-specs AUTH.md §5 — idle/absolute session timeout "according to accepted
 *   constants".
 * - SUAS-specs SECURITY.md §2 — rate limits on auth challenges.
 *
 * Every value below is `INFERRED`. None is a released decision. They are gathered
 * in one file, explicitly labelled, so a released constant replaces them in one
 * place rather than being hunted through the codebase. The Slice 3 conformance
 * record returns them to specs.
 */

/** Lifecycle label for a value this implementation chose, not one the release fixed. */
export const INFERRED = 'INFERRED' as const;

export interface InferredConstant {
  readonly value: number;
  readonly lifecycle: typeof INFERRED;
  readonly rationale: string;
}

function inferred(value: number, rationale: string): InferredConstant {
  return { value, lifecycle: INFERRED, rationale };
}

/** AUTH.md §3: challenges are time-bounded. Exact TTL is DECISION_PENDING. */
export const CHALLENGE_TTL_SECONDS = inferred(
  600,
  'Ten minutes is short enough to bound replay exposure and long enough for a ' +
    'veteran to move between email and app. AUTH.md §3 leaves the exact TTL open.',
);

/** AUTH.md §3: challenges are rate-limited and attempt-bounded. */
export const CHALLENGE_MAX_ATTEMPTS = inferred(
  5,
  'Bounds brute force against a 6-digit OTP while tolerating mistyping.',
);

/** SECURITY.md §2: rate limit auth challenge issuance per destination. */
export const CHALLENGE_ISSUE_LIMIT = inferred(
  5,
  'Per destination per window; bounds mail-bombing a veteran address.',
);

export const CHALLENGE_ISSUE_WINDOW_SECONDS = inferred(
  900,
  'Fifteen-minute window pairs with the issue limit above.',
);

/** SECURITY.md §2: rate limit verification attempts per destination. */
export const CHALLENGE_VERIFY_LIMIT = inferred(
  10,
  'Per destination per window, across challenges, so rotating challenges does ' +
    'not reset an attacker budget.',
);

export const CHALLENGE_VERIFY_WINDOW_SECONDS = inferred(
  900,
  'Matches the issue window for operational simplicity.',
);

/** AUTH.md §5: absolute session lifetime. */
export const SESSION_ABSOLUTE_TTL_SECONDS = inferred(
  60 * 60 * 12,
  'Twelve hours bounds a stolen credential without forcing a re-login mid-shift ' +
    'for a responder. AUTH.md §5 defers to "accepted constants" that do not exist yet.',
);

/** AUTH.md §5: idle timeout. */
export const SESSION_IDLE_TTL_SECONDS = inferred(
  60 * 60 * 2,
  'Two idle hours ends an abandoned session well inside the absolute lifetime.',
);

/**
 * AUTH.md §4: MFA is completed before privileged elevation. Elevation is
 * deliberately shorter than the session so a privileged window does not last as
 * long as the login.
 */
export const MFA_ELEVATION_TTL_SECONDS = inferred(
  60 * 15,
  'Fifteen minutes keeps privileged authority close to the act of proving it.',
);

/** Length of the numeric code delivered for OTP methods. */
export const OTP_CODE_DIGITS = inferred(6, 'Standard OTP length; paired with attempt bounds.');

/** All inferred constants, for the build-info/admin surface and for review. */
export const INFERRED_AUTH_CONSTANTS: Readonly<Record<string, InferredConstant>> = {
  CHALLENGE_TTL_SECONDS,
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_ISSUE_LIMIT,
  CHALLENGE_ISSUE_WINDOW_SECONDS,
  CHALLENGE_VERIFY_LIMIT,
  CHALLENGE_VERIFY_WINDOW_SECONDS,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
  MFA_ELEVATION_TTL_SECONDS,
  OTP_CODE_DIGITS,
};
