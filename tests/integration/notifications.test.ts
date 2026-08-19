/**
 * Notification integration evidence (requires PostgreSQL).
 *
 * SUAS-specs NOTIFICATIONS.md §2-§6, §9-§12; CONSENT.md §4; DATA_MODEL.md §9.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RecordingChannel } from '../../src/notifications/index.js';
import {
  applyDeliveryCallback,
  attemptSend,
  ChannelPreferenceDisabledError,
  ChannelUnavailableError,
  createChannelRegistry,
  enqueueNotification,
  FailingChannel,
  findNotification,
  listUndeliverable,
  NotificationConsentDeniedError,
  setChannelPreference,
  UnknownChannelError,
  assertNotificationChannel,
  type NotificationChannel,
  type NotificationChannelPort,
} from '../../src/notifications/index.js';
import {
  consentTemplateVersionKey,
  createConsentTemplateVersion,
  grantConsent,
  publishConsentTemplateVersion,
  revokeConsent,
  acceptTrustedContact,
  inviteTrustedContact,
  type DisclosureRequest,
} from '../../src/consent/index.js';
import { loadConfig } from '../../src/config/index.js';
import { InMemoryJobQueue } from '../../src/jobs/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';
import { validEnv } from '../helpers/env.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function user(tenantId: string, label: string) {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

/** A veteran with an accepted trusted contact holding a RED alert grant. */
async function alertScenario() {
  const tenantId = syntheticTenantId();
  const veteran = await user(tenantId, 'veteran');

  const invited = await inviteTrustedContact(pool, {
    tenantId,
    veteranUserId: veteran.userId,
    relationshipLabel: 'Battle buddy',
    inviteEmail: syntheticEmail(`contact-${randomUUID().slice(0, 8)}`),
  });
  const contact = await acceptTrustedContact(pool, tenantId, invited.trustedContactId);
  if (contact === undefined) throw new Error('Contact did not accept.');

  const templateKey = `alerts-${randomUUID().slice(0, 8)}`;
  const versionKey = consentTemplateVersionKey(templateKey, 1);
  await createConsentTemplateVersion(pool, { templateKey, version: 1, body: 'Synthetic.' });
  await publishConsentTemplateVersion(pool, versionKey, undefined);

  const grant = await grantConsent(pool, {
    tenantId,
    veteranUserId: veteran.userId,
    permission: 'can_receive',
    scope: 'RED',
    purpose: 'Alert a trusted contact at red',
    granteeType: 'TRUSTED_CONTACT',
    granteeId: contact.trustedContactId,
    consentTemplateVersion: versionKey,
  });

  const disclosure: DisclosureRequest = {
    tenantId,
    veteranUserId: veteran.userId,
    permission: 'can_receive',
    scope: 'RED',
    granteeType: 'TRUSTED_CONTACT',
    granteeId: contact.trustedContactId,
    purpose: 'Alert a trusted contact at red',
  };

  return { tenantId, veteran, contact, grantId: grant.consentGrantId, disclosure };
}

/** Internal-processing basis: a notification that discloses to nobody external. */
function systemDisclosure(tenantId: string, veteranUserId: string): DisclosureRequest {
  return {
    tenantId,
    veteranUserId,
    permission: 'can_view',
    scope: 'current_requests',
    granteeType: 'SYSTEM',
    granteeId: 'notifications',
    purpose: 'Notify the veteran about their own request',
    systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
  };
}

function channelRegistry(): Map<NotificationChannel, NotificationChannelPort> {
  return createChannelRegistry(loadConfig(validEnv()));
}

const renderBody = () => 'Synthetic notification body.';

describe('NOTIFICATIONS.md §2 — channels', () => {
  it.each(['EMAIL', 'SMS', 'IN_APP'])('accepts MVP channel %s', (channel) => {
    expect(() => assertNotificationChannel(channel)).not.toThrow();
  });

  it('rejects PUSH as reserved for a future release', () => {
    expect(() => assertNotificationChannel('PUSH')).toThrow(UnknownChannelError);
    try {
      assertNotificationChannel('PUSH');
    } catch (error) {
      expect((error as Error).message).toContain('reserved for a future release');
    }
  });

  it('omits a disabled channel from the registry rather than faking it', () => {
    const registry = createChannelRegistry(
      loadConfig(validEnv({ SUAS_EMAIL_MODE: 'disabled', SUAS_SMS_MODE: 'fake' })),
    );
    expect(registry.has('EMAIL')).toBe(false);
    expect(registry.has('SMS')).toBe(true);
    // IN_APP is internal and needs no provider decision.
    expect(registry.has('IN_APP')).toBe(true);
  });

  it('refuses to send on a channel with no delivery path', async () => {
    const { tenantId, veteran, disclosure } = await alertScenario();
    const enqueued = await enqueueNotification(pool, {
      tenantId,
      recipientUserId: veteran.userId,
      destination: syntheticEmail('recipient'),
      reason: 'trusted_contact_alert',
      channel: 'EMAIL',
      templateVersion: 'alert@1',
      disclosure,
    });

    const emailDisabled = createChannelRegistry(
      loadConfig(validEnv({ SUAS_EMAIL_MODE: 'disabled' })),
    );
    await expect(
      attemptSend(pool, emailDisabled, {
        tenantId,
        notificationId: enqueued.notification.notificationId,
        disclosure,
        renderBody,
      }),
    ).rejects.toThrow(ChannelUnavailableError);

    // Nothing was recorded as sent.
    const after = await findNotification(pool, tenantId, enqueued.notification.notificationId);
    expect(after?.deliveryStatus).toBe('QUEUED');
  });
});

describe('NOTIFICATIONS.md §3 — one row is one logical send', () => {
  it('resolves a duplicate generating event to the same Notification', async () => {
    const { tenantId, veteran, disclosure } = await alertScenario();
    const input = {
      tenantId,
      recipientUserId: veteran.userId,
      destination: syntheticEmail('recipient'),
      reason: 'trusted_contact_alert',
      channel: 'EMAIL',
      templateVersion: 'alert@1',
      dedupeKey: 'alert:case-1:red',
      disclosure,
    };

    const first = await enqueueNotification(pool, input);
    const replay = await enqueueNotification(pool, input);

    expect(first.deduplicated).toBe(false);
    expect(replay.deduplicated).toBe(true);
    expect(replay.notification.notificationId).toBe(first.notification.notificationId);

    const rows = await pool.query('SELECT 1 FROM notifications WHERE tenant_id = $1', [tenantId]);
    expect(rows.rowCount).toBe(1);
  });

  it('treats a deliberate reminder as a new logical send', async () => {
    const { tenantId, veteran, disclosure } = await alertScenario();
    const base = {
      tenantId,
      recipientUserId: veteran.userId,
      destination: syntheticEmail('recipient'),
      reason: 'trusted_contact_alert',
      channel: 'EMAIL',
      templateVersion: 'alert@1',
      disclosure,
    };

    const first = await enqueueNotification(pool, { ...base, dedupeKey: 'alert:case-1:red' });
    const reminder = await enqueueNotification(pool, {
      ...base,
      dedupeKey: 'alert:case-1:red:reminder-1',
    });

    expect(reminder.deduplicated).toBe(false);
    expect(reminder.notification.notificationId).not.toBe(first.notification.notificationId);
  });

  it('enqueues durable send work through the job seam', async () => {
    const { tenantId, veteran, disclosure } = await alertScenario();
    const jobQueue = new InMemoryJobQueue();

    const enqueued = await enqueueNotification(
      pool,
      {
        tenantId,
        recipientUserId: veteran.userId,
        destination: syntheticEmail('recipient'),
        reason: 'trusted_contact_alert',
        channel: 'EMAIL',
        templateVersion: 'alert@1',
        disclosure,
      },
      { jobQueue },
    );

    expect(jobQueue.enqueued()).toHaveLength(1);
    expect(jobQueue.enqueued()[0]?.idempotencyKey).toBe(enqueued.notification.notificationId);
    // The Slice 1 seam still reports itself non-durable while D-022 is open.
    expect(jobQueue.durability).toBe('non-durable');
  });
});

describe('NOTIFICATIONS.md §4 — consent at creation and before each attempt', () => {
  it('refuses to enqueue without a basis', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await user(tenantId, 'veteran');

    await expect(
      enqueueNotification(pool, {
        tenantId,
        recipientUserId: veteran.userId,
        destination: syntheticEmail('stranger'),
        reason: 'trusted_contact_alert',
        channel: 'EMAIL',
        templateVersion: 'alert@1',
        disclosure: {
          tenantId,
          veteranUserId: veteran.userId,
          permission: 'can_receive',
          scope: 'RED',
          granteeType: 'TRUSTED_CONTACT',
          granteeId: randomUUID(),
          purpose: 'Alert someone with no grant',
        },
      }),
    ).rejects.toThrow(NotificationConsentDeniedError);
  });

  it('does not send when the grant is revoked between enqueue and send', async () => {
    const { tenantId, veteran, grantId, disclosure } = await alertScenario();
    const registry = channelRegistry();

    const enqueued = await enqueueNotification(pool, {
      tenantId,
      recipientUserId: veteran.userId,
      destination: syntheticEmail('recipient'),
      reason: 'trusted_contact_alert',
      channel: 'EMAIL',
      templateVersion: 'alert@1',
      disclosure,
    });
    expect(enqueued.notification.deliveryStatus).toBe('QUEUED');

    // The revoke lands after the send was queued but before it went out.
    await revokeConsent(pool, tenantId, grantId);

    const result = await attemptSend(pool, registry, {
      tenantId,
      notificationId: enqueued.notification.notificationId,
      disclosure,
      renderBody,
    });

    expect(result.outcome).toBe('CANCELLED');
    expect(result.notification.deliveryStatus).toBe('UNDELIVERABLE');

    const email = registry.get('EMAIL') as RecordingChannel;
    expect(email.sent()).toEqual([]);
  });

  it('allows an internal-processing notification with no third-party grant', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await user(tenantId, 'veteran');
    const registry = channelRegistry();

    const enqueued = await enqueueNotification(pool, {
      tenantId,
      recipientUserId: veteran.userId,
      reason: 'service_request_update',
      channel: 'IN_APP',
      templateVersion: 'update@1',
      disclosure: systemDisclosure(tenantId, veteran.userId),
    });

    const result = await attemptSend(pool, registry, {
      tenantId,
      notificationId: enqueued.notification.notificationId,
      disclosure: systemDisclosure(tenantId, veteran.userId),
      renderBody,
    });
    expect(result.outcome).toBe('SENT');
  });

  it('honours a disabled channel preference without treating it as consent', async () => {
    const { tenantId, veteran, disclosure } = await alertScenario();
    await setChannelPreference(pool, {
      tenantId,
      userId: veteran.userId,
      channel: 'EMAIL',
      enabled: false,
    });

    await expect(
      enqueueNotification(pool, {
        tenantId,
        recipientUserId: veteran.userId,
        destination: syntheticEmail('recipient'),
        reason: 'trusted_contact_alert',
        channel: 'EMAIL',
        templateVersion: 'alert@1',
        disclosure,
      }),
    ).rejects.toThrow(ChannelPreferenceDisabledError);
  });
});

describe('NOTIFICATIONS.md §5 — durable execution and attempt history', () => {
  async function queued() {
    const scenario = await alertScenario();
    const enqueued = await enqueueNotification(pool, {
      tenantId: scenario.tenantId,
      recipientUserId: scenario.veteran.userId,
      destination: syntheticEmail('recipient'),
      reason: 'trusted_contact_alert',
      channel: 'EMAIL',
      templateVersion: 'alert@1',
      maxAttempts: 2,
      disclosure: scenario.disclosure,
    });
    return { ...scenario, notification: enqueued.notification };
  }

  it('records each attempt as an immutable Audit Event', async () => {
    const { tenantId, notification, disclosure } = await queued();
    const registry = channelRegistry();

    await attemptSend(pool, registry, {
      tenantId,
      notificationId: notification.notificationId,
      disclosure,
      renderBody,
    });

    const audits = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events
       WHERE tenant_id = $1 AND event_type = 'NOTIFICATION_SEND_ATTEMPTED'`,
      [tenantId],
    );
    expect(audits.rowCount).toBe(1);
    expect(audits.rows[0]?.payload).toMatchObject({ outcome: 'SENT', channel: 'EMAIL' });

    await expect(
      pool.query(`UPDATE audit_events SET action = 'x' WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toThrow(/append-only/);
  });

  it('has no notification_attempts child table', async () => {
    // NOTIFICATIONS.md §5 and §12: Audit Events are the attempt-history
    // authority under the current contract.
    const exists = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('notification_attempts') IS NOT NULL AS present`,
    );
    expect(exists.rows[0]?.present).toBe(false);
  });

  it('exhausts bounded retries into a visible UNDELIVERABLE state', async () => {
    const { tenantId, notification, disclosure } = await queued();
    const failing = new Map<NotificationChannel, NotificationChannelPort>([
      ['EMAIL', new FailingChannel('EMAIL', 'provider refused')],
    ]);

    const first = await attemptSend(pool, failing, {
      tenantId,
      notificationId: notification.notificationId,
      disclosure,
      renderBody,
    });
    expect(first.outcome).toBe('FAILED');
    expect(first.notification.deliveryStatus).toBe('FAILED');

    const second = await attemptSend(pool, failing, {
      tenantId,
      notificationId: notification.notificationId,
      disclosure,
      renderBody,
    });
    expect(second.notification.deliveryStatus).toBe('UNDELIVERABLE');

    const visible = await listUndeliverable(pool, tenantId);
    expect(visible.map((item) => item.notificationId)).toContain(notification.notificationId);
  });

  it('does not send twice when a worker delivers the job again', async () => {
    const { tenantId, notification, disclosure } = await queued();
    const registry = channelRegistry();

    await attemptSend(pool, registry, {
      tenantId,
      notificationId: notification.notificationId,
      disclosure,
      renderBody,
    });
    const replay = await attemptSend(pool, registry, {
      tenantId,
      notificationId: notification.notificationId,
      disclosure,
      renderBody,
    });

    expect(replay.outcome).toBe('SKIPPED');
    expect(replay.reason).toBe('ALREADY_SENT');

    const email = registry.get('EMAIL') as RecordingChannel;
    expect(email.sent()).toHaveLength(1);
  });

  it('keeps message bodies and destinations out of the audit payload', async () => {
    const { tenantId, notification, disclosure } = await queued();
    const registry = channelRegistry();
    await attemptSend(pool, registry, {
      tenantId,
      notificationId: notification.notificationId,
      disclosure,
      renderBody: () => 'Sensitive body text that must not be audited.',
    });

    const audits = await pool.query(
      `SELECT payload FROM audit_events WHERE tenant_id = $1
         AND event_type = 'NOTIFICATION_SEND_ATTEMPTED'`,
      [tenantId],
    );
    const serialized = JSON.stringify(audits.rows);
    expect(serialized).not.toContain('Sensitive body text');
    expect(serialized).not.toContain(notification.destination ?? 'no-destination');
  });
});

describe('NOTIFICATIONS.md §6 — delivery callbacks', () => {
  async function sent() {
    const scenario = await alertScenario();
    const enqueued = await enqueueNotification(pool, {
      tenantId: scenario.tenantId,
      recipientUserId: scenario.veteran.userId,
      destination: syntheticEmail('recipient'),
      reason: 'trusted_contact_alert',
      channel: 'EMAIL',
      templateVersion: 'alert@1',
      disclosure: scenario.disclosure,
    });
    await attemptSend(pool, channelRegistry(), {
      tenantId: scenario.tenantId,
      notificationId: enqueued.notification.notificationId,
      disclosure: scenario.disclosure,
      renderBody,
    });
    return { ...scenario, notification: enqueued.notification };
  }

  it('moves canonical status on an authenticated callback', async () => {
    const { tenantId, notification } = await sent();
    const applied = await applyDeliveryCallback(pool, {
      tenantId,
      notificationId: notification.notificationId,
      providerEventId: 'evt-1',
      reportedStatus: 'DELIVERED',
    });

    expect(applied.applied).toBe(true);
    expect(applied.notification.deliveryStatus).toBe('DELIVERED');
  });

  it('deduplicates a callback delivered twice', async () => {
    const { tenantId, notification } = await sent();
    const input = {
      tenantId,
      notificationId: notification.notificationId,
      providerEventId: 'evt-1',
      reportedStatus: 'DELIVERED' as const,
    };

    await applyDeliveryCallback(pool, input);
    const duplicate = await applyDeliveryCallback(pool, input);

    expect(duplicate.applied).toBe(false);
    expect(duplicate.reason).toBe('DUPLICATE');
  });

  it('does not regress a terminal state on an out-of-order callback', async () => {
    const { tenantId, notification } = await sent();

    await applyDeliveryCallback(pool, {
      tenantId,
      notificationId: notification.notificationId,
      providerEventId: 'evt-delivered',
      reportedStatus: 'DELIVERED',
    });

    // A late-arriving earlier event.
    const late = await applyDeliveryCallback(pool, {
      tenantId,
      notificationId: notification.notificationId,
      providerEventId: 'evt-sent',
      reportedStatus: 'SENT',
    });

    expect(late.applied).toBe(false);
    expect(late.reason).toBe('WOULD_REGRESS_TERMINAL_STATE');
    expect(
      (await findNotification(pool, tenantId, notification.notificationId))?.deliveryStatus,
    ).toBe('DELIVERED');
  });

  it('does not enqueue another message on callback receipt', async () => {
    const { tenantId, notification } = await sent();
    await applyDeliveryCallback(pool, {
      tenantId,
      notificationId: notification.notificationId,
      providerEventId: 'evt-1',
      reportedStatus: 'BOUNCED',
    });

    const rows = await pool.query('SELECT 1 FROM notifications WHERE tenant_id = $1', [tenantId]);
    expect(rows.rowCount).toBe(1);
  });
});

describe('NOTIFICATIONS.md §9 — attempt counts are not coordination counts', () => {
  it('never touches a Follow-Up coordination count', async () => {
    const { tenantId, veteran, disclosure } = await alertScenario();
    const enqueued = await enqueueNotification(pool, {
      tenantId,
      recipientUserId: veteran.userId,
      destination: syntheticEmail('recipient'),
      reason: 'followup_due',
      channel: 'EMAIL',
      templateVersion: 'followup@1',
      maxAttempts: 3,
      disclosure,
    });

    const failing = new Map<NotificationChannel, NotificationChannelPort>([
      ['EMAIL', new FailingChannel('EMAIL')],
    ]);
    await attemptSend(pool, failing, {
      tenantId,
      notificationId: enqueued.notification.notificationId,
      disclosure,
      renderBody,
    });
    await attemptSend(pool, failing, {
      tenantId,
      notificationId: enqueued.notification.notificationId,
      disclosure,
      renderBody,
    });

    const after = await findNotification(pool, tenantId, enqueued.notification.notificationId);
    expect(after?.attemptCount).toBe(2);

    // No Follow-Up exists, and nothing in this module can write one — the
    // coordination counter is only reachable through recordCoordinationAttempt.
    const followUps = await pool.query('SELECT 1 FROM follow_ups WHERE tenant_id = $1', [tenantId]);
    expect(followUps.rowCount).toBe(0);
  });
});
