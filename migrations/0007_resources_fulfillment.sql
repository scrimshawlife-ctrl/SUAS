-- 0007_resources_fulfillment.sql — catalog, referrals, provider attempts, fulfillment
--
-- Released contract implemented:
-- - SUAS-specs RESOURCES.md §2 (core fields), §3 (freshness bands), §5
--   (verification), §7 (active/inactive), §9 (audit only, no Resource Domain Event).
-- - SUAS-specs REFERRALS.md §2 (required content), §3 (states), §5 (send identity).
-- - SUAS-specs FULFILLMENT.md §2 (fulfillment states), §3 (attempt fields),
--   §3.1 (attempt status), §3.2 (idempotency), §6 (confirmation).
-- - SUAS-specs PROVIDER_INTEGRATIONS.md §3 (integration modes), §7 (fulfillment
--   modes), §8 (status normalization), §9 (attempt identity), §12 (health).
-- - SUAS-specs DATA_MODEL.md §7 (requests/providers/fulfillment), §8 (referrals).
--
-- No provider credential column exists anywhere in this migration: RESOURCES.md §2
-- and DATA_MODEL.md §7 both forbid it, and ADMIN.md §3 allows only a
-- secret-presence indicator, which is deployment configuration rather than data.
--
-- Destructive-change note (ENVIRONMENT.md §9): additive only.

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------

-- PROVIDER_INTEGRATIONS.md §3. `NONE` means SUAS can display the resource but
-- has no fulfillment integration.
CREATE TYPE suas_integration_mode AS ENUM (
    'API',
    'WEBHOOK',
    'DEEP_LINK',
    'PHONE',
    'EMAIL',
    'MANUAL_COORDINATION',
    'NONE'
);

-- PROVIDER_INTEGRATIONS.md §7. Normalizes the fact that a pantry, a hotel, and a
-- rideshare API do not operate the same way.
CREATE TYPE suas_fulfillment_mode AS ENUM (
    'DIRECT_BOOKING',
    'PROVIDER_CONFIRMATION',
    'PHONE_CONFIRMATION',
    'REFERRAL_REQUIRED',
    'MANUAL_COORDINATION',
    'INFORMATION_ONLY',
    'UNAVAILABLE'
);

-- FULFILLMENT.md §3.1 / PROVIDER_INTEGRATIONS.md §8. Integration evidence, never
-- canonical Service Request state.
CREATE TYPE suas_attempt_status AS ENUM (
    'PROVIDER_PENDING',
    'PROVIDER_ACCEPTED',
    'PROVIDER_IN_PROGRESS',
    'PROVIDER_COMPLETED',
    'PROVIDER_DECLINED',
    'PROVIDER_CANCELLED',
    'PROVIDER_FAILED',
    'PROVIDER_UNKNOWN',
    'MANUAL_PENDING',
    'MANUAL_COMPLETED',
    'MANUAL_FAILED'
);

-- FULFILLMENT.md §2.
CREATE TYPE suas_fulfillment_state AS ENUM (
    'ACCEPTED',
    'STARTED',
    'COMPLETED',
    'CONFIRMED',
    'DISPUTED',
    'FAILED',
    'PARTIAL',
    'CANCELLED'
);

-- REFERRALS.md §3.
CREATE TYPE suas_referral_status AS ENUM (
    'DRAFTED',
    'SENT',
    'ACKNOWLEDGED',
    'ACCEPTED',
    'DECLINED',
    'COMPLETED',
    'UNABLE_TO_SERVE',
    'CANCELLED'
);

-- REFERRALS.md §2.
CREATE TYPE suas_referral_method AS ENUM ('IN_APP', 'PHONE', 'EMAIL');

-- PROVIDER_INTEGRATIONS.md §12.
CREATE TYPE suas_adapter_health AS ENUM (
    'HEALTHY',
    'DEGRADED',
    'RATE_LIMITED',
    'UNAVAILABLE',
    'MISCONFIGURED'
);

-- ---------------------------------------------------------------------------
-- Service providers (DATA_MODEL.md §7)
-- ---------------------------------------------------------------------------

CREATE TABLE service_providers (
    service_provider_id uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    organization_id     uuid,
    name                text        NOT NULL,
    active              boolean     NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (organization_id, tenant_id)
        REFERENCES organizations (organization_id, tenant_id),
    UNIQUE (service_provider_id, tenant_id)
);

CREATE INDEX service_providers_tenant_idx ON service_providers (tenant_id, active);

-- ---------------------------------------------------------------------------
-- Resource catalog (RESOURCES.md §2, §7)
-- ---------------------------------------------------------------------------

CREATE TABLE resources (
    resource_id         uuid                    PRIMARY KEY,
    tenant_id           uuid                    NOT NULL,
    service_provider_id uuid,
    organization_id     uuid,
    service_name        text                    NOT NULL,
    category            suas_service_category   NOT NULL,
    -- Recorded criteria only. RESOURCES.md §2: do not invent VA/Medi-Cal rules.
    eligibility         text,
    counties            text[]                  NOT NULL DEFAULT '{}',
    hours               text,
    -- Public/operational contact path. Never credentials (RESOURCES.md §2).
    contact_method      text,
    referral_method     text,
    cost                text,
    capacity            text,
    integration_modes   suas_integration_mode[] NOT NULL DEFAULT '{}',
    active              boolean                 NOT NULL DEFAULT false,
    -- RESOURCES.md §2 marks both required; §11 requires activation to reject a
    -- Resource missing them, which the CHECK below enforces.
    last_verified_at    timestamptz,
    verification_source text,
    created_at          timestamptz             NOT NULL DEFAULT now(),
    updated_at          timestamptz             NOT NULL DEFAULT now(),
    deactivated_at      timestamptz,

    FOREIGN KEY (service_provider_id, tenant_id)
        REFERENCES service_providers (service_provider_id, tenant_id),
    FOREIGN KEY (organization_id, tenant_id)
        REFERENCES organizations (organization_id, tenant_id),
    UNIQUE (resource_id, tenant_id),

    -- An active Resource must carry its verification evidence.
    CONSTRAINT resources_active_requires_verification
        CHECK (active = false OR (last_verified_at IS NOT NULL AND verification_source IS NOT NULL))
);

-- RESOURCES.md §8: bounded, tenant and coverage scoped search.
CREATE INDEX resources_search_idx
    ON resources (tenant_id, category, active, last_verified_at DESC);
CREATE INDEX resources_provider_idx ON resources (service_provider_id);

-- ---------------------------------------------------------------------------
-- Provider adapter configuration (ADMIN.md §3; DATA_MODEL.md §7)
-- ---------------------------------------------------------------------------
--
-- ADMIN.md §3: admin surfaces may expose an opaque adapter id, capability,
-- integration mode, scope, enabled state, coverage/priority, and normalized
-- health — but never API keys, tokens, or webhook secrets. There is therefore no
-- credential column here; credentials are deployment secrets (SECURITY.md §2).

CREATE TABLE provider_adapter_configurations (
    adapter_configuration_id uuid                  PRIMARY KEY,
    tenant_id                uuid                  NOT NULL,
    service_provider_id      uuid,
    -- Opaque adapter identity. Not a vendor name: PROVIDER_INTEGRATIONS.md §2
    -- rule 10 keeps provider names out of canon until a decision records one.
    adapter_id               text                  NOT NULL,
    capability               suas_service_category NOT NULL,
    integration_mode         suas_integration_mode NOT NULL,
    enabled                  boolean               NOT NULL DEFAULT false,
    -- Routing inputs (PROVIDER_INTEGRATIONS.md §2 rule 9): selection happens
    -- above the adapter, never inside it.
    coverage_counties        text[]                NOT NULL DEFAULT '{}',
    routing_priority         integer               NOT NULL DEFAULT 100,
    health                   suas_adapter_health   NOT NULL DEFAULT 'HEALTHY',
    health_checked_at        timestamptz,
    created_at               timestamptz           NOT NULL DEFAULT now(),
    updated_at               timestamptz           NOT NULL DEFAULT now(),

    FOREIGN KEY (service_provider_id, tenant_id)
        REFERENCES service_providers (service_provider_id, tenant_id),
    UNIQUE (tenant_id, adapter_id, capability)
);

CREATE INDEX provider_adapter_configurations_routing_idx
    ON provider_adapter_configurations (tenant_id, capability, enabled, routing_priority);

-- ---------------------------------------------------------------------------
-- Referrals (REFERRALS.md §2-§3; DATA_MODEL.md §8)
-- ---------------------------------------------------------------------------

CREATE TABLE referrals (
    referral_id        uuid                  PRIMARY KEY,
    tenant_id          uuid                  NOT NULL,
    case_id            uuid                  NOT NULL,
    service_request_id uuid,
    -- REFERRALS.md §2: the grant or documented basis that authorized the send.
    -- Null while DRAFTED, because a draft discloses nothing (§3).
    consent_grant_id   uuid                  REFERENCES consent_grants (consent_grant_id),
    consent_basis      text,
    destination_type   text                  NOT NULL,
    destination_id     text                  NOT NULL,
    reason             text                  NOT NULL,
    method             suas_referral_method  NOT NULL,
    status             suas_referral_status  NOT NULL DEFAULT 'DRAFTED',
    result             text,
    follow_up_id       uuid                  REFERENCES follow_ups (follow_up_id),
    -- REFERRALS.md §5: a stable logical send identity, so a replayed send does
    -- not disclose twice.
    send_idempotency_key text,
    sent_at            timestamptz,
    created_at         timestamptz           NOT NULL DEFAULT now(),
    updated_at         timestamptz           NOT NULL DEFAULT now(),
    status_reason      text,

    FOREIGN KEY (case_id, tenant_id) REFERENCES support_cases (case_id, tenant_id),
    FOREIGN KEY (service_request_id, tenant_id)
        REFERENCES service_requests (service_request_id, tenant_id)
);

CREATE UNIQUE INDEX referrals_send_identity_key
    ON referrals (tenant_id, send_idempotency_key)
    WHERE send_idempotency_key IS NOT NULL;

CREATE INDEX referrals_case_idx ON referrals (case_id, created_at DESC);
CREATE INDEX referrals_request_idx ON referrals (service_request_id)
    WHERE service_request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Fulfillment attempts (FULFILLMENT.md §3; PROVIDER_INTEGRATIONS.md §9)
-- ---------------------------------------------------------------------------

CREATE TABLE fulfillment_attempts (
    fulfillment_attempt_id uuid                  PRIMARY KEY,
    tenant_id              uuid                  NOT NULL,
    service_request_id     uuid                  NOT NULL,
    capability             suas_service_category NOT NULL,
    -- Opaque adapter reference, plus the mode that adapter operates in.
    adapter_id             text                  NOT NULL,
    service_provider_id    uuid,
    integration_mode       suas_integration_mode NOT NULL,
    -- FULFILLMENT.md §3.2: stable per attempt. A retry reuses it; a deliberate
    -- provider switch creates a new attempt with a new identity.
    idempotency_key        text                  NOT NULL,
    status                 suas_attempt_status   NOT NULL,
    external_reference     text,
    last_provider_status   text,
    failure_reason         text,
    -- Bounded normalized adapter data. PROVIDER_INTEGRATIONS.md §6: not a
    -- dumping ground for sensitive payloads.
    metadata               jsonb                 NOT NULL DEFAULT '{}'::jsonb,
    created_at             timestamptz           NOT NULL DEFAULT now(),
    updated_at             timestamptz           NOT NULL DEFAULT now(),
    last_checked_at        timestamptz,

    FOREIGN KEY (service_request_id, tenant_id)
        REFERENCES service_requests (service_request_id, tenant_id),
    FOREIGN KEY (service_provider_id, tenant_id)
        REFERENCES service_providers (service_provider_id, tenant_id),
    UNIQUE (fulfillment_attempt_id, tenant_id)
);

-- FULFILLMENT.md §3.2: the same logical external mutation cannot be issued twice.
CREATE UNIQUE INDEX fulfillment_attempts_idempotency_key
    ON fulfillment_attempts (tenant_id, idempotency_key);

-- FULFILLMENT.md §9: at most one attempt in flight per request, so two workers
-- cannot concurrently allocate the same logical attempt. Terminal attempts do not
-- occupy the slot, which is what allows a documented reroute.
CREATE UNIQUE INDEX fulfillment_attempts_one_in_flight
    ON fulfillment_attempts (service_request_id)
    WHERE status IN ('PROVIDER_PENDING', 'PROVIDER_ACCEPTED', 'PROVIDER_IN_PROGRESS',
                     'PROVIDER_UNKNOWN', 'MANUAL_PENDING');

CREATE INDEX fulfillment_attempts_request_idx
    ON fulfillment_attempts (service_request_id, created_at DESC);
CREATE INDEX fulfillment_attempts_reconcile_idx
    ON fulfillment_attempts (status, last_checked_at)
    WHERE status = 'PROVIDER_UNKNOWN';

-- ---------------------------------------------------------------------------
-- Service fulfillments (FULFILLMENT.md §2, §6; DATA_MODEL.md §7)
-- ---------------------------------------------------------------------------

CREATE TABLE service_fulfillments (
    service_fulfillment_id uuid                   PRIMARY KEY,
    tenant_id              uuid                   NOT NULL,
    service_request_id     uuid                   NOT NULL,
    fulfillment_attempt_id uuid,
    state                  suas_fulfillment_state NOT NULL,
    fulfillment_mode       suas_fulfillment_mode,
    -- FULFILLMENT.md §6: CONFIRMED requires at least one of these, and a
    -- responder-only confirmation requires a reason.
    veteran_confirmed_at   timestamptz,
    responder_confirmed_at timestamptz,
    responder_confirmed_by uuid,
    confirmation_reason    text,
    dispute_reason         text,
    failure_reason         text,
    created_at             timestamptz            NOT NULL DEFAULT now(),
    updated_at             timestamptz            NOT NULL DEFAULT now(),

    FOREIGN KEY (service_request_id, tenant_id)
        REFERENCES service_requests (service_request_id, tenant_id),
    FOREIGN KEY (fulfillment_attempt_id, tenant_id)
        REFERENCES fulfillment_attempts (fulfillment_attempt_id, tenant_id),

    -- One fulfillment record per Service Request; attempts carry the history.
    UNIQUE (service_request_id),

    CONSTRAINT service_fulfillments_confirmed_requires_actor
        CHECK (
            state <> 'CONFIRMED'
            OR veteran_confirmed_at IS NOT NULL
            OR responder_confirmed_at IS NOT NULL
        )
);

CREATE INDEX service_fulfillments_state_idx ON service_fulfillments (tenant_id, state);

-- ---------------------------------------------------------------------------
-- Provider webhook deduplication (PROVIDER_INTEGRATIONS.md §11)
-- ---------------------------------------------------------------------------
--
-- Adapter-local ingress bookkeeping: deduplicate delivery, tolerate out-of-order
-- events, and persist only the minimum needed for operation and audit.

CREATE TABLE provider_webhook_deliveries (
    webhook_delivery_id uuid        PRIMARY KEY,
    tenant_id           uuid        NOT NULL,
    adapter_id          text        NOT NULL,
    -- Provider event id, or a deterministic adapter key when none is supplied.
    provider_event_id   text        NOT NULL,
    fulfillment_attempt_id uuid,
    received_at         timestamptz NOT NULL DEFAULT now(),
    normalized_status   suas_attempt_status,
    processing_result   text        NOT NULL,

    FOREIGN KEY (fulfillment_attempt_id, tenant_id)
        REFERENCES fulfillment_attempts (fulfillment_attempt_id, tenant_id),
    UNIQUE (tenant_id, adapter_id, provider_event_id)
);

CREATE INDEX provider_webhook_deliveries_attempt_idx
    ON provider_webhook_deliveries (fulfillment_attempt_id, received_at DESC);
