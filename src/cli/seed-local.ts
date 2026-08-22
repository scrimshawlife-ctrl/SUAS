/**
 * LOCAL synthetic-data seed.
 *
 * Populates a coherent, recognizably-fictitious dataset in the LOCAL database so
 * a developer has something to see across the reference surfaces: an org, a SUAS
 * admin, a responder, veterans, an active QRF (Support Case + PEER_SUPPORT
 * Service Request), and an active/verified Resource catalog. It also mints
 * sessions and prints their bearer credentials for the authenticated surfaces.
 *
 * Boundaries (SUAS-specs ENVIRONMENT.md §2, §7; TESTING.md §12; AGENTS.md):
 * - Refuses to run outside SUAS_ENV=LOCAL and refuses when real external effects
 *   are enabled. It never writes real veteran data.
 * - All contact data is synthetic (reserved non-routable domains only).
 * - Every row is written through the same domain commands the app uses, so real
 *   invariants (tenant scope, one-active-case, transitions, verify-before-active)
 *   hold. Nothing here upgrades an UNAVAILABLE/MANUAL_ONLY/FUTURE surface: no
 *   Support Signal score, crisis copy, or real provider effect is fabricated.
 *
 * Idempotent: keyed on synthetic destinations / names, so re-running converges on
 * the same dataset rather than duplicating it. Sessions are minted fresh per run.
 *
 * Usage: npm run seed   (requires PostgreSQL running and .env exported)
 */

import type { Pool, PoolClient } from 'pg';
import { assertSyntheticEnvironment, syntheticEmail } from '../testing/fixture-boundary.js';
import { loadConfig } from '../config/index.js';
import { createPool, withTransaction } from '../db/index.js';
import {
  createMembership,
  createOrganization,
  createUser,
  findUserByDestination,
  grantSuasAdmin,
  isSuasAdmin,
  listActiveMemberships,
  setMembershipStatus,
  setOrganizationStatus,
  setUserStatus,
  type Organization,
  type User,
} from '../identity/index.js';
import { createSession, elevateSession } from '../auth/index.js';
import {
  createResource,
  setResourceActive,
  verifyResource,
  type Resource,
} from '../fulfillment/index.js';
import {
  claimCase,
  createServiceRequest,
  executeCaseCommand,
  findActiveAssignment,
  findCase,
  listCaseServiceRequests,
  openCase,
  type CaseStatus,
  type SupportCase,
} from '../coordination/index.js';
import {
  consentTemplateVersionKey,
  createConsentTemplateVersion,
  findActiveGrant,
  findConsentTemplateVersion,
  grantConsent,
  publishConsentTemplateVersion,
} from '../consent/index.js';
import {
  completeFollowUp,
  createFollowUp,
  findCurrentSettlement,
  resolveCaseWithSettlement,
} from '../settlement/index.js';

/** Fixed synthetic tenant so re-runs converge rather than multiply. */
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ORG_NAME = 'Example Veteran Support Org (synthetic)';

interface OrgRow {
  organization_id: string;
}
interface ResourceRow {
  resource_id: string;
}

async function getOrCreateUser(pool: Pool, localPart: string): Promise<User> {
  const email = syntheticEmail(localPart);
  const existing = await findUserByDestination(pool, TENANT_ID, email);
  if (existing !== undefined) {
    if (existing.status !== 'ACTIVE') {
      const updated = await setUserStatus(pool, TENANT_ID, existing.userId, 'ACTIVE');
      return updated ?? existing;
    }
    return existing;
  }
  return createUser(pool, { tenantId: TENANT_ID, email, status: 'ACTIVE' });
}

async function getOrCreateOrg(pool: Pool): Promise<Organization> {
  const found = await pool.query<OrgRow>(
    `SELECT organization_id FROM organizations WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
    [TENANT_ID, ORG_NAME],
  );
  const existingId = found.rows[0]?.organization_id;
  if (existingId !== undefined) {
    const active = await setOrganizationStatus(pool, TENANT_ID, existingId, 'ACTIVE');
    if (active !== undefined) return active;
  }
  const org = await createOrganization(pool, { tenantId: TENANT_ID, name: ORG_NAME });
  const active = await setOrganizationStatus(pool, TENANT_ID, org.organizationId, 'ACTIVE');
  return active ?? org;
}

async function ensureMembership(pool: Pool, userId: string, organizationId: string): Promise<void> {
  const memberships = await listActiveMemberships(pool, userId);
  if (memberships.some((m) => m.organizationId === organizationId)) return;
  const membership = await createMembership(pool, {
    tenantId: TENANT_ID,
    userId,
    organizationId,
    role: 'RESPONDER',
  });
  await setMembershipStatus(pool, TENANT_ID, membership.membershipId, 'ACTIVE');
}

interface ResourceSpec {
  readonly serviceName: string;
  readonly category: string;
  readonly counties: readonly string[];
  readonly contactMethod: string;
  readonly hours: string;
  readonly cost: string;
  readonly eligibility: string;
}

const RESOURCE_SPECS: readonly ResourceSpec[] = [
  {
    serviceName: 'Example Community Food Pantry (synthetic)',
    category: 'FOOD',
    counties: ['Example County'],
    contactMethod: 'Walk-in intake at the front desk',
    hours: 'Weekdays, morning to afternoon',
    cost: 'No cost',
    eligibility: 'All veterans',
  },
  {
    serviceName: 'Example Volunteer Rides (synthetic)',
    category: 'TRANSPORTATION',
    counties: ['Example County'],
    contactMethod: 'Request through a responder',
    hours: 'By appointment',
    cost: 'No cost',
    eligibility: 'All veterans',
  },
  {
    serviceName: 'Example Emergency Shelter (synthetic)',
    category: 'SHELTER',
    counties: ['Example County'],
    contactMethod: 'Walk-in intake at the front desk',
    hours: 'Daily, evening intake',
    cost: 'No cost',
    eligibility: 'All veterans',
  },
  {
    serviceName: 'Example Peer Support Circle (synthetic)',
    category: 'PEER_SUPPORT',
    counties: ['Example County'],
    contactMethod: 'Request through a responder',
    hours: 'Weekly meeting',
    cost: 'No cost',
    eligibility: 'All veterans',
  },
];

async function ensureResource(pool: Pool, spec: ResourceSpec, actorId: string): Promise<string> {
  const found = await pool.query<ResourceRow>(
    `SELECT resource_id FROM resources
     WHERE tenant_id = $1 AND service_name = $2 AND category = $3::suas_service_category
     LIMIT 1`,
    [TENANT_ID, spec.serviceName, spec.category],
  );
  const existingId = found.rows[0]?.resource_id;
  if (existingId !== undefined) {
    await setResourceActive(pool, {
      tenantId: TENANT_ID,
      resourceId: existingId,
      active: true,
      actorId,
    });
    return existingId;
  }

  const resource: Resource = await createResource(pool, {
    tenantId: TENANT_ID,
    serviceName: spec.serviceName,
    category: spec.category,
    counties: spec.counties,
    contactMethod: spec.contactMethod,
    hours: spec.hours,
    cost: spec.cost,
    eligibility: spec.eligibility,
  });
  await verifyResource(pool, {
    tenantId: TENANT_ID,
    resourceId: resource.resourceId,
    verificationSource: 'Synthetic local seed',
    actorId,
  });
  await setResourceActive(pool, {
    tenantId: TENANT_ID,
    resourceId: resource.resourceId,
    active: true,
    actorId,
  });
  return resource.resourceId;
}

async function ensureActiveQrf(
  pool: Pool,
  veteran: User,
  responder: User,
): Promise<{ supportCase: SupportCase; serviceRequestId: string }> {
  const opened = await withTransaction(pool, (tx: PoolClient) =>
    openCase(tx, {
      tenantId: TENANT_ID,
      veteranUserId: veteran.userId,
      actorType: 'VETERAN',
      actorId: veteran.userId,
    }),
  );
  let supportCase = opened.supportCase;

  const assignment = await findActiveAssignment(pool, supportCase.caseId);
  if (assignment === undefined && supportCase.status === 'OPEN') {
    await claimCase(pool, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });
    supportCase = await refetchCase(pool, supportCase.caseId);
  }

  const requests = await listCaseServiceRequests(pool, TENANT_ID, supportCase.caseId);
  const activePeer = requests.find(
    (r) =>
      r.category === 'PEER_SUPPORT' &&
      !['CLOSED', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'UNFULFILLABLE'].includes(r.status),
  );
  if (activePeer !== undefined) {
    return { supportCase, serviceRequestId: activePeer.serviceRequestId };
  }

  const created = await withTransaction(pool, (tx: PoolClient) =>
    createServiceRequest(tx, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      category: 'PEER_SUPPORT',
      createdBy: veteran.userId,
      actorType: 'VETERAN',
    }),
  );
  return { supportCase, serviceRequestId: created.serviceRequestId };
}

async function refetchCase(pool: Pool, caseId: string): Promise<SupportCase> {
  const supportCase = await findCase(pool, TENANT_ID, caseId);
  if (supportCase === undefined) throw new Error(`Seeded case ${caseId} vanished mid-seed.`);
  return supportCase;
}

/**
 * The CONSENT stage: a published template and one active grant. Consent is
 * first-class (CONSENT.md §1), so the seed shows a real grant rather than a
 * boolean. Idempotent: the template is get-or-create and the grant is skipped
 * when an identical live one already exists.
 */
async function ensureConsent(pool: Pool, veteran: User, responder: User): Promise<string> {
  const versionKey = consentTemplateVersionKey('local-seed-consent', 1);
  const template = await findConsentTemplateVersion(pool, versionKey);
  if (template === undefined) {
    await createConsentTemplateVersion(pool, {
      templateKey: 'local-seed-consent',
      version: 1,
      body: 'Synthetic consent template — local development only.',
    });
  }
  if (template === undefined || template.status !== 'PUBLISHED') {
    await publishConsentTemplateVersion(pool, versionKey, responder.userId);
  }

  const existing = await findActiveGrant(pool, {
    tenantId: TENANT_ID,
    veteranUserId: veteran.userId,
    permission: 'can_view',
    scope: 'current_requests',
    granteeType: 'RESPONDER',
    granteeId: responder.userId,
  });
  if (existing !== undefined) return existing.consentGrantId;

  const grant = await grantConsent(pool, {
    tenantId: TENANT_ID,
    veteranUserId: veteran.userId,
    permission: 'can_view',
    scope: 'current_requests',
    purpose: 'Coordinate the veteran’s active support requests (synthetic seed).',
    granteeType: 'RESPONDER',
    granteeId: responder.userId,
    consentTemplateVersion: versionKey,
  });
  return grant.consentGrantId;
}

/**
 * A second veteran resolved through the release's first-class MANUAL path:
 * open → claim → activate → a completed Follow-Up → resolve with a Settlement →
 * close. It uses no external-provider disclosure, so no real effect occurs.
 *
 * Status-driven so it is idempotent and resumable: a CLOSED case is left alone,
 * and a partially advanced one continues from its current status.
 */
async function ensureSettledCase(
  pool: Pool,
  veteran: User,
  responder: User,
): Promise<{ caseId: string; status: CaseStatus; settlementId: string | undefined }> {
  const latest = await pool.query<{ case_id: string; status: CaseStatus }>(
    `SELECT case_id, status FROM support_cases
     WHERE tenant_id = $1 AND veteran_user_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [TENANT_ID, veteran.userId],
  );
  const existing = latest.rows[0];
  if (existing !== undefined && existing.status === 'CLOSED') {
    const settlement = await findCurrentSettlement(pool, TENANT_ID, existing.case_id);
    return { caseId: existing.case_id, status: 'CLOSED', settlementId: settlement?.settlementId };
  }

  const opened = await withTransaction(pool, (tx: PoolClient) =>
    openCase(tx, {
      tenantId: TENANT_ID,
      veteranUserId: veteran.userId,
      actorType: 'VETERAN',
      actorId: veteran.userId,
    }),
  );
  let supportCase = opened.supportCase;

  if (
    supportCase.status === 'OPEN' &&
    (await findActiveAssignment(pool, supportCase.caseId)) === undefined
  ) {
    await claimCase(pool, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      responderUserId: responder.userId,
    });
    supportCase = await refetchCase(pool, supportCase.caseId);
  }

  if (supportCase.status === 'ASSIGNED') {
    await executeCaseCommand(pool, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      command: 'ACTIVATE',
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });
    supportCase = await refetchCase(pool, supportCase.caseId);
  }

  // A single completed Follow-Up: creation is one-shot, completion idempotent.
  const followUps = await pool.query<{ follow_up_id: string }>(
    `SELECT follow_up_id FROM follow_ups WHERE tenant_id = $1 AND case_id = $2
     ORDER BY created_at LIMIT 1`,
    [TENANT_ID, supportCase.caseId],
  );
  let followUpId = followUps.rows[0]?.follow_up_id;
  if (followUpId === undefined) {
    const created = await createFollowUp(pool, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      dueAt: new Date(),
      responsibleType: 'RESPONDER',
      responsibleId: responder.userId,
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });
    followUpId = created.followUpId;
  }
  await completeFollowUp(pool, {
    tenantId: TENANT_ID,
    followUpId,
    actorId: responder.userId,
    actorType: 'RESPONDER',
  });

  if (supportCase.status === 'ACTIVE') {
    await resolveCaseWithSettlement(pool, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      actorId: responder.userId,
      content: {
        requested: { summary: 'Peer support and food navigation (synthetic).' },
        occurred: { summary: 'Responder coordinated support manually; one Follow-Up completed.' },
        fulfilled: { summary: 'Immediate need met through manual peer coordination.' },
        unresolved: { summary: 'No open needs at settlement.' },
        authoredBy: responder.userId,
        responderConfirmedBy: responder.userId,
      },
      idempotencyKey: `seed-resolve:${supportCase.caseId}`,
    });
    supportCase = await refetchCase(pool, supportCase.caseId);
  }

  if (supportCase.status === 'RESOLVED') {
    await executeCaseCommand(pool, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      command: 'CLOSE',
      actorId: responder.userId,
      actorType: 'RESPONDER',
    });
    supportCase = await refetchCase(pool, supportCase.caseId);
  }

  const settlement = await findCurrentSettlement(pool, TENANT_ID, supportCase.caseId);
  return {
    caseId: supportCase.caseId,
    status: supportCase.status,
    settlementId: settlement?.settlementId,
  };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  if (config.environment !== 'LOCAL') {
    throw new Error(
      `The local seed refuses to run in ${config.environment}; it is for LOCAL development only ` +
        `(SUAS-specs ENVIRONMENT.md §2). Set SUAS_ENV=LOCAL.`,
    );
  }
  // Reuses the synthetic-fixture boundary: LOCAL/TEST/STAGING only, and never
  // with real external effects enabled.
  assertSyntheticEnvironment(config);

  const pool = createPool(config);
  try {
    const org = await getOrCreateOrg(pool);

    const admin = await getOrCreateUser(pool, 'admin');
    const responder = await getOrCreateUser(pool, 'responder');
    const veteran = await getOrCreateUser(pool, 'veteran');
    const veteranTwo = await getOrCreateUser(pool, 'veteran2');

    if (!(await isSuasAdmin(pool, admin.userId))) {
      await grantSuasAdmin(pool, admin.userId, admin.userId);
    }
    await ensureMembership(pool, responder.userId, org.organizationId);

    const resourceIds: string[] = [];
    for (const spec of RESOURCE_SPECS) {
      resourceIds.push(await ensureResource(pool, spec, admin.userId));
    }

    const qrf = await ensureActiveQrf(pool, veteran, responder);
    const consentGrantId = await ensureConsent(pool, veteran, responder);
    const settled = await ensureSettledCase(pool, veteranTwo, responder);

    // Sessions are minted fresh each run so the printed credentials are live.
    const secret = config.sessionSecret;
    const veteranSession = await createSession(pool, secret, {
      tenantId: TENANT_ID,
      userId: veteran.userId,
    });
    const responderSession = await createSession(pool, secret, {
      tenantId: TENANT_ID,
      userId: responder.userId,
      organizationId: org.organizationId,
    });
    const adminSession = await withTransaction(pool, async (tx) => {
      const issued = await createSession(tx, secret, {
        tenantId: TENANT_ID,
        userId: admin.userId,
      });
      // Elevate directly (dev seed): the admin surfaces require an MFA-elevated
      // session (ADMIN.md §2; SECURITY.md §2).
      await elevateSession(tx, issued.session.sessionId);
      return issued;
    });

    const summary = {
      environment: config.environment,
      tenantId: TENANT_ID,
      organizationId: org.organizationId,
      users: {
        admin: { userId: admin.userId, email: syntheticEmail('admin') },
        responder: { userId: responder.userId, email: syntheticEmail('responder') },
        veteran: { userId: veteran.userId, email: syntheticEmail('veteran') },
        veteran2: { userId: veteranTwo.userId, email: syntheticEmail('veteran2') },
      },
      activeQrf: {
        caseId: qrf.supportCase.caseId,
        caseStatus: qrf.supportCase.status,
        serviceRequestId: qrf.serviceRequestId,
      },
      consentGrantId,
      settledCase: {
        caseId: settled.caseId,
        caseStatus: settled.status,
        settlementId: settled.settlementId,
      },
      resources: { count: resourceIds.length, categories: RESOURCE_SPECS.map((s) => s.category) },
      sessions: {
        veteranBearer: veteranSession.credential,
        responderBearer: responderSession.credential,
        adminBearer: adminSession.credential,
        expiresAt: veteranSession.session.expiresAt.toISOString(),
      },
      hint: 'Use the bearer with: curl -H "authorization: Bearer <cred>" http://127.0.0.1:3000/app/home',
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
