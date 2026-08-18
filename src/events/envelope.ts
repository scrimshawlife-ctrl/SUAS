/**
 * Domain and Audit Event envelope.
 *
 * Spec citations:
 * - SUAS-specs EVENT_MODEL.md §2 (common envelope), §2.1 (identity separation),
 *   §3 (domain event catalog), §4 (Audit Events), §8 (schema evolution)
 * - SUAS-specs VERSIONING.md §3.4 (event schema version identity)
 * - SUAS-specs DATA_MODEL.md §11
 */

import { z } from 'zod';
import { EVENT_SCHEMA_VERSION } from '../release/pins.js';
import type { JsonObject } from '../jobs/index.js';

/** EVENT_MODEL.md §2 `actor_type`. */
export const ACTOR_TYPES = [
  'VETERAN',
  'RESPONDER',
  'ORG_ADMIN',
  'SUAS_ADMIN',
  'TRUSTED_CONTACT',
  'SERVICE_PROVIDER',
  'SYSTEM',
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * EVENT_MODEL.md §3 domain event catalog as released in v0.1.
 *
 * The catalog is not permanently closed, but adding a type is an additive spec
 * change reconciled across the owning domain spec, this catalog, the data model,
 * tests, and the changelog. Implementation does not add types on its own, and
 * provider/vendor-native event names never appear here.
 */
export const DOMAIN_EVENT_TYPES = [
  'VETERAN_ENROLLED',
  'CHECKIN_COMPLETED',
  'SUPPORT_SIGNAL_CHANGED',
  'CASE_CREATED',
  'CASE_ASSIGNED',
  'RESPONDER_CONTACT_LOGGED',
  'CASE_ESCALATED',
  'CASE_RESOLVED',
  'SERVICE_REQUEST_CREATED',
  'SERVICE_REQUEST_ASSIGNED',
  'SERVICE_ACCEPTED',
  'SERVICE_FULFILLED',
  'SERVICE_FAILED',
  'REFERRAL_CREATED',
  'REFERRAL_UPDATED',
  'FOLLOWUP_CREATED',
  'FOLLOWUP_DUE',
  'FOLLOWUP_COMPLETED',
  'TRUSTED_CONTACT_INVITED',
  'CONSENT_GRANTED',
  'CONSENT_REVOKED',
  'TRUSTED_CONTACT_ALERTED',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export class UnknownEventTypeError extends Error {
  constructor(eventType: string) {
    super(
      `"${eventType}" is not in the released Domain Event catalog ` +
        `(SUAS-specs EVENT_MODEL.md §3). Adding a type requires an additive spec change.`,
    );
    this.name = 'UnknownEventTypeError';
  }
}

/**
 * Raised when an event carries a schema version this build cannot interpret.
 * EVENT_MODEL.md §8: consumers reject or safely ignore unsupported incompatible
 * versions rather than silently misinterpreting them.
 */
export class UnsupportedEventSchemaVersionError extends Error {
  readonly eventId: string;
  readonly schemaVersion: string;

  constructor(eventId: string, schemaVersion: string) {
    super(
      `Event ${eventId} declares schema version "${schemaVersion}", which this build does not ` +
        `support (supported: ${SUPPORTED_EVENT_SCHEMA_VERSIONS.join(', ')}). ` +
        `SUAS-specs EVENT_MODEL.md §8.`,
    );
    this.name = 'UnsupportedEventSchemaVersionError';
    this.eventId = eventId;
    this.schemaVersion = schemaVersion;
  }
}

/** Event schema versions this build can interpret. VERSIONING.md §3.4. */
export const SUPPORTED_EVENT_SCHEMA_VERSIONS: readonly string[] = [EVENT_SCHEMA_VERSION];

export function isSupportedEventSchemaVersion(version: string): boolean {
  return SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(version);
}

/**
 * The four identities of EVENT_MODEL.md §2.1. They are deliberately modelled as
 * separate fields with separate meanings and must never be aliased:
 *
 * - `eventId` identifies one immutable persisted fact;
 * - `idempotencyKey` identifies retryable logical work;
 * - `correlationId` groups related operations;
 * - `causationEventId` expresses direct event causality.
 */
export interface EventEnvelope {
  readonly eventId: string;
  readonly eventType: DomainEventType;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly occurredAt: Date;
  readonly schemaVersion: string;
  readonly payload: JsonObject;
  readonly idempotencyKey: string | undefined;
  readonly correlationId: string | undefined;
  readonly causationEventId: string | undefined;
  readonly requestId: string | undefined;
}

export interface AuditEventEnvelope {
  readonly auditEventId: string;
  readonly eventType: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly occurredAt: Date;
  readonly schemaVersion: string;
  readonly payload: JsonObject;
  readonly correlationId: string | undefined;
  readonly requestId: string | undefined;
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
}

/**
 * Payload bound. EVENT_MODEL.md §2 requires structured, bounded payloads with no
 * secrets and minimal sensitive free-text; §4 forbids copying whole provider
 * responses, Check-In answers, or notes into payloads. The byte cap is an
 * implementation-owned guard that makes "bounded" enforceable.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 16_384;

export class EventPayloadTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `Event payload is ${bytes} bytes, over the ${MAX_EVENT_PAYLOAD_BYTES}-byte bound. ` +
        `Event payloads are structured and bounded, and must not carry whole provider ` +
        `responses, Check-In answers, or notes (SUAS-specs EVENT_MODEL.md §2, §4).`,
    );
    this.name = 'EventPayloadTooLargeError';
  }
}

export function assertBoundedPayload(payload: JsonObject): void {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
    throw new EventPayloadTooLargeError(bytes);
  }
}

const jsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() =>
  z.record(
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.unknown()),
      z.record(z.unknown()),
    ]),
  ),
) as z.ZodType<JsonObject>;

/** Fields a producer supplies; the store fills in identity and timestamps. */
export const appendDomainEventInputSchema = z.object({
  eventType: z.enum(DOMAIN_EVENT_TYPES),
  aggregateType: z.string().min(1),
  aggregateId: z.string().uuid(),
  tenantId: z.string().uuid(),
  actorType: z.enum(ACTOR_TYPES),
  actorId: z.string().min(1),
  payload: jsonObjectSchema,
  idempotencyKey: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  causationEventId: z.string().uuid().optional(),
  requestId: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
});

export type AppendDomainEventInput = z.input<typeof appendDomainEventInputSchema>;

export const appendAuditEventInputSchema = z.object({
  eventType: z.string().min(1),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().uuid(),
  tenantId: z.string().uuid(),
  actorType: z.enum(ACTOR_TYPES),
  actorId: z.string().min(1),
  payload: jsonObjectSchema,
  correlationId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  ip: z.string().min(1).optional(),
  userAgent: z.string().min(1).optional(),
  occurredAt: z.date().optional(),
});

export type AppendAuditEventInput = z.input<typeof appendAuditEventInputSchema>;
