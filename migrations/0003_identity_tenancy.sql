-- 0003_identity_tenancy.sql — users, organizations, memberships, auth, sessions
--
-- Released contract implemented:
-- - SUAS-specs DOMAIN_MODEL.md §2 (User, Organization, OrganizationMembership
--   lifecycles and required fields).
-- - SUAS-specs DATA_MODEL.md §2 (identity, authentication, organization),
--   §13 (required access paths), §14 rules 1, 3, 4.
-- - SUAS-specs AUTH.md §3 (challenge contract), §5 (session model), §6
--   (membership/role inputs).
-- - SUAS-specs SECURITY.md §2 (tenant isolation, RBAC, sessions, rate limits,
--   secrets, soft-delete).
--
-- Retention remains D-007 DECISION_PENDING, so nothing here purges
-- (SECURITY.md §2 "Retention"). Deletion is soft-delete only.
--
-- Destructive-change note (ENVIRONMENT.md §9): additive only; no destructive step.

-- ---------------------------------------------------------------------------
-- Lifecycles (DOMAIN_MODEL.md §2)
-- ---------------------------------------------------------------------------

CREATE TYPE suas_user_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');

CREATE TYPE suas_organization_status AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- AUTH.md §6: org-scoped roles. Global SUAS_ADMIN is deliberately absent here.
CREATE TYPE suas_membership_role AS ENUM ('RESPONDER', 'ORG_ADMIN', 'SERVICE_PROVIDER_USER');

CREATE TYPE suas_membership_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');

CREATE TYPE suas_auth_challenge_method AS ENUM ('MAGIC_LINK', 'EMAIL_OTP', 'PHONE_OTP');

CREATE TYPE suas_auth_challenge_status AS ENUM ('ISSUED', 'CONSUMED', 'EXPIRED', 'REVOKED');

CREATE TYPE suas_admin_grant_status AS ENUM ('ACTIVE', 'REVOKED');

-- ---------------------------------------------------------------------------
-- Users (DOMAIN_MODEL.md §2 "User"; DATA_MODEL.md §2 "users")
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    user_id    uuid             PRIMARY KEY,
    tenant_id  uuid             NOT NULL,
    status     suas_user_status NOT NULL DEFAULT 'INVITED',
    email      text,
    phone      text,
    created_at timestamptz      NOT NULL DEFAULT now(),
    updated_at timestamptz      NOT NULL DEFAULT now(),
    -- SECURITY.md §2 "Deletion": soft-delete plus process; historical actor ids
    -- remain resolvable (DOMAIN_MODEL.md §2).
    deleted_at timestamptz,

    -- Referenced by the composite foreign keys below, which is how tenant
    -- consistency across related rows becomes a database guarantee rather than
    -- an application convention (DATA_MODEL.md §14 rule 1).
    UNIQUE (user_id, tenant_id)
);

-- Contact identifiers are unique within a tenant, not globally: the same person
-- may exist in more than one tenant. Case-insensitive so address casing cannot
-- create a second account.
CREATE UNIQUE INDEX users_tenant_email_key
    ON users (tenant_id, lower(email))
    WHERE email IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX users_tenant_phone_key
    ON users (tenant_id, phone)
    WHERE phone IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX users_tenant_status_idx ON users (tenant_id, status);

-- ---------------------------------------------------------------------------
-- Organizations (DOMAIN_MODEL.md §2 "Organization")
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
    organization_id uuid                    PRIMARY KEY,
    tenant_id       uuid                    NOT NULL,
    name            text                    NOT NULL,
    status          suas_organization_status NOT NULL DEFAULT 'PENDING',
    created_at      timestamptz             NOT NULL DEFAULT now(),
    updated_at      timestamptz             NOT NULL DEFAULT now(),

    UNIQUE (organization_id, tenant_id)
);

CREATE INDEX organizations_tenant_status_idx ON organizations (tenant_id, status);

-- ---------------------------------------------------------------------------
-- Memberships (DOMAIN_MODEL.md §2; AUTH.md §6)
-- ---------------------------------------------------------------------------

CREATE TABLE organization_memberships (
    membership_id   uuid                   PRIMARY KEY,
    tenant_id       uuid                   NOT NULL,
    user_id         uuid                   NOT NULL,
    organization_id uuid                   NOT NULL,
    role            suas_membership_role   NOT NULL,
    status          suas_membership_status NOT NULL DEFAULT 'INVITED',
    created_at      timestamptz            NOT NULL DEFAULT now(),
    updated_at      timestamptz            NOT NULL DEFAULT now(),
    revoked_at      timestamptz,

    -- Tenant consistency is enforced by the database: a membership cannot link a
    -- user and an organization from different tenants (DATA_MODEL.md §14 rule 1).
    FOREIGN KEY (user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    FOREIGN KEY (organization_id, tenant_id)
        REFERENCES organizations (organization_id, tenant_id),

    -- One membership per user per organization; role changes update it in place
    -- rather than creating a competing second membership.
    UNIQUE (user_id, organization_id)
);

CREATE INDEX organization_memberships_org_status_idx
    ON organization_memberships (organization_id, status, role);
CREATE INDEX organization_memberships_user_idx
    ON organization_memberships (user_id, status);

-- ---------------------------------------------------------------------------
-- SUAS System Administrator grants
-- ---------------------------------------------------------------------------
--
-- AUTH.md §6 and ONBOARDING.md §49: SUAS-admin is globally bound, not org-bound,
-- and org-admin cannot become SUAS-admin by self-service role mutation. The
-- released data model does not name a table for this global role, so it is
-- modelled here as an explicit, auditable, revocable grant rather than as a
-- boolean column. See the Slice 3 conformance record, which returns the
-- representation question to specs.

CREATE TABLE suas_admin_grants (
    admin_grant_id uuid                    PRIMARY KEY,
    user_id        uuid                    NOT NULL REFERENCES users (user_id),
    status         suas_admin_grant_status NOT NULL DEFAULT 'ACTIVE',
    granted_by     uuid                    REFERENCES users (user_id),
    granted_at     timestamptz             NOT NULL DEFAULT now(),
    revoked_at     timestamptz,
    revoked_by     uuid                    REFERENCES users (user_id)
);

-- At most one active grant per user.
CREATE UNIQUE INDEX suas_admin_grants_active_key
    ON suas_admin_grants (user_id)
    WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Auth challenges (AUTH.md §3; DATA_MODEL.md §2 "auth_challenges")
-- ---------------------------------------------------------------------------

CREATE TABLE auth_challenges (
    auth_challenge_id uuid                       PRIMARY KEY,
    -- Nullable where pre-tenant enrollment applies (DATA_MODEL.md §2).
    tenant_id         uuid,
    user_id           uuid                       REFERENCES users (user_id),
    method            suas_auth_challenge_method NOT NULL,
    -- Normalized lookup reference for the destination, never the raw secret.
    destination       text                       NOT NULL,
    -- AUTH.md §3: stored hashed/opaque, never plaintext secret material.
    secret_hash       text                       NOT NULL,
    status            suas_auth_challenge_status NOT NULL DEFAULT 'ISSUED',
    attempts          integer                    NOT NULL DEFAULT 0,
    max_attempts      integer                    NOT NULL,
    issued_at         timestamptz                NOT NULL DEFAULT now(),
    expires_at        timestamptz                NOT NULL,
    consumed_at       timestamptz,
    correlation_id    text
);

-- Verification path: find the live challenge for a destination.
CREATE INDEX auth_challenges_lookup_idx
    ON auth_challenges (destination, status, expires_at DESC);
CREATE INDEX auth_challenges_user_idx ON auth_challenges (user_id, issued_at DESC);

-- ---------------------------------------------------------------------------
-- Sessions (AUTH.md §5; DATA_MODEL.md §2 "sessions")
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
    session_id      uuid        PRIMARY KEY,
    tenant_id       uuid        NOT NULL,
    user_id         uuid        NOT NULL,
    -- Opaque credential, stored hashed. The raw value is returned once, at
    -- creation, and never persisted (SECURITY.md §2 "Secrets").
    credential_hash text        NOT NULL UNIQUE,
    -- Organization context for org-scoped work, when the session has one.
    organization_id uuid,
    -- AUTH.md §5: privilege/MFA elevation state. Null means not elevated.
    mfa_elevated_at timestamptz,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    revoked_reason  text,

    FOREIGN KEY (user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    FOREIGN KEY (organization_id, tenant_id)
        REFERENCES organizations (organization_id, tenant_id)
);

-- Revocation sweep path: every live session for a user (AUTH.md §5 triggers).
CREATE INDEX sessions_user_live_idx
    ON sessions (user_id)
    WHERE revoked_at IS NULL;

CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Shared rate limits (AUTH.md §3, §11; SECURITY.md §2 "Rate limits")
-- ---------------------------------------------------------------------------
--
-- AUTH.md §3: counters protecting correctness and abuse controls must be shared
-- across horizontally scaled instances. Process-local counters are not
-- authoritative, so the counter lives in PostgreSQL.

CREATE TABLE auth_rate_limits (
    bucket       text        NOT NULL,
    subject      text        NOT NULL,
    window_start timestamptz NOT NULL,
    count        integer     NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (bucket, subject, window_start)
);

CREATE INDEX auth_rate_limits_window_idx ON auth_rate_limits (window_start);
