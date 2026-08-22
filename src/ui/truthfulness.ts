/**
 * Crisis / practical-support state truthfulness.
 *
 * Spec citations:
 * - SUAS-specs SAFETY_COPY.md §4 (approved / forbidden language)
 * - SUAS-specs SAFETY_COPY.md §5 (REQUESTED ≠ ACCEPTED ≠ DISPATCHED ≠ ARRIVED ≠ RESOLVED)
 * - SUAS-specs SAFETY.md §5.1 (same contract)
 * - SUAS-specs MVP_REFERENCE.md §7.3 (later state only from a recorded fact)
 * - SUAS-specs DISPATCH.md §2 / FULFILLMENT.md §2 / PROVIDER_INTEGRATIONS.md §8
 *   (canonical Service Request / Fulfillment / Attempt machines — this module
 *   maps onto those facts and does not invent new domain states)
 *
 * v0.1.5 assigned the mapping to the implementation. A later condition is
 * returned only when its recorded evidence exists. `DISPATCHED` and `ARRIVED`
 * are practical-support-provider states, never emergency-services dispatch
 * (RELEASE_MANIFEST-0.1.5.md D-012 authority item 5; rule 14).
 *
 * `ARRIVED` has no distinct recorded fact in the current machines (Uber
 * `arriving` collapses to `PROVIDER_IN_PROGRESS`; no "reached the veteran"
 * status exists). Fail-closed: `ARRIVED` is never returned unless the caller
 * supplies an explicit `providerArrived` fact.
 */

import type { ServiceRequestStatus } from '../coordination/index.js';
import type { AttemptStatus, FulfillmentState } from '../fulfillment/index.js';

/** SAFETY_COPY.md §5, verbatim. */
export const TRUTHFULNESS_CONDITIONS = [
  'REQUESTED',
  'ACCEPTED',
  'DISPATCHED',
  'ARRIVED',
  'RESOLVED',
] as const;
export type TruthfulnessCondition = (typeof TRUTHFULNESS_CONDITIONS)[number];

/**
 * Recorded facts a truthfulness label may depend on. Each field is something
 * the system actually stored, never an inference about the world.
 */
export interface TruthfulnessFacts {
  readonly requestStatus?: ServiceRequestStatus;
  readonly attemptStatus?: AttemptStatus;
  readonly fulfillmentState?: FulfillmentState;
  /**
   * Verified evidence that the support provider/resource reached the veteran.
   * Absent from the current domain machines; callers must not invent it.
   */
  readonly providerArrived?: boolean;
  /**
   * An emergency referral (911/988 / ESCALATED) was recorded. SAFETY_COPY.md
   * §3.1 / §5: that fact alone must not make the request `RESOLVED`.
   */
  readonly emergencyReferralOnly?: boolean;
}

export interface TruthfulnessPresentation {
  readonly condition: TruthfulnessCondition;
  readonly headline: string;
  readonly basis: string;
}

const REQUEST_RESOLVED: ReadonlySet<ServiceRequestStatus> = new Set([
  'FULFILLED',
  'CONFIRMED',
  'CLOSED',
]);
const ATTEMPT_RESOLVED: ReadonlySet<AttemptStatus> = new Set([
  'PROVIDER_COMPLETED',
  'MANUAL_COMPLETED',
]);
const FULFILLMENT_RESOLVED: ReadonlySet<FulfillmentState> = new Set(['COMPLETED', 'CONFIRMED']);

const REQUEST_ACCEPTED: ReadonlySet<ServiceRequestStatus> = new Set(['ACCEPTED', 'IN_PROGRESS']);
const ATTEMPT_ACCEPTED: ReadonlySet<AttemptStatus> = new Set(['PROVIDER_ACCEPTED']);

/**
 * SAFETY_COPY.md §4 "Do not use" list. Surfaces must not emit these phrases
 * unless the matching recorded fact exists — and several of them (safety
 * inference, guaranteed fulfillment) have no authorized fact at all.
 */
export const FORBIDDEN_CRISIS_PHRASES = [
  'Help is on the way',
  'You are safe now',
  'We have you',
  'Rescue is coming',
  'Emergency team dispatched',
  'Everything will be okay',
  'Your request is guaranteed',
  'We notified the authorities',
] as const;

export function containsForbiddenCrisisPhrase(text: string): string | undefined {
  const lower = text.toLowerCase();
  return FORBIDDEN_CRISIS_PHRASES.find((phrase) => lower.includes(phrase.toLowerCase()));
}

function hasResolvedEvidence(facts: TruthfulnessFacts): boolean {
  if (facts.emergencyReferralOnly === true) return false;
  if (facts.requestStatus === 'ESCALATED') return false;
  return (
    (facts.requestStatus !== undefined && REQUEST_RESOLVED.has(facts.requestStatus)) ||
    (facts.attemptStatus !== undefined && ATTEMPT_RESOLVED.has(facts.attemptStatus)) ||
    (facts.fulfillmentState !== undefined && FULFILLMENT_RESOLVED.has(facts.fulfillmentState))
  );
}

function hasArrivedEvidence(facts: TruthfulnessFacts): boolean {
  return facts.providerArrived === true;
}

function hasDispatchedEvidence(facts: TruthfulnessFacts): boolean {
  return facts.attemptStatus === 'PROVIDER_IN_PROGRESS' || facts.fulfillmentState === 'STARTED';
}

function hasAcceptedEvidence(facts: TruthfulnessFacts): boolean {
  return (
    (facts.requestStatus !== undefined && REQUEST_ACCEPTED.has(facts.requestStatus)) ||
    (facts.attemptStatus !== undefined && ATTEMPT_ACCEPTED.has(facts.attemptStatus)) ||
    facts.fulfillmentState === 'ACCEPTED'
  );
}

function hasRequestedEvidence(facts: TruthfulnessFacts): boolean {
  return facts.requestStatus !== undefined;
}

/**
 * Whether the recorded facts prove a named condition. Used by tests and by
 * callers that need to refuse a later label without selecting one.
 */
export function conditionProven(
  facts: TruthfulnessFacts,
  condition: TruthfulnessCondition,
): boolean {
  switch (condition) {
    case 'RESOLVED':
      return hasResolvedEvidence(facts);
    case 'ARRIVED':
      return hasArrivedEvidence(facts);
    case 'DISPATCHED':
      return hasDispatchedEvidence(facts);
    case 'ACCEPTED':
      return hasAcceptedEvidence(facts);
    case 'REQUESTED':
      return hasRequestedEvidence(facts);
  }
}

/**
 * Highest proven condition, or `undefined` when nothing has been recorded.
 *
 * Order is later-first so a completion fact is not shown as a mere request.
 * A later condition is never returned without its own evidence — there is no
 * "if accepted then dispatched" inference.
 */
export function presentTruthfulnessCondition(
  facts: TruthfulnessFacts,
): TruthfulnessPresentation | undefined {
  if (hasResolvedEvidence(facts)) {
    return {
      condition: 'RESOLVED',
      headline: 'This request is complete on recorded evidence.',
      basis: resolvedBasis(facts),
    };
  }
  if (hasArrivedEvidence(facts)) {
    return {
      condition: 'ARRIVED',
      headline: 'The support provider has reached you.',
      basis: 'Recorded provider-arrived evidence',
    };
  }
  if (hasDispatchedEvidence(facts)) {
    return {
      condition: 'DISPATCHED',
      headline: 'A support provider reports it is underway.',
      basis:
        facts.attemptStatus === 'PROVIDER_IN_PROGRESS'
          ? 'Fulfillment Attempt status PROVIDER_IN_PROGRESS'
          : 'Service Fulfillment state STARTED',
    };
  }
  if (hasAcceptedEvidence(facts)) {
    return {
      condition: 'ACCEPTED',
      headline: 'A participating provider has accepted this request.',
      basis: acceptedBasis(facts),
    };
  }
  if (hasRequestedEvidence(facts)) {
    return {
      condition: 'REQUESTED',
      headline:
        'Your request has been received. This does not mean that assistance has been confirmed.',
      basis: `Service Request status ${facts.requestStatus}`,
    };
  }
  return undefined;
}

function resolvedBasis(facts: TruthfulnessFacts): string {
  if (facts.fulfillmentState !== undefined && FULFILLMENT_RESOLVED.has(facts.fulfillmentState)) {
    return `Service Fulfillment state ${facts.fulfillmentState}`;
  }
  if (facts.attemptStatus !== undefined && ATTEMPT_RESOLVED.has(facts.attemptStatus)) {
    return `Fulfillment Attempt status ${facts.attemptStatus}`;
  }
  return `Service Request status ${facts.requestStatus}`;
}

function acceptedBasis(facts: TruthfulnessFacts): string {
  if (facts.fulfillmentState === 'ACCEPTED') return 'Service Fulfillment state ACCEPTED';
  if (facts.attemptStatus !== undefined && ATTEMPT_ACCEPTED.has(facts.attemptStatus)) {
    return `Fulfillment Attempt status ${facts.attemptStatus}`;
  }
  return `Service Request status ${facts.requestStatus}`;
}
