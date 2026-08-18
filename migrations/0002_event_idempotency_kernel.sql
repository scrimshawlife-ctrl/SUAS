-- 0002_event_idempotency_kernel.sql — Domain/Audit Events, outbox, command idempotency
--
-- Released contract implemented:
-- - SUAS-specs EVENT_MODEL.md §1-§2 (append-only stores; common envelope),
--   §2.1 (identity separation), §5 (transactionality/replay/idempotency),
--   §10 (testability).
-- - SUAS-specs DATA_MODEL.md §10 (command_idempotency_records), §11 (immutable
--   event stores and outbox-equivalent), §13 (required access paths),
--   §14 rules 14-15.
-- - SUAS-specs ARCHITECTURE.md §5.17 (Command Idempotency), §5.18 (Audit/Event
--   layer), §10 (concurrency/idempotency).
-- - SUAS-specs API.md §7 (persistent idempotency).
--
-- Retention/expiry of events and idempotency records is D-007 DECISION_PENDING;
-- this migration therefore adds no purge or TTL behavior (EVENT_MODEL.md §5.7).
--
-- Destructive-change note (ENVIRONMENT.md §9): additive only; no destructive step.
--
-- tenant_id carries no foreign key yet. Organizations arrive in SPEC017_PLAN.md
-- Slice 3; the column is present now because tenant scope is part of the released
-- envelope (EVENT_MODEL.md §2) and tenant isolation must survive jobs and events
-- (ARCHITECTURE.md §3 invariant 11).

-- ---------------------------------------------------------------------------
-- Shared envelope enumerations (EVENT_MODEL.md §2)
-- ---------------------------------------------------------------------------

CREATE TYPE suas_actor_type AS ENUM (
    'VETERAN',
    'RESPONDER',
    'ORG_ADMIN',
    'SUAS_ADMIN',
    'TRUSTED_CONTACT',
    'SERVICE_PROVIDER',
    'SYSTEM'
);

-- DATA_MODEL.md §10: state of a persisted command idempotency record.
CREATE TYPE suas_command_idempotency_state AS ENUM (
    'RESERVED',
    'COMPLETED',
    'FAILED_RETRYABLE',
    'FAILED_FINAL'
);

-- Physical publication state of an outbox row. Infrastructure, not business
-- meaning (DATA_MODEL.md §11 "not a business entity").
CREATE TYPE suas_outbox_status AS ENUM (
    'PENDING',
    'PUBLISHED',
    'DEAD_LETTER'
);

-- ---------------------------------------------------------------------------
-- Domain Events (EVENT_MODEL.md §2, §3; DATA_MODEL.md §11)
-- ---------------------------------------------------------------------------

CREATE TABLE domain_events (
    event_id           uuid            PRIMARY KEY,
    event_type         text            NOT NULL,
    aggregate_type     text            NOT NULL,
    aggregate_id       uuid            NOT NULL,
    tenant_id          uuid            NOT NULL,
    actor_type         suas_actor_type NOT NULL,
    actor_id           text            NOT NULL,
    occurred_at        timestamptz     NOT NULL,
    schema_version     text            NOT NULL,
    payload            jsonb           NOT NULL,
    -- Conditional: present when the event is produced by retryable work.
    -- EVENT_MODEL.md §2.1 keeps this distinct from event_id.
    idempotency_key    text,
    correlation_id     text,
    causation_event_id uuid            REFERENCES domain_events (event_id),
    request_id         text,
    recorded_at        timestamptz     NOT NULL DEFAULT now()
);

COMMENT ON TABLE domain_events IS
    'Immutable business facts. Append-only from application roles (EVENT_MODEL.md §1).';

-- EVENT_MODEL.md §5.2 and §10: duplicate command/job replay must not create a
-- second logical Domain Event. Enforced by the database, not by convention.
CREATE UNIQUE INDEX domain_events_logical_identity_key
    ON domain_events (tenant_id, event_type, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- DATA_MODEL.md §13: tenant/aggregate/time/correlation/idempotency access paths.
CREATE INDEX domain_events_aggregate_idx
    ON domain_events (tenant_id, aggregate_type, aggregate_id, occurred_at DESC);
CREATE INDEX domain_events_tenant_time_idx
    ON domain_events (tenant_id, occurred_at DESC);
CREATE INDEX domain_events_correlation_idx
    ON domain_events (correlation_id)
    WHERE correlation_id IS NOT NULL;
CREATE INDEX domain_events_type_time_idx
    ON domain_events (tenant_id, event_type, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Audit Events (EVENT_MODEL.md §4; DATA_MODEL.md §11)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
    audit_event_id  uuid            PRIMARY KEY,
    event_type      text            NOT NULL,
    action          text            NOT NULL,
    target_type     text            NOT NULL,
    target_id       text            NOT NULL,
    aggregate_type  text            NOT NULL,
    aggregate_id    uuid            NOT NULL,
    tenant_id       uuid            NOT NULL,
    actor_type      suas_actor_type NOT NULL,
    actor_id        text            NOT NULL,
    occurred_at     timestamptz     NOT NULL,
    schema_version  text            NOT NULL,
    payload         jsonb           NOT NULL,
    correlation_id  text,
    request_id      text,
    -- Optional request metadata, collected only where justified
    -- (EVENT_MODEL.md §4).
    ip              inet,
    user_agent      text,
    recorded_at     timestamptz     NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_events IS
    'Immutable who/what/when security and operations facts (EVENT_MODEL.md §4).';

CREATE INDEX audit_events_tenant_time_idx
    ON audit_events (tenant_id, occurred_at DESC);
CREATE INDEX audit_events_target_idx
    ON audit_events (tenant_id, target_type, target_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx
    ON audit_events (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX audit_events_correlation_idx
    ON audit_events (correlation_id)
    WHERE correlation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Append-only enforcement (EVENT_MODEL.md §1, §10 bullet 1)
-- ---------------------------------------------------------------------------

CREATE FUNCTION suas_reject_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'Event stores are append-only; % on % is rejected (SUAS-specs EVENT_MODEL.md 1, 5).',
        TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER domain_events_append_only
    BEFORE UPDATE OR DELETE ON domain_events
    FOR EACH ROW EXECUTE FUNCTION suas_reject_event_mutation();

CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION suas_reject_event_mutation();

-- ---------------------------------------------------------------------------
-- Outbox (DATA_MODEL.md §11; EVENT_MODEL.md §5.3; ARCHITECTURE.md §8)
-- ---------------------------------------------------------------------------
--
-- Physical mechanism for replay-safe publication. A row is written in the same
-- transaction as the Domain Event, so a required event cannot be permanently
-- lost after domain commit. This table is mutable by design: publication state
-- is infrastructure, not business meaning.

CREATE TABLE event_outbox (
    outbox_id     bigserial          PRIMARY KEY,
    event_id      uuid               NOT NULL UNIQUE REFERENCES domain_events (event_id),
    tenant_id     uuid               NOT NULL,
    status        suas_outbox_status NOT NULL DEFAULT 'PENDING',
    attempts      integer            NOT NULL DEFAULT 0,
    max_attempts  integer            NOT NULL,
    available_at  timestamptz        NOT NULL DEFAULT now(),
    published_at  timestamptz,
    last_error    text,
    created_at    timestamptz        NOT NULL DEFAULT now(),
    updated_at    timestamptz        NOT NULL DEFAULT now()
);

-- Worker pickup path: due, unpublished work in creation order.
CREATE INDEX event_outbox_pending_idx
    ON event_outbox (available_at, outbox_id)
    WHERE status = 'PENDING';

-- Operational visibility for failed work (ARCHITECTURE.md §8 DLQ/visibility).
CREATE INDEX event_outbox_dead_letter_idx
    ON event_outbox (updated_at DESC)
    WHERE status = 'DEAD_LETTER';

-- ---------------------------------------------------------------------------
-- Consumer delivery dedupe (EVENT_MODEL.md §5.4, §10 bullet 4)
-- ---------------------------------------------------------------------------
--
-- Delivery is at-least-once, so consumers must be idempotent. This table gives
-- a consumer a durable record of the events it has already applied, so a
-- duplicate delivery produces one logical downstream effect.

CREATE TABLE processed_events (
    consumer_name text        NOT NULL,
    event_id      uuid        NOT NULL REFERENCES domain_events (event_id),
    tenant_id     uuid        NOT NULL,
    processed_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer_name, event_id)
);

-- ---------------------------------------------------------------------------
-- Command idempotency (DATA_MODEL.md §10; API.md §7; ARCHITECTURE.md §5.17)
-- ---------------------------------------------------------------------------

CREATE TABLE command_idempotency_records (
    command_idempotency_id uuid                          PRIMARY KEY,
    tenant_id              uuid                          NOT NULL,
    -- API.md §7.2: scope is tenant + logical command/route + actor/aggregate
    -- context as appropriate. The caller composes the scope string.
    command_scope          text                          NOT NULL,
    idempotency_key        text                          NOT NULL,
    -- Canonical request fingerprint; a conflicting reuse of the same key is
    -- detected by comparing this value (API.md §7.4).
    request_fingerprint    text                          NOT NULL,
    state                  suas_command_idempotency_state NOT NULL,
    -- Bounded authoritative outcome replayed to a duplicate request.
    result                 jsonb,
    -- Links to the aggregate and event this command produced (DATA_MODEL.md §10).
    aggregate_type         text,
    aggregate_id           uuid,
    event_id               uuid                          REFERENCES domain_events (event_id),
    attempts               integer                       NOT NULL DEFAULT 1,
    last_error             text,
    created_at             timestamptz                   NOT NULL DEFAULT now(),
    updated_at             timestamptz                   NOT NULL DEFAULT now(),
    completed_at           timestamptz,
    -- Retention window. D-007 remains DECISION_PENDING, so nothing purges on
    -- this column yet; it exists so a released retention policy has a home.
    expires_at             timestamptz
);

COMMENT ON TABLE command_idempotency_records IS
    'Persistent logical idempotency for unsafe commands. Survives restart and '
    'horizontal instances (ARCHITECTURE.md 5.17). Supplements, and does not '
    'replace, domain uniqueness or FulfillmentAttempt idempotency.';

-- DATA_MODEL.md §10: unique logical key in scope.
CREATE UNIQUE INDEX command_idempotency_records_logical_key
    ON command_idempotency_records (tenant_id, command_scope, idempotency_key);

CREATE INDEX command_idempotency_records_state_idx
    ON command_idempotency_records (state, updated_at DESC);
