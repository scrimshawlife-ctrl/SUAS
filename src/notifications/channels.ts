/**
 * Notification channel ports.
 *
 * Spec citations:
 * - SUAS-specs NOTIFICATIONS.md §2 ("Unavailable external provider/channel must
 *   be reported unavailable; do not fake delivery"), §6 (`SENT` means the send
 *   attempt was accepted, not that it was delivered), §10 (no message bodies in
 *   ordinary logs; credentials outside domain records), §11 (provider-specific
 *   statuses must not leak into product contracts)
 * - SUAS-specs ARCHITECTURE.md §11 (`EmailPort`, `SmsPort`)
 * - SUAS-specs ENVIRONMENT.md §3 (`SUAS_EMAIL_MODE` / `SUAS_SMS_MODE` are
 *   `disabled|fake|sink` in v0.1.1; production external modes are not valid)
 *
 * IN_APP is internal and always available: it writes to SUAS's own store rather
 * than contacting a provider, so no vendor decision gates it.
 */

import type { CommunicationMode, SuasConfig } from '../config/index.js';

export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** NOTIFICATIONS.md §2: PUSH is reserved and cannot be selected. */
export const RESERVED_FUTURE_CHANNELS = ['PUSH'] as const;

export class UnknownChannelError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor(channel: string) {
    const reserved = (RESERVED_FUTURE_CHANNELS as readonly string[]).includes(channel);
    super(
      reserved
        ? `"${channel}" is reserved for a future release and is not an MVP channel ` +
            `(SUAS-specs NOTIFICATIONS.md §2).`
        : `"${channel}" is not a known notification channel. MVP channels: ` +
            `${NOTIFICATION_CHANNELS.join(', ')}.`,
    );
    this.name = 'UnknownChannelError';
  }
}

export function assertNotificationChannel(channel: string): asserts channel is NotificationChannel {
  if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
    throw new UnknownChannelError(channel);
  }
}

/**
 * NOTIFICATIONS.md §2. Raised when a channel has no delivery path, so the caller
 * reports unavailability rather than recording a send that never happened.
 */
export class ChannelUnavailableError extends Error {
  readonly code = 'CHANNEL_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(channel: NotificationChannel) {
    super(
      `The ${channel} channel has no configured delivery path, so nothing was sent ` +
        `(SUAS-specs NOTIFICATIONS.md §2).`,
    );
    this.name = 'ChannelUnavailableError';
  }
}

export interface OutboundMessage {
  readonly channel: NotificationChannel;
  /** Address or reference. For IN_APP this is the recipient user id. */
  readonly destination: string;
  readonly templateVersion: string;
  /**
   * Rendered body. NOTIFICATIONS.md §10 forbids writing this to ordinary
   * application logs, and §7 forbids templates carrying safety-critical logic.
   */
  readonly body: string;
  /** Stable identity so an adapter can deduplicate its own retries. */
  readonly idempotencyKey: string;
}

export interface SendAcknowledgement {
  /**
   * Adapter accepted the send attempt. NOTIFICATIONS.md §6: this is not delivery.
   */
  readonly accepted: boolean;
  /** Opaque provider reference when one exists. */
  readonly providerReference?: string;
  readonly failureReason?: string;
}

export interface NotificationChannelPort {
  readonly channel: NotificationChannel;
  readonly mode: CommunicationMode | 'internal';
  readonly implementation: string;
  send(message: OutboundMessage): Promise<SendAcknowledgement>;
}

export interface RecordedMessage extends OutboundMessage {
  readonly sentAt: Date;
}

/**
 * Fake or sink channel for the environment classes that forbid real external
 * effects. `fake` retains messages for inspection; `sink` accepts and discards.
 * Neither reaches a provider.
 */
export class RecordingChannel implements NotificationChannelPort {
  readonly implementation = 'recording-fake';

  private readonly messages: RecordedMessage[] = [];

  constructor(
    readonly channel: NotificationChannel,
    readonly mode: CommunicationMode | 'internal',
  ) {}

  send(message: OutboundMessage): Promise<SendAcknowledgement> {
    if (this.mode === 'disabled') {
      return Promise.reject(new ChannelUnavailableError(this.channel));
    }
    if (this.mode === 'fake' || this.mode === 'internal') {
      this.messages.push({ ...message, sentAt: new Date() });
    }
    return Promise.resolve({
      accepted: true,
      providerReference: `fake-${message.idempotencyKey}`,
    });
  }

  /** Test-only inspection. */
  sent(): readonly RecordedMessage[] {
    return this.messages;
  }

  lastFor(destination: string): RecordedMessage | undefined {
    return [...this.messages].reverse().find((message) => message.destination === destination);
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/** A channel that always fails, for exercising retry and exhaustion paths. */
export class FailingChannel implements NotificationChannelPort {
  readonly implementation = 'failing-fake';
  readonly mode: CommunicationMode | 'internal' = 'fake';

  constructor(
    readonly channel: NotificationChannel,
    private readonly reason = 'provider unavailable',
  ) {}

  send(): Promise<SendAcknowledgement> {
    return Promise.resolve({ accepted: false, failureReason: this.reason });
  }
}

/**
 * Channels available for this configuration.
 *
 * EMAIL and SMS follow their released mode variables; a `disabled` mode yields no
 * port at all, so the caller reports the channel unavailable instead of faking a
 * send. IN_APP is internal and always present.
 */
export function createChannelRegistry(
  config: SuasConfig,
): Map<NotificationChannel, NotificationChannelPort> {
  const registry = new Map<NotificationChannel, NotificationChannelPort>();

  if (config.notifications.email !== 'disabled') {
    registry.set('EMAIL', new RecordingChannel('EMAIL', config.notifications.email));
  }
  if (config.notifications.sms !== 'disabled') {
    registry.set('SMS', new RecordingChannel('SMS', config.notifications.sms));
  }
  registry.set('IN_APP', new RecordingChannel('IN_APP', 'internal'));

  return registry;
}
