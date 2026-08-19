-- 0005_coordination.sql — Support Cases, assignments, contact log, Service Requests
--
-- Released contract implemented:
-- - SUAS-specs CASES.md §2 (states), §3 (creation and the atomic one-active-case
--   invariant), §4 (transitions), §5 (atomic assignment and claim), §7
--   (resolution and closure), §9 (queue access paths).
-- - SUAS-specs DISPATCH.md §2 (states), §4 (transitions), §7 (categories).
-- - SUAS-specs RESPONDER_WORKFLOWS.md §2 (named actions), §7 (contact log).
-- - SUAS-specs DOMAIN_MODEL.md §5; DATA_MODEL.md §6, §7, §13, §14 rules 1, 6.
--
-- Retention remains D-007 DECISION_PENDING: nothing purges, and CASES.md §7
-- requires closure to retain all history.
--
-- Destructive-change note (ENVIRONMENT.md §9): additive only; no destructive step.

-- ---------------------------------------------------------------------------
-- Lifecycles
-- ---------------------------------------------------------------------------

-- CASES.md §2. Exactly these; §10 forbids hidden state values.
CREATE TYPE suas_case_status AS ENUM (
    'OPEN',
    'TRIAGED',
    'ASSIGNED',
    'ACTIVE',
    'FOLLOWUP',
    'RESOLVED',
    'CLOSED'
);

-- DOMAIN_MODEL.md §5 "CaseAssignment".
CREATE TYPE suas_case_assignment_status AS ENUM ('ACTIVE', 'RELEASED', 'REASSIGNED');

-- DISPATCH.md §2. Happy path plus exception states. Provider integration
-- statuses are deliberately absent: they belong to Fulfillment Attempt state.
CREATE TYPE suas_service_request_status AS ENUM (
    'CREATED',
    'SUBMITTED',
    'TRIAGED',
    'MATCHING',
    'ASSIGNED',
    'ACCEPTED',
    'IN_PROGRESS',
    'FULFILLED',
    'CONFIRMED',
    'CLOSED',
    'CANCELLED',
    'DECLINED',
    'EXPIRED',
    'UNFULFILLABLE',
    'ESCALATED'
);

-- DISPATCH.md §7. MVP categories only; reserved future codes are not values here,
-- so an unknown category cannot be stored.
CREATE TYPE suas_service_category AS ENUM ('FOOD', 'TRANSPORTATION', 'SHELTER', 'PEER_SUPPORT');

-- EVENT_MODEL.md §3.3 `RESPONDER_CONTACT_LOGGED` payload contract.
CREATE TYPE suas_contact_channel AS ENUM ('EMAIL', 'SMS', 'IN_APP', 'PHONE');

CREATE TYPE suas_contact_outcome AS ENUM (
    'PENDING',
    'REACHED',
    'NO_ANSWER',
    'LEFT_MESSAGE',
    'DECLINED',
    'UNABLE'
);

-- Support Signal levels, used here only as a queue priority label.
-- Signal computation is SPEC017_PLAN.md Slice 9; nothing in this migration
-- computes or infers a level.
CREATE TYPE suas_signal_level AS ENUM ('GREEN', 'YELLOW', 'ORANGE', 'RED');

-- ---------------------------------------------------------------------------
-- Support Cases (CASES.md §1-§3; DOMAIN_MODEL.md §5)
-- ---------------------------------------------------------------------------

CREATE TABLE support_cases (
    case_id               uuid             PRIMARY KEY,
    tenant_id             uuid             NOT NULL,
    veteran_user_id       uuid             NOT NULL,
    status                suas_case_status NOT NULL DEFAULT 'OPEN',
    -- Queue ordering label only (RESPONDER_WORKFLOWS.md §4). Never computed here.
    priority_signal_level suas_signal_level,
    created_at            timestamptz      NOT NULL DEFAULT now(),
    updated_at            timestamptz      NOT NULL DEFAULT now(),
    triaged_at            timestamptz,
    resolved_at           timestamptz,
    closed_at             timestamptz,

    FOREIGN KEY (veteran_user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    UNIQUE (case_id, tenant_id)
);

-- CASES.md §3.1: the MVP one-active-case default, enforced by the database so
-- concurrent or replayed creation resolves to one winning non-closed Case
-- instead of relying on "read no case → insert".
CREATE UNIQUE INDEX support_cases_one_active_per_veteran
    ON support_cases (tenant_id, veteran_user_id)
    WHERE status <> 'CLOSED';

-- CASES.md §9 / RESPONDER_WORKFLOWS.md §4: queue paths are tenant + status +
-- priority, and must never scan another tenant.
CREATE INDEX support_cases_queue_idx
    ON support_cases (tenant_id, status, priority_signal_level, created_at DESC);
CREATE INDEX support_cases_veteran_idx ON support_cases (tenant_id, veteran_user_id);

-- ---------------------------------------------------------------------------
-- Case assignments (CASES.md §5; DOMAIN_MODEL.md §5)
-- ---------------------------------------------------------------------------

CREATE TABLE case_assignments (
    case_assignment_id uuid                        PRIMARY KEY,
    tenant_id          uuid                        NOT NULL,
    case_id            uuid                        NOT NULL,
    responder_user_id  uuid                        NOT NULL,
    status             suas_case_assignment_status NOT NULL DEFAULT 'ACTIVE',
    assigned_at        timestamptz                 NOT NULL DEFAULT now(),
    assigned_by        uuid                        REFERENCES users (user_id),
    released_at        timestamptz,
    release_reason     text,

    FOREIGN KEY (case_id, tenant_id) REFERENCES support_cases (case_id, tenant_id),
    FOREIGN KEY (responder_user_id, tenant_id) REFERENCES users (user_id, tenant_id)
);

-- CASES.md §5.3 / DATA_MODEL.md §14 rule 6: at most one active exclusive owner.
-- Two concurrent claims cannot both win.
CREATE UNIQUE INDEX case_assignments_one_active_per_case
    ON case_assignments (case_id)
    WHERE status = 'ACTIVE';

CREATE INDEX case_assignments_responder_idx
    ON case_assignments (tenant_id, responder_user_id, status);
CREATE INDEX case_assignments_history_idx ON case_assignments (case_id, assigned_at DESC);

-- ---------------------------------------------------------------------------
-- Case notes (CASES.md §6; RESPONDER_WORKFLOWS.md §2 `ADD_NOTE`)
-- ---------------------------------------------------------------------------
--
-- A Case Note is not a transition, a Follow-Up, or a Contact Attempt, and it
-- never emits RESPONDER_CONTACT_LOGGED (EVENT_MODEL.md §3.3).

CREATE TABLE case_notes (
    case_note_id   uuid        PRIMARY KEY,
    tenant_id      uuid        NOT NULL,
    case_id        uuid        NOT NULL,
    author_user_id uuid        NOT NULL,
    -- Sensitive free text: access-logged, never written to application logs
    -- (PRIVACY.md §3), and excluded from provider projections (PRIVACY.md §4.2).
    body           text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (case_id, tenant_id) REFERENCES support_cases (case_id, tenant_id),
    FOREIGN KEY (author_user_id, tenant_id) REFERENCES users (user_id, tenant_id)
);

CREATE INDEX case_notes_case_idx ON case_notes (case_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Contact attempts (RESPONDER_WORKFLOWS.md §7; EVENT_MODEL.md §3.3)
-- ---------------------------------------------------------------------------

CREATE TABLE contact_attempts (
    contact_attempt_id uuid                  PRIMARY KEY,
    tenant_id          uuid                  NOT NULL,
    case_id            uuid                  NOT NULL,
    responder_user_id  uuid                  NOT NULL,
    -- Contact timestamp, distinct from when the row was written.
    attempted_at       timestamptz           NOT NULL,
    channel            suas_contact_channel  NOT NULL,
    outcome            suas_contact_outcome  NOT NULL,
    note               text,
    created_at         timestamptz           NOT NULL DEFAULT now(),

    FOREIGN KEY (case_id, tenant_id) REFERENCES support_cases (case_id, tenant_id),
    FOREIGN KEY (responder_user_id, tenant_id) REFERENCES users (user_id, tenant_id)
);

CREATE INDEX contact_attempts_case_idx ON contact_attempts (case_id, attempted_at DESC);

-- ---------------------------------------------------------------------------
-- Service Requests (DISPATCH.md §1-§4, §7; DOMAIN_MODEL.md §5)
-- ---------------------------------------------------------------------------

CREATE TABLE service_requests (
    service_request_id uuid                        PRIMARY KEY,
    tenant_id          uuid                        NOT NULL,
    case_id            uuid                        NOT NULL,
    category           suas_service_category       NOT NULL,
    status             suas_service_request_status NOT NULL DEFAULT 'CREATED',
    -- Bounded request detail. Not a dumping ground for case context.
    details            jsonb                       NOT NULL DEFAULT '{}'::jsonb,
    created_by         uuid                        NOT NULL,
    created_at         timestamptz                 NOT NULL DEFAULT now(),
    updated_at         timestamptz                 NOT NULL DEFAULT now(),
    submitted_at       timestamptz,
    terminal_at        timestamptz,
    -- Reason recorded for the exception transitions that require one.
    status_reason      text,

    FOREIGN KEY (case_id, tenant_id) REFERENCES support_cases (case_id, tenant_id),
    FOREIGN KEY (created_by, tenant_id) REFERENCES users (user_id, tenant_id),
    UNIQUE (service_request_id, tenant_id)
);

-- DATA_MODEL.md §13: tenant + status request queries, and a case's children.
CREATE INDEX service_requests_case_idx ON service_requests (case_id, created_at DESC);
CREATE INDEX service_requests_queue_idx
    ON service_requests (tenant_id, status, category, created_at DESC);
