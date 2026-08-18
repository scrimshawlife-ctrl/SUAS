/**
 * Challenge delivery capability port.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §2 (passwordless methods; supported "where email/SMS
 *   provider configured"), §9 (provider-neutral delivery: "If a delivery provider
 *   is unavailable, that channel is unavailable. Do not fake success.")
 * - SUAS-specs ENVIRONMENT.md §3 "Notifications" (SUAS_EMAIL_MODE /
 *   SUAS_SMS_MODE = disabled|fake|sink; production external modes are not valid
 *   in v0.1.1)
 * - SUAS-specs ARCHITECTURE.md §11 (infrastructure ports: SmsPort, EmailPort)
 *
 * The rule that matters here: a disabled channel is reported unavailable rather
 * than silently succeeding. Faking delivery would tell a veteran a code is on its
 * way when nothing was sent.
 */

import type { CommunicationMode, SuasConfig } from '../config/index.js';

export type ChallengeMethod = 'MAGIC_LINK' | 'EMAIL_OTP' | 'PHONE_OTP';
export type ChallengeChannel = 'EMAIL' | 'SMS';

export const CHALLENGE_METHODS: readonly ChallengeMethod[] = [
  'MAGIC_LINK',
  'EMAIL_OTP',
  'PHONE_OTP',
];

export function channelForMethod(method: ChallengeMethod): ChallengeChannel {
  return method === 'PHONE_OTP' ? 'SMS' : 'EMAIL';
}

/**
 * AUTH.md §9. Raised when a channel has no configured delivery path. This is a
 * truthful unavailability, not a failure to try.
 */
export class ChannelUnavailableError extends Error {
  readonly code = 'CHANNEL_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(channel: ChallengeChannel) {
    super(
      `The ${channel} channel is not available in this environment, so no challenge was sent. ` +
        `Delivery mode is "disabled" (SUAS-specs AUTH.md §9; ENVIRONMENT.md §3).`,
    );
    this.name = 'ChannelUnavailableError';
  }
}

export interface ChallengeDelivery {
  readonly channel: ChallengeChannel;
  readonly destination: string;
  readonly method: ChallengeMethod;
  /** The magic-link token or OTP code being delivered. */
  readonly secret: string;
  readonly expiresAt: Date;
}

export interface ChallengeDeliveryPort {
  /** Delivery mode actually in force, for operational truthfulness. */
  readonly mode: CommunicationMode;
  readonly implementation: string;
  availableChannels(): readonly ChallengeChannel[];
  deliver(delivery: ChallengeDelivery): Promise<void>;
}

export interface RecordedDelivery extends ChallengeDelivery {
  readonly deliveredAt: Date;
}

/**
 * Fake/sink delivery for the environment classes that forbid real external
 * effects. `fake` retains messages for inspection; `sink` accepts and discards,
 * matching the released mode names.
 */
export class RecordingChallengeDelivery implements ChallengeDeliveryPort {
  readonly implementation = 'recording-fake';

  private readonly deliveries: RecordedDelivery[] = [];

  constructor(
    readonly mode: CommunicationMode,
    private readonly channels: readonly ChallengeChannel[],
  ) {}

  availableChannels(): readonly ChallengeChannel[] {
    return this.channels;
  }

  deliver(delivery: ChallengeDelivery): Promise<void> {
    if (!this.channels.includes(delivery.channel)) {
      return Promise.reject(new ChannelUnavailableError(delivery.channel));
    }
    if (this.mode === 'fake') {
      this.deliveries.push({ ...delivery, deliveredAt: new Date() });
    }
    // `sink` accepts and drops; nothing leaves the process in either mode.
    return Promise.resolve();
  }

  /** Test-only inspection. Never call this from product code. */
  delivered(): readonly RecordedDelivery[] {
    return this.deliveries;
  }

  lastFor(destination: string): RecordedDelivery | undefined {
    return [...this.deliveries].reverse().find((item) => item.destination === destination);
  }

  clear(): void {
    this.deliveries.length = 0;
  }
}

/**
 * Which channels a configuration actually supports.
 * A mode of `disabled` yields no channel, so callers must report unavailability.
 */
export function availableChannels(config: SuasConfig): ChallengeChannel[] {
  const channels: ChallengeChannel[] = [];
  if (config.notifications.email !== 'disabled') channels.push('EMAIL');
  if (config.notifications.sms !== 'disabled') channels.push('SMS');
  return channels;
}

/**
 * Build the delivery port for this configuration.
 *
 * Real provider adapters are not authorized by v0.1.1 (ENVIRONMENT.md §3
 * "Notifications"), so only fake/sink implementations exist. Configuration
 * cannot select a real vendor: the config schema rejects those values outright.
 */
export function createChallengeDelivery(config: SuasConfig): ChallengeDeliveryPort {
  const channels = availableChannels(config);
  // Email and SMS modes are configured separately; the port reports the more
  // permissive of the two for visibility, and enforces per channel on delivery.
  const mode: CommunicationMode =
    config.notifications.email === 'fake' || config.notifications.sms === 'fake'
      ? 'fake'
      : channels.length === 0
        ? 'disabled'
        : 'sink';
  return new RecordingChallengeDelivery(mode, channels);
}
