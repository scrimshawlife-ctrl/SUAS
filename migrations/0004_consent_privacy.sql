-- 0004_consent_privacy.sql — Consent Grants, Consent Events, Trusted Circle
--
-- Released contract implemented:
-- - SUAS-specs CONSENT.md §2 (grant shape), §3 (evaluation rules), §4
--   (revocation and preserved history), §6 (templates), §7 (states), §8 (events).
-- - SUAS-specs TRUSTED_CIRCLE.md §2 (lifecycle), §5 (permissions live on grants,
--   not on the membership row), §6 (consent dependencies).
-- - SUAS-specs DOMAIN_MODEL.md §4 (TrustedContact, ConsentGrant, ConsentEvent).
-- - SUAS-specs DATA_MODEL.md §5, §14 rule 1 (tenant consistency).
-- - SUAS-specs PRIVACY.md §2 (consent history preserved), §10 (no automatic purge).
--
-- Retention remains D-007 DECISION_PENDING: nothing here purges, and consent
-- history is never deleted (CONSENT.md §4).
--
-- Destructive-change note (ENVIRONMENT.md §9): additive only; no destructive step.

-- ---------------------------------------------------------------------------
-- Grant vocabulary (CONSENT.md §2)
-- ---------------------------------------------------------------------------
--
-- permission and scope are deliberately separate columns with no implication
-- between values: CONSENT.md §2.1 states that a grant for YELLOW does not imply
-- ORANGE or RED, and support_signal does not imply checkin_answers.

CREATE TYPE suas_consent_permission AS ENUM ('can_receive', 'can_view', 'can_share');

CREATE TYPE suas_consent_scope AS ENUM (
    -- Support Signal levels for can_receive.
    'YELLOW',
    'ORANGE',
    'RED',
    -- Viewable objects for can_view.
    'support_signal',
    'checkin_answers',
    'current_requests',
    'location',
    -- Shareable purposes for can_share.
    'service_request_fulfillment'
);

-- CONSENT.md §1 actors: who may hold a grant.
CREATE TYPE suas_grantee_type AS ENUM (
    'TRUSTED_CONTACT',
    'RESPONDER',
    'ORGANIZATION',
    'SERVICE_PROVIDER',
    'SYSTEM'
);

-- CONSENT.md §7. No hidden states.
CREATE TYPE suas_consent_grant_status AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CONSENT.md §8.
CREATE TYPE suas_consent_event_type AS ENUM (
    'GRANTED',
    'REVOKED',
    'EXPIRED',
    'DENIED',
    'TEMPLATE_ACCEPTED'
);

-- TRUSTED_CIRCLE.md §2.
CREATE TYPE suas_trusted_contact_status AS ENUM (
    'INVITED',
    'ACCEPTED',
    'SUSPENDED',
    'REMOVED',
    'REVOKED'
);

CREATE TYPE suas_consent_template_status AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- ---------------------------------------------------------------------------
-- Consent templates (CONSENT.md §6)
-- ---------------------------------------------------------------------------
--
-- Template copy is NOT_COMPUTABLE until written, and is published by SUAS-admin
-- (ADMIN.md §2). This implementation ships no copy: `body` is supplied at
-- runtime by an administrator. Grants may only reference a PUBLISHED version —
-- "Do not ship grants against unpublished templates."

CREATE TABLE consent_template_versions (
    -- Textual version key, per DATA_MODEL.md §1 ("unless a version key is textual").
    version_key   text                         PRIMARY KEY,
    template_key  text                         NOT NULL,
    version       integer                      NOT NULL,
    status        suas_consent_template_status NOT NULL DEFAULT 'DRAFT',
    -- Copy is administrator-supplied; no released text exists to ship.
    body          text,
    published_at  timestamptz,
    published_by  uuid                         REFERENCES users (user_id),
    created_at    timestamptz                  NOT NULL DEFAULT now(),

    UNIQUE (template_key, version)
);

COMMENT ON TABLE consent_template_versions IS
    'Versioned consent template text published by SUAS-admin (CONSENT.md 6). '
    'Copy is NOT_COMPUTABLE in v0.1.1 and is never shipped by the implementation.';

-- ---------------------------------------------------------------------------
-- Trusted Circle (TRUSTED_CIRCLE.md §2-§4; DOMAIN_MODEL.md §4)
-- ---------------------------------------------------------------------------
--
-- Membership alone grants no visibility (TRUSTED_CIRCLE.md §1). This table holds
-- the relationship only; every permission lives on a Consent Grant.

CREATE TABLE trusted_contacts (
    trusted_contact_id uuid                        PRIMARY KEY,
    tenant_id          uuid                        NOT NULL,
    -- The veteran who owns this circle.
    veteran_user_id    uuid                        NOT NULL,
    -- Bound when the contact enrols as a User; accept may also be recorded on
    -- the invite alone (TRUSTED_CIRCLE.md §3.3).
    contact_user_id    uuid,
    -- Required label; exact enum is DECISION_PENDING, so free text for now.
    -- TRUSTED_CIRCLE.md §4: it is not a permission.
    relationship_label text                        NOT NULL,
    invite_email       text,
    invite_phone       text,
    status             suas_trusted_contact_status NOT NULL DEFAULT 'INVITED',
    -- Template the veteran accepted when creating the invite.
    invite_template_version text                   REFERENCES consent_template_versions (version_key),
    invited_at         timestamptz                 NOT NULL DEFAULT now(),
    accepted_at        timestamptz,
    ended_at           timestamptz,
    updated_at         timestamptz                 NOT NULL DEFAULT now(),

    FOREIGN KEY (veteran_user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    -- At least one invite channel, mirroring the enrolled-channel rule for users.
    CHECK (invite_email IS NOT NULL OR invite_phone IS NOT NULL)
);

CREATE INDEX trusted_contacts_veteran_idx
    ON trusted_contacts (tenant_id, veteran_user_id, status);
CREATE INDEX trusted_contacts_contact_user_idx
    ON trusted_contacts (contact_user_id)
    WHERE contact_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Consent Grants (CONSENT.md §2, §4, §7)
-- ---------------------------------------------------------------------------

CREATE TABLE consent_grants (
    consent_grant_id         uuid                      PRIMARY KEY,
    tenant_id                uuid                      NOT NULL,
    -- The veteran who issued the grant.
    veteran_user_id          uuid                      NOT NULL,
    permission               suas_consent_permission   NOT NULL,
    scope                    suas_consent_scope        NOT NULL,
    -- Why the grant exists, bound to the accepted template version.
    purpose                  text                      NOT NULL,
    grantee_type             suas_grantee_type         NOT NULL,
    -- Opaque grantee identity: a trusted_contact_id, organization_id, adapter id,
    -- or system actor, depending on grantee_type.
    grantee_id               text                      NOT NULL,
    consent_template_version text                      NOT NULL
                                 REFERENCES consent_template_versions (version_key),
    status                   suas_consent_grant_status NOT NULL DEFAULT 'ACTIVE',
    granted_at               timestamptz               NOT NULL DEFAULT now(),
    expires_at               timestamptz,
    revoked_at               timestamptz,

    FOREIGN KEY (veteran_user_id, tenant_id) REFERENCES users (user_id, tenant_id)
);

-- CONSENT.md §4: a revoked row is never reused; re-consent inserts a new grant.
-- At most one ACTIVE grant may exist per logical permission tuple at a time.
CREATE UNIQUE INDEX consent_grants_active_key
    ON consent_grants (tenant_id, veteran_user_id, permission, scope, grantee_type, grantee_id)
    WHERE status = 'ACTIVE';

-- Use-time evaluation path (CONSENT.md §3.1).
CREATE INDEX consent_grants_evaluation_idx
    ON consent_grants (tenant_id, veteran_user_id, grantee_type, grantee_id, permission, scope)
    WHERE status = 'ACTIVE';

CREATE INDEX consent_grants_expiry_idx
    ON consent_grants (expires_at)
    WHERE status = 'ACTIVE' AND expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Consent Events (CONSENT.md §7-§8; DOMAIN_MODEL.md §4)
-- ---------------------------------------------------------------------------
--
-- Immutable consent history, preserved separately from the grant row
-- (CONSENT.md §4; PRIVACY.md §2). A DENIED event may have no grant at all:
-- CONSENT.md §7 requires one when an action requiring consent is refused.

CREATE TABLE consent_events (
    consent_event_id uuid                    PRIMARY KEY,
    tenant_id        uuid                    NOT NULL,
    consent_grant_id uuid                    REFERENCES consent_grants (consent_grant_id),
    veteran_user_id  uuid                    NOT NULL,
    event_type       suas_consent_event_type NOT NULL,
    permission       suas_consent_permission,
    scope            suas_consent_scope,
    grantee_type     suas_grantee_type,
    grantee_id       text,
    purpose          text,
    occurred_at      timestamptz             NOT NULL DEFAULT now(),
    -- Bounded structured detail. Never a body dump (CONSENT.md §5).
    payload          jsonb                   NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE consent_events IS
    'Immutable consent history. Append-only; revocation never deletes history '
    '(CONSENT.md 4).';

-- Reuses the append-only guard introduced with the event stores in 0002.
CREATE TRIGGER consent_events_append_only
    BEFORE UPDATE OR DELETE ON consent_events
    FOR EACH ROW EXECUTE FUNCTION suas_reject_event_mutation();

CREATE INDEX consent_events_veteran_idx
    ON consent_events (tenant_id, veteran_user_id, occurred_at DESC);
CREATE INDEX consent_events_grant_idx
    ON consent_events (consent_grant_id, occurred_at DESC)
    WHERE consent_grant_id IS NOT NULL;
CREATE INDEX consent_events_type_idx
    ON consent_events (tenant_id, event_type, occurred_at DESC);
