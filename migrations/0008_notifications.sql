-- 0008_notifications.sql — logical notification sends and delivery state
--
-- Released contract implemented:
-- - SUAS-specs NOTIFICATIONS.md §2 (channels), §3 (notification identity and
--   logical-send dedupe), §4 (consent and preference evaluation), §5 (durable
--   send execution), §6 (delivery status), §9 (separation from Follow-Up
--   retries), §10 (security/privacy), §11 (non-goals).
-- - SUAS-specs DATA_MODEL.md §9 (notification_preferences, notifications).
--
-- NOTIFICATIONS.md §5 is explicit: "No child `notification_attempts` domain table
-- is required; immutable Audit Events remain the attempt-history authority."
-- There is therefore deliberately no attempts table here, and §12 tests for its
-- absence.
--
-- PUSH is `FUTURE` (§2) and is deliberately not an enum value, so it cannot be
-- selected before a released decision adds it.
--
-- Destructive-change note (ENVIRONMENT.md §9): additive only.

CREATE TYPE suas_notification_channel AS ENUM ('EMAIL', 'SMS', 'IN_APP');

-- NOTIFICATIONS.md §6. Provider-specific statuses map inside adapters and never
-- appear here.
CREATE TYPE suas_delivery_status AS ENUM (
    'QUEUED',
    'SENT',
    'FAILED',
    'DELIVERED',
    'BOUNCED',
    'UNDELIVERABLE'
);

-- ---------------------------------------------------------------------------
-- Preferences (DATA_MODEL.md §9; NOTIFICATIONS.md §4.4)
-- ---------------------------------------------------------------------------
--
-- A preference selects an allowed channel. NOTIFICATIONS.md §4.4 and CONSENT.md
-- §9 are both explicit that a preference never grants consent, which is why this
-- table carries no grant reference and is read only after a basis is established.

CREATE TABLE notification_preferences (
    tenant_id  uuid                      NOT NULL,
    user_id    uuid                      NOT NULL,
    channel    suas_notification_channel NOT NULL,
    enabled    boolean                   NOT NULL DEFAULT true,
    updated_at timestamptz               NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, user_id, channel),
    FOREIGN KEY (user_id, tenant_id) REFERENCES users (user_id, tenant_id)
);

-- ---------------------------------------------------------------------------
-- Notifications (NOTIFICATIONS.md §3; DATA_MODEL.md §9)
-- ---------------------------------------------------------------------------
--
-- One row is one logical send intent (§3). Attempt history lives in Audit Events.

CREATE TABLE notifications (
    notification_id   uuid                      PRIMARY KEY,
    tenant_id         uuid                      NOT NULL,
    recipient_user_id uuid,
    -- Destination address or reference. Sensitive and tenant-scoped (§10).
    -- Null for IN_APP, where the recipient user is the address.
    destination       text,
    -- Notification policy key: why this send exists.
    reason            text                      NOT NULL,
    channel           suas_notification_channel NOT NULL,
    -- §4: the basis established when the logical send was created. Re-evaluated
    -- before each attempt; this records what authorized creation.
    consent_basis     text                      NOT NULL,
    template_version  text                      NOT NULL,
    -- §3: deterministic identity for a policy that can be delivered more than
    -- once. A deliberate reminder or escalation gets a new identity.
    dedupe_key        text,
    delivery_status   suas_delivery_status      NOT NULL DEFAULT 'QUEUED',
    -- §9: delivery attempts for this message. Never a Follow-Up coordination
    -- count, and never incremented by queue redelivery alone.
    attempt_count     integer                   NOT NULL DEFAULT 0,
    max_attempts      integer                   NOT NULL DEFAULT 5,
    last_attempt_at   timestamptz,
    sent_at           timestamptz,
    -- Recorded when a revoked basis cancels a queued send (§4.3).
    cancelled_at      timestamptz,
    cancel_reason     text,
    created_at        timestamptz               NOT NULL DEFAULT now(),
    updated_at        timestamptz               NOT NULL DEFAULT now(),

    FOREIGN KEY (recipient_user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    UNIQUE (notification_id, tenant_id),
    CHECK (channel <> 'IN_APP' OR recipient_user_id IS NOT NULL)
);

-- §3: a duplicate generating event or job resolves to the same logical send.
CREATE UNIQUE INDEX notifications_dedupe_key
    ON notifications (tenant_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

-- Durable worker pickup for sends that are still owed.
CREATE INDEX notifications_pending_idx
    ON notifications (tenant_id, created_at)
    WHERE delivery_status IN ('QUEUED', 'FAILED');

-- Operational visibility for exhausted delivery (§5).
CREATE INDEX notifications_undeliverable_idx
    ON notifications (tenant_id, updated_at DESC)
    WHERE delivery_status = 'UNDELIVERABLE';

CREATE INDEX notifications_recipient_idx
    ON notifications (tenant_id, recipient_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Delivery callbacks (NOTIFICATIONS.md §6)
-- ---------------------------------------------------------------------------
--
-- Delivery webhooks may move canonical delivery status after authentication and
-- deduplication. Duplicate or out-of-order events must not regress a terminal
-- truthful state, so the callback is recorded and the status transition is
-- decided in application code against the current state.

CREATE TABLE notification_delivery_callbacks (
    delivery_callback_id uuid                 PRIMARY KEY,
    tenant_id            uuid                 NOT NULL,
    notification_id      uuid                 NOT NULL,
    -- Provider event id, or a deterministic adapter key when none is supplied.
    provider_event_id    text                 NOT NULL,
    reported_status      suas_delivery_status NOT NULL,
    -- Provider-side ordering hint, when the provider supplies one.
    reported_at          timestamptz,
    received_at          timestamptz          NOT NULL DEFAULT now(),
    applied              boolean              NOT NULL,
    skip_reason          text,

    FOREIGN KEY (notification_id, tenant_id)
        REFERENCES notifications (notification_id, tenant_id),
    UNIQUE (tenant_id, provider_event_id)
);

CREATE INDEX notification_delivery_callbacks_notification_idx
    ON notification_delivery_callbacks (notification_id, received_at DESC);
