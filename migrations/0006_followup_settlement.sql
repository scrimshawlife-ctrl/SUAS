-- 0006_followup_settlement.sql — Follow-Ups and multi-cycle Settlement history
--
-- Released contract implemented:
-- - SUAS-specs FOLLOWUP.md §2 (states), §3 (core fields), §4 (coordination retry
--   semantics), §5 (durable due/overdue jobs and schedule versioning), §6
--   (completion, reschedule, cancellation), §8 (Case interaction).
-- - SUAS-specs SETTLEMENT.md §2 (required content), §3 (resolution-cycle
--   history), §4 (blocking vs carried-forward Follow-Up), §5 (validation and
--   idempotency), §8 (events/audit), §9 (non-goals).
-- - SUAS-specs DATA_MODEL.md §6 follow_ups, §8 settlements, §14.
--
-- SETTLEMENT.md §9 forbids overwriting a prior Settlement on reopen, so history
-- is a table of cycles rather than one mutable row. Retention remains D-007
-- DECISION_PENDING and nothing purges.
--
-- Destructive-change note (ENVIRONMENT.md §9): additive only. The one change to
-- an existing table adds a nullable column.

-- ---------------------------------------------------------------------------
-- Follow-Up lifecycle (FOLLOWUP.md §2; DATA_MODEL.md §6)
-- ---------------------------------------------------------------------------

CREATE TYPE suas_follow_up_status AS ENUM (
    'SCHEDULED',
    'DUE',
    'COMPLETED',
    'RESCHEDULED',
    'OVERDUE',
    'ESCALATED',
    'CANCELLED'
);

-- FOLLOWUP.md §3 requires responsible_type/responsible_id but does not enumerate
-- the types. These are the actors §0 names; the enumeration is returned to specs.
CREATE TYPE suas_responsible_type AS ENUM ('RESPONDER', 'VETERAN', 'ORG_ADMIN', 'SYSTEM');

-- SETTLEMENT.md §4 / DATA_MODEL.md §6: a first-class, queryable classification.
-- FOLLOWUP.md §10 forbids deriving it from note text, and SETTLEMENT.md §4
-- forbids resolving with an unclassified open Follow-Up — which is why this is
-- nullable: NULL means "not yet classified", and resolution refuses it.
CREATE TYPE suas_resolution_disposition AS ENUM ('BLOCKING', 'CARRIED_FORWARD');

CREATE TABLE follow_ups (
    follow_up_id             uuid                        PRIMARY KEY,
    tenant_id                uuid                        NOT NULL,
    case_id                  uuid                        NOT NULL,
    service_request_id       uuid,
    due_at                   timestamptz                 NOT NULL,
    -- FOLLOWUP.md §5.7: a reschedule invalidates old due-work identities, so a
    -- job carries the version it expects and a stale one cannot mutate.
    schedule_version         integer                     NOT NULL DEFAULT 1,
    responsible_type         suas_responsible_type       NOT NULL,
    responsible_id           text                        NOT NULL,
    status                   suas_follow_up_status       NOT NULL DEFAULT 'SCHEDULED',
    -- FOLLOWUP.md §4: coordination attempts only. Notification and job retries
    -- are deliberately not counted here.
    coordination_attempt_count integer                   NOT NULL DEFAULT 0,
    resolution_disposition   suas_resolution_disposition,
    created_at               timestamptz                 NOT NULL DEFAULT now(),
    updated_at               timestamptz                 NOT NULL DEFAULT now(),
    due_marked_at            timestamptz,
    overdue_marked_at        timestamptz,
    completed_at             timestamptz,
    completed_by             uuid,
    cancelled_at             timestamptz,
    cancel_reason            text,
    last_reschedule_reason   text,

    FOREIGN KEY (case_id, tenant_id) REFERENCES support_cases (case_id, tenant_id),
    FOREIGN KEY (service_request_id, tenant_id)
        REFERENCES service_requests (service_request_id, tenant_id),
    CHECK (schedule_version > 0)
);

-- FOLLOWUP.md §5: durable due/overdue pickup, bounded by tenant and due time.
CREATE INDEX follow_ups_due_pickup_idx
    ON follow_ups (due_at, follow_up_id)
    WHERE status IN ('SCHEDULED', 'DUE');

CREATE INDEX follow_ups_case_idx ON follow_ups (case_id, status);
CREATE INDEX follow_ups_responsible_idx
    ON follow_ups (tenant_id, responsible_type, responsible_id, status);

-- ---------------------------------------------------------------------------
-- Settlements (SETTLEMENT.md §2-§3; DATA_MODEL.md §8)
-- ---------------------------------------------------------------------------

CREATE TABLE settlements (
    settlement_id           uuid        PRIMARY KEY,
    tenant_id               uuid        NOT NULL,
    case_id                 uuid        NOT NULL,
    -- SETTLEMENT.md §3.2: reopen starts a new cycle; resolving it creates a new
    -- Settlement. Case-local and monotonic.
    resolution_cycle        integer     NOT NULL,
    -- SETTLEMENT.md §2: the four required summaries. §2 also says a Settlement
    -- should reference canonical records rather than duplicate whole notes or
    -- provider payloads, so these hold references and short statements.
    requested_summary       jsonb       NOT NULL,
    occurred_summary        jsonb       NOT NULL,
    fulfilled_summary       jsonb       NOT NULL,
    unresolved_summary      jsonb       NOT NULL,
    -- Explicit carried-forward responsibilities with owner and due date.
    remaining_follow_ups    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- SETTLEMENT.md §2: responder confirmation required, veteran optional.
    responder_confirmed_by  uuid        NOT NULL,
    responder_confirmed_at  timestamptz NOT NULL DEFAULT now(),
    veteran_confirmed_by    uuid,
    veteran_confirmed_at    timestamptz,
    -- Accountable human author (SETTLEMENT.md §2; §5.6 forbids autonomous
    -- generative authorship).
    authored_by             uuid        NOT NULL,
    settled_at              timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (case_id, tenant_id) REFERENCES support_cases (case_id, tenant_id),
    FOREIGN KEY (responder_confirmed_by, tenant_id) REFERENCES users (user_id, tenant_id),
    FOREIGN KEY (authored_by, tenant_id) REFERENCES users (user_id, tenant_id),

    -- DATA_MODEL.md §8: unique Case + resolution cycle.
    UNIQUE (case_id, resolution_cycle),
    CHECK (resolution_cycle > 0)
);

COMMENT ON TABLE settlements IS
    'One durable record per resolution cycle. A reopen never overwrites a prior '
    'Settlement (SETTLEMENT.md 3, 9).';

-- Deterministic latest-cycle projection, not an insertion-order scan
-- (SETTLEMENT.md §3.6).
CREATE INDEX settlements_case_cycle_idx ON settlements (case_id, resolution_cycle DESC);

-- ---------------------------------------------------------------------------
-- Case pointer to the current Settlement
-- ---------------------------------------------------------------------------
--
-- DATA_MODEL.md §6/§8: `support_cases.current_settlement_id` may cache the
-- current/latest Settlement "without replacing history". It is a convenience
-- projection; the settlements table remains the record.

ALTER TABLE support_cases
    ADD COLUMN current_settlement_id uuid REFERENCES settlements (settlement_id);

-- ---------------------------------------------------------------------------
-- Immutability of settled history
-- ---------------------------------------------------------------------------
--
-- SETTLEMENT.md §8: "Historical Settlement rows are not mutated to represent a
-- later resolution cycle." The trigger permits adding a veteran confirmation to
-- an existing Settlement — SETTLEMENT.md §2 makes that optional and later — but
-- refuses any change to the resolution meaning itself.

CREATE FUNCTION suas_reject_settlement_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Settlement history cannot be deleted (SUAS-specs SETTLEMENT.md 3, 9).'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.settlement_id     IS DISTINCT FROM OLD.settlement_id
       OR NEW.case_id            IS DISTINCT FROM OLD.case_id
       OR NEW.resolution_cycle   IS DISTINCT FROM OLD.resolution_cycle
       OR NEW.requested_summary  IS DISTINCT FROM OLD.requested_summary
       OR NEW.occurred_summary   IS DISTINCT FROM OLD.occurred_summary
       OR NEW.fulfilled_summary  IS DISTINCT FROM OLD.fulfilled_summary
       OR NEW.unresolved_summary IS DISTINCT FROM OLD.unresolved_summary
       OR NEW.remaining_follow_ups IS DISTINCT FROM OLD.remaining_follow_ups
       OR NEW.responder_confirmed_by IS DISTINCT FROM OLD.responder_confirmed_by
       OR NEW.authored_by        IS DISTINCT FROM OLD.authored_by
       OR NEW.settled_at         IS DISTINCT FROM OLD.settled_at
    THEN
        RAISE EXCEPTION
            'A committed Settlement cannot be rewritten (SUAS-specs SETTLEMENT.md 3, 8).'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER settlements_immutable
    BEFORE UPDATE OR DELETE ON settlements
    FOR EACH ROW EXECUTE FUNCTION suas_reject_settlement_rewrite();
