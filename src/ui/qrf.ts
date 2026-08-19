/**
 * QRF deploy states, as labels over canonical facts.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §7.2 (QRF deployment truthfulness)
 * - SUAS-specs MVP_REFERENCE.md §4.8 (operational states visible and truthful)
 * - SUAS-specs DISPATCH.md §7 / coordination (canonical Service Request states)
 * - SUAS-specs SAFETY.md §2 (no emergency dispatch)
 *
 * §7.2 permits these UI labels only as "labels mapped to canonical
 * Case/Request/notification facts, not new hidden domain states". So this
 * module owns no state of its own: it is a total function from facts the
 * domain already recorded to the label the veteran sees.
 *
 * The load-bearing rule is negative. Production must not "guarantee immediate
 * notification/contact unless the system actually knows it occurred", so
 * `RESPONDER_NOTIFIED` requires a recorded delivery fact — an assignment alone
 * reads as still searching.
 */

import type { ServiceRequestStatus } from '../coordination/index.js';

/** MVP_REFERENCE.md §7.2, verbatim. */
export const QRF_UI_STATES = [
  'REQUESTED',
  'SEARCHING',
  'RESPONDER_NOTIFIED',
  'RESPONDER_ACCEPTED',
  'NO_RESPONDER_CURRENTLY_AVAILABLE',
  'DEGRADED',
  'CANCELLED',
] as const;
export type QrfUiState = (typeof QRF_UI_STATES)[number];

/**
 * The canonical facts a QRF label is allowed to depend on. Each field is
 * something the system actually recorded, never an inference about the world.
 */
export interface QrfFacts {
  readonly requestStatus: ServiceRequestStatus;
  /** A responder assignment exists and is active. */
  readonly responderAssigned: boolean;
  /**
   * A notification to the assigned responder reached a delivered state. Not
   * "we enqueued one" — §7.2 forbids claiming contact the system cannot see.
   */
  readonly responderNotificationDelivered: boolean;
  /**
   * Coordination could not run normally: the notification channel, job queue,
   * or fulfillment adapter failed closed. Surfaces as `DEGRADED` so a stalled
   * request never reads as a calm ongoing search.
   */
  readonly coordinationDegraded: boolean;
  /** Matching completed and produced no available responder. */
  readonly matchingExhausted: boolean;
}

export interface QrfPresentation {
  readonly state: QrfUiState;
  /** Short, direct veteran-facing line. §4.2 low cognitive load. */
  readonly headline: string;
  /** The canonical fact this label rests on, for audit and review. */
  readonly basis: string;
  /** Whether the veteran may still cancel. §7.2 preserves cancel. */
  readonly cancellable: boolean;
}

/**
 * Map canonical facts to the veteran-facing label.
 *
 * Order matters: a degraded coordination path outranks an optimistic search
 * label, and an exhausted match outranks a generic "searching", because §4.8
 * requires the *truthful* state to be the visible one.
 */
export function presentQrfState(facts: QrfFacts): QrfPresentation {
  if (facts.requestStatus === 'CANCELLED') {
    return {
      state: 'CANCELLED',
      headline: 'Request cancelled.',
      basis: 'Service Request status CANCELLED',
      cancellable: false,
    };
  }

  if (facts.requestStatus === 'ACCEPTED' || facts.requestStatus === 'IN_PROGRESS') {
    return {
      state: 'RESPONDER_ACCEPTED',
      headline: 'A responder accepted your request.',
      basis: `Service Request status ${facts.requestStatus}`,
      cancellable: true,
    };
  }

  if (facts.coordinationDegraded) {
    return {
      state: 'DEGRADED',
      headline: 'We are having trouble coordinating right now. Your request is still recorded.',
      basis: 'A coordination dependency failed closed',
      cancellable: true,
    };
  }

  if (
    facts.requestStatus === 'UNFULFILLABLE' ||
    facts.requestStatus === 'EXPIRED' ||
    facts.requestStatus === 'DECLINED' ||
    facts.matchingExhausted
  ) {
    return {
      state: 'NO_RESPONDER_CURRENTLY_AVAILABLE',
      headline: 'No responder is available right now. Your request is still recorded.',
      basis:
        facts.requestStatus === 'MATCHING'
          ? 'Matching completed with no available responder'
          : `Service Request status ${facts.requestStatus}`,
      cancellable: true,
    };
  }

  if (facts.responderAssigned && facts.responderNotificationDelivered) {
    return {
      state: 'RESPONDER_NOTIFIED',
      headline: 'A responder has been notified.',
      basis: 'Active assignment plus a recorded notification delivery',
      cancellable: true,
    };
  }

  if (facts.requestStatus === 'CREATED' || facts.requestStatus === 'SUBMITTED') {
    return {
      state: 'REQUESTED',
      headline: 'Your request is recorded.',
      basis: `Service Request status ${facts.requestStatus}`,
      cancellable: true,
    };
  }

  // Assigned-but-unconfirmed lands here deliberately: an assignment is not
  // evidence that anyone was reached (§7.2).
  return {
    state: 'SEARCHING',
    headline: 'Looking for a responder.',
    basis: facts.responderAssigned
      ? 'Active assignment with no recorded notification delivery'
      : `Service Request status ${facts.requestStatus}`,
    cancellable: true,
  };
}

/**
 * Whether `Call` and `Message` may be shown.
 *
 * §7.2: "`Call` and `Message` appear only when an authorized contact path
 * actually exists." Existence is not enough — the path must be consented and
 * currently usable, which the caller resolves from the consent kernel.
 */
export interface ContactAffordances {
  readonly call: boolean;
  readonly message: boolean;
}

export function contactAffordances(input: {
  readonly state: QrfUiState;
  /** A consented, currently usable voice path to the assigned responder. */
  readonly authorizedVoicePath: boolean;
  /** A consented, currently usable message path to the assigned responder. */
  readonly authorizedMessagePath: boolean;
}): ContactAffordances {
  // Before acceptance there is no counterpart to contact, whatever consent says.
  const counterpartExists =
    input.state === 'RESPONDER_ACCEPTED' || input.state === 'RESPONDER_NOTIFIED';
  return {
    call: counterpartExists && input.authorizedVoicePath,
    message: counterpartExists && input.authorizedMessagePath,
  };
}
