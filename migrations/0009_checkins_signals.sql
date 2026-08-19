-- 0009_checkins_signals.sql — questionnaires, Check-Ins, and Support Signals
--
-- Released contract implemented:
-- - SUAS-specs CHECKINS.md §2 (entities), §3 (dimensions), §4 (states), §4.5
--   (questionnaire migration), §5 (publication), §6 (completion and signal
--   trigger), §7 (events and audit).
-- - SUAS-specs SUPPORT_SIGNALS.md §1 (values), §3 (computation identity), §4
--   (recorded fields), §5 (settlement), §6 (historical integrity), §7 (override).
-- - SUAS-specs DATA_MODEL.md §3 (questionnaire/Check-In), §4 (support signals),
--   §14 rules 2 and 5.
--
-- Exact questions, option weights, and thresholds are `NOT_COMPUTABLE` until a
-- QuestionnaireVersion is published (CHECKINS.md §3) and D-011 closes
-- (SUPPORT_SIGNALS.md §2). This migration therefore ships no questionnaire
-- content and no scoring data — only the structures that hold them.
--
-- Destructive-change note (ENVIRONMENT.md §9): additive only.

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------

-- CHECKINS.md §5; DOMAIN_MODEL.md §3.
CREATE TYPE suas_questionnaire_status AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CHECKINS.md §3. A published version may include questions in these dimensions.
CREATE TYPE suas_question_dimension AS ENUM (
    'sleep',
    'connection',
    'stress',
    'basic_needs',
    'coping',
    'safety'
);

-- CHECKINS.md §4.
CREATE TYPE suas_check_in_status AS ENUM (
    'STARTED',
    'IN_PROGRESS',
    'COMPLETED',
    'ABANDONED',
    'INCOMPLETE'
);

-- SUPPORT_SIGNALS.md §3: a primary calculation and an override are different
-- computation kinds, and an override is never a primary recomputation.
CREATE TYPE suas_signal_computation_kind AS ENUM ('PRIMARY', 'OVERRIDE');

-- SUPPORT_SIGNALS.md §3: a Check-In-derived signal versus an explicit need.
CREATE TYPE suas_signal_source_type AS ENUM ('CHECK_IN', 'EXPLICIT_NEED');

-- ---------------------------------------------------------------------------
-- Questionnaire versions (CHECKINS.md §2, §5; DATA_MODEL.md §3)
-- ---------------------------------------------------------------------------

CREATE TABLE questionnaire_versions (
    -- Textual version key (`qv-*`), per CHECKINS.md §2 and DATA_MODEL.md §1.
    questionnaire_version text                      PRIMARY KEY,
    tenant_id             uuid,
    status                suas_questionnaire_status NOT NULL DEFAULT 'DRAFT',
    title                 text                      NOT NULL,
    created_at            timestamptz               NOT NULL DEFAULT now(),
    published_at          timestamptz,
    published_by          uuid                      REFERENCES users (user_id),
    superseded_at         timestamptz
);

COMMENT ON TABLE questionnaire_versions IS
    'Published versions are immutable and become visible atomically as a complete '
    'version (CHECKINS.md 5; DATA_MODEL.md 14 rule 2).';

-- CHECKINS.md §4.5: a new Check-In resolves to the current PUBLISHED version.
-- At most one may be published at a time per tenant scope.
CREATE UNIQUE INDEX questionnaire_versions_one_published
    ON questionnaire_versions ((COALESCE(tenant_id::text, 'global')))
    WHERE status = 'PUBLISHED';

CREATE TABLE questions (
    question_id           uuid                    PRIMARY KEY,
    questionnaire_version text                    NOT NULL
        REFERENCES questionnaire_versions (questionnaire_version),
    -- Stable key within the version, so a signal basis can reference an answer
    -- without duplicating question text.
    question_key          text                    NOT NULL,
    prompt                text                    NOT NULL,
    dimension             suas_question_dimension,
    required              boolean                 NOT NULL DEFAULT false,
    display_order         integer                 NOT NULL DEFAULT 0,

    UNIQUE (questionnaire_version, question_key)
);

CREATE TABLE answer_options (
    answer_option_id uuid    PRIMARY KEY,
    question_id      uuid    NOT NULL REFERENCES questions (question_id),
    option_key       text    NOT NULL,
    label            text    NOT NULL,
    display_order    integer NOT NULL DEFAULT 0,

    -- Deliberately no `weight` column. CHECKINS.md §3 marks option weights
    -- NOT_COMPUTABLE until a version is published, and SUPPORT_SIGNALS.md §2
    -- forbids shipping invented weights or thresholds. A released scoring
    -- contract adds this in its own migration.
    UNIQUE (question_id, option_key)
);

-- ---------------------------------------------------------------------------
-- Check-Ins (CHECKINS.md §4; DATA_MODEL.md §3)
-- ---------------------------------------------------------------------------

CREATE TABLE check_ins (
    check_in_id           uuid                 PRIMARY KEY,
    tenant_id             uuid                 NOT NULL,
    veteran_user_id       uuid                 NOT NULL,
    -- CHECKINS.md §4.5: historical rows retain their original version.
    questionnaire_version text                 NOT NULL
        REFERENCES questionnaire_versions (questionnaire_version),
    status                suas_check_in_status NOT NULL DEFAULT 'STARTED',
    -- CHECKINS.md §4.4: server-authoritative timing. Client clocks may be
    -- recorded as non-authoritative metadata but never determine ordering.
    started_at            timestamptz          NOT NULL DEFAULT now(),
    completed_at          timestamptz,
    abandoned_at          timestamptz,
    updated_at            timestamptz          NOT NULL DEFAULT now(),

    FOREIGN KEY (veteran_user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    UNIQUE (check_in_id, tenant_id)
);

CREATE INDEX check_ins_veteran_idx
    ON check_ins (tenant_id, veteran_user_id, started_at DESC);
CREATE INDEX check_ins_status_idx ON check_ins (tenant_id, status);

CREATE TABLE check_in_responses (
    check_in_response_id uuid        PRIMARY KEY,
    check_in_id          uuid        NOT NULL REFERENCES check_ins (check_in_id),
    question_id          uuid        NOT NULL REFERENCES questions (question_id),
    answer_option_id     uuid        REFERENCES answer_options (answer_option_id),
    -- Sensitive free text (PRIVACY.md §3): access-logged, never in app logs, and
    -- excluded from provider projections.
    free_text            text,
    answered_at          timestamptz NOT NULL DEFAULT now(),

    -- One answer per question per attempt; a correction is a new Check-In
    -- (CHECKINS.md §4.3).
    UNIQUE (check_in_id, question_id)
);

-- ---------------------------------------------------------------------------
-- Check-In immutability after completion (CHECKINS.md §4.3)
-- ---------------------------------------------------------------------------
--
-- "Completed Check-Ins are not silently rewritten. A veteran correction creates a
-- new Check-In. Responders cannot edit veteran answers."

CREATE FUNCTION suas_reject_completed_check_in_edit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    parent_status suas_check_in_status;
BEGIN
    SELECT status INTO parent_status FROM check_ins
     WHERE check_in_id = COALESCE(NEW.check_in_id, OLD.check_in_id);

    IF parent_status IN ('COMPLETED', 'ABANDONED', 'INCOMPLETE') THEN
        RAISE EXCEPTION
            'Responses on a settled Check-In cannot be changed; a correction creates a new '
            'Check-In (SUAS-specs CHECKINS.md 4.3).'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER check_in_responses_immutable_after_completion
    BEFORE INSERT OR UPDATE OR DELETE ON check_in_responses
    FOR EACH ROW EXECUTE FUNCTION suas_reject_completed_check_in_edit();

-- ---------------------------------------------------------------------------
-- Support Signals (SUPPORT_SIGNALS.md §3-§7; DATA_MODEL.md §4)
-- ---------------------------------------------------------------------------

CREATE TABLE support_signals (
    support_signal_id       uuid                         PRIMARY KEY,
    tenant_id               uuid                         NOT NULL,
    veteran_user_id         uuid                         NOT NULL,
    computation_kind        suas_signal_computation_kind NOT NULL,
    source_type             suas_signal_source_type      NOT NULL,
    check_in_id             uuid                         REFERENCES check_ins (check_in_id),
    -- SUPPORT_SIGNALS.md §3: an explicit need cannot use a null check_in_id as
    -- its identity, so it carries a stable source reference instead.
    source_reference        text,
    level                   suas_signal_level            NOT NULL,
    signal_version          text                         NOT NULL,
    input_questionnaire_version text,
    -- §2: inspectable basis recording canonical inputs and rules used, without
    -- duplicating sensitive payload.
    basis                   jsonb                        NOT NULL DEFAULT '{}'::jsonb,
    computed_at             timestamptz                  NOT NULL DEFAULT now(),
    -- §3: the derived computation identity for a primary calculation.
    computation_key         text,
    -- §7: override linkage.
    override_of_signal_id   uuid                         REFERENCES support_signals (support_signal_id),
    override_actor_id       uuid                         REFERENCES users (user_id),
    override_reason         text,

    FOREIGN KEY (veteran_user_id, tenant_id) REFERENCES users (user_id, tenant_id),

    -- §3.4 and §7: an override is a distinct row that links to what it overrides
    -- and carries an actor and reason.
    CONSTRAINT support_signals_override_shape CHECK (
        (computation_kind = 'PRIMARY'
         AND override_of_signal_id IS NULL
         AND override_actor_id IS NULL
         AND computation_key IS NOT NULL)
        OR
        (computation_kind = 'OVERRIDE'
         AND override_of_signal_id IS NOT NULL
         AND override_actor_id IS NOT NULL
         AND override_reason IS NOT NULL)
    ),

    -- §3: a Check-In-derived signal has a check_in_id; an explicit need has a
    -- stable source reference. Neither may be identity-less.
    CONSTRAINT support_signals_source_identity CHECK (
        (source_type = 'CHECK_IN' AND check_in_id IS NOT NULL)
        OR (source_type = 'EXPLICIT_NEED' AND source_reference IS NOT NULL)
    )
);

-- SUPPORT_SIGNALS.md §3.2 and DATA_MODEL.md §14 rule 5: concurrent workers
-- cannot create two authoritative primary rows for one computation identity.
CREATE UNIQUE INDEX support_signals_primary_computation_key
    ON support_signals (tenant_id, computation_key)
    WHERE computation_kind = 'PRIMARY';

-- Effective-signal projection path and history reads.
CREATE INDEX support_signals_veteran_idx
    ON support_signals (tenant_id, veteran_user_id, computed_at DESC, support_signal_id DESC);
CREATE INDEX support_signals_check_in_idx ON support_signals (check_in_id)
    WHERE check_in_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Support Signal immutability (SUPPORT_SIGNALS.md §6)
-- ---------------------------------------------------------------------------
--
-- "No silent mutation of historical calculations." An override writes a new row;
-- the original computed signal remains immutable.

CREATE TRIGGER support_signals_append_only
    BEFORE UPDATE OR DELETE ON support_signals
    FOR EACH ROW EXECUTE FUNCTION suas_reject_event_mutation();
