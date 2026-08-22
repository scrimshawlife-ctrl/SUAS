/**
 * Consent kernel integration evidence (requires PostgreSQL).
 *
 * SUAS-specs CONSENT.md §2, §2.1, §3, §4, §6, §7, §8, §10 (critical suite:
 * consent revocation); TRUSTED_CIRCLE.md §1, §2, §6, §11 (critical suite:
 * trusted-circle visibility); PRIVACY.md §2; API.md §4.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptTrustedContact,
  ConsentDeniedError,
  consentTemplateVersionKey,
  ConsentTemplateNotPublishedError,
  createConsentTemplateVersion,
  evaluateDisclosure,
  expireDueGrants,
  findTrustedContact,
  grantConsent,
  InvalidConsentScopeError,
  inviteTrustedContact,
  listConsentEvents,
  publishConsentTemplateVersion,
  requireDisclosure,
  revokeConsent,
  setTrustedContactStatus,
  type TrustedContact,
  TrustedContactTerminalError,
} from '../../src/consent/index.js';
import { createUser, setUserStatus } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';

const pool: Pool = createTestPool();

let templateVersion = '';

beforeEach(async () => {
  await resetKernelTables(pool);
  // CONSENT.md §6: grants may only reference a published template version.
  const key = consentTemplateVersionKey(`trusted-contact-alerts-${randomUUID().slice(0, 8)}`, 1);
  await createConsentTemplateVersion(pool, {
    templateKey: key.split('@')[0] ?? '',
    version: 1,
    body: 'Synthetic test template. No released consent copy exists in v0.1.1.',
  });
  await publishConsentTemplateVersion(pool, key, undefined);
  templateVersion = key;
});

afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function veteran(tenantId: string) {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`veteran-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

async function acceptedContact(tenantId: string, veteranUserId: string): Promise<TrustedContact> {
  const contact = await inviteTrustedContact(pool, {
    tenantId,
    veteranUserId,
    relationshipLabel: 'Battle buddy',
    inviteEmail: syntheticEmail(`contact-${randomUUID().slice(0, 8)}`),
  });
  const accepted = await acceptTrustedContact(pool, tenantId, contact.trustedContactId);
  if (accepted === undefined) throw new Error('Contact did not accept.');
  return accepted;
}

function alertRequest(tenantId: string, veteranUserId: string, granteeId: string, scope = 'RED') {
  return {
    tenantId,
    veteranUserId,
    permission: 'can_receive' as const,
    scope: scope as 'RED',
    granteeType: 'TRUSTED_CONTACT' as const,
    granteeId,
    purpose: 'Alert a trusted contact at this support signal level',
  };
}

describe('CONSENT.md §6 — templates', () => {
  it('refuses a grant against an unpublished template', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const draftKey = consentTemplateVersionKey('draft-template', 1);
    await createConsentTemplateVersion(pool, { templateKey: 'draft-template', version: 1 });

    await expect(
      grantConsent(pool, {
        tenantId,
        veteranUserId: subject.userId,
        permission: 'can_view',
        scope: 'support_signal',
        purpose: 'View support signal',
        granteeType: 'TRUSTED_CONTACT',
        granteeId: randomUUID(),
        consentTemplateVersion: draftKey,
      }),
    ).rejects.toThrow(ConsentTemplateNotPublishedError);
  });
});

describe('CONSENT.md §2.1 — no implication between scopes', () => {
  it('does not let a YELLOW grant authorize a RED alert', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'YELLOW',
      purpose: 'Alert at yellow',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });

    const yellow = await evaluateDisclosure(
      pool,
      alertRequest(tenantId, subject.userId, contact.trustedContactId, 'YELLOW'),
    );
    const red = await evaluateDisclosure(
      pool,
      alertRequest(tenantId, subject.userId, contact.trustedContactId, 'RED'),
    );

    expect(yellow.allowed).toBe(true);
    expect(red.allowed).toBe(false);
  });

  it('does not let a support_signal grant reveal checkin_answers', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_view',
      scope: 'support_signal',
      purpose: 'View support signal',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });

    const base = {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_view' as const,
      granteeType: 'TRUSTED_CONTACT' as const,
      granteeId: contact.trustedContactId,
      purpose: 'View',
    };

    expect((await evaluateDisclosure(pool, { ...base, scope: 'support_signal' })).allowed).toBe(
      true,
    );
    expect((await evaluateDisclosure(pool, { ...base, scope: 'checkin_answers' })).allowed).toBe(
      false,
    );
    expect((await evaluateDisclosure(pool, { ...base, scope: 'location' })).allowed).toBe(false);
  });

  it('rejects a permission and scope pairing the released examples do not describe', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);

    await expect(
      grantConsent(pool, {
        tenantId,
        veteranUserId: subject.userId,
        permission: 'can_receive',
        scope: 'checkin_answers',
        purpose: 'Nonsense',
        granteeType: 'TRUSTED_CONTACT',
        granteeId: randomUUID(),
        consentTemplateVersion: templateVersion,
      }),
    ).rejects.toThrow(InvalidConsentScopeError);
  });
});

describe('CONSENT.md §4, §10 — revocation is the critical suite', () => {
  it('allows notify, then denies it after revoke', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    const grant = await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'Alert at red',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });

    const before = await evaluateDisclosure(
      pool,
      alertRequest(tenantId, subject.userId, contact.trustedContactId),
    );
    expect(before.allowed).toBe(true);

    await revokeConsent(pool, tenantId, grant.consentGrantId);

    const after = await evaluateDisclosure(
      pool,
      alertRequest(tenantId, subject.userId, contact.trustedContactId),
    );
    expect(after.allowed).toBe(false);
  });

  it('preserves consent history after revoke', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    const grant = await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'ORANGE',
      purpose: 'Alert at orange',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });
    await revokeConsent(pool, tenantId, grant.consentGrantId);

    const history = await listConsentEvents(pool, tenantId, subject.userId);
    const types = history.map((event) => event.eventType);
    expect(types).toContain('GRANTED');
    expect(types).toContain('REVOKED');

    // The grant row itself survives; nothing is deleted.
    const rows = await pool.query('SELECT status FROM consent_grants WHERE consent_grant_id = $1', [
      grant.consentGrantId,
    ]);
    expect(rows.rows[0]).toMatchObject({ status: 'REVOKED' });
  });

  it('keeps consent history immutable', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);
    await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_view',
      scope: 'current_requests',
      purpose: 'View requests',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });

    await expect(pool.query(`UPDATE consent_events SET event_type = 'REVOKED'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query(`DELETE FROM consent_events`)).rejects.toThrow(/append-only/);
  });

  it('requires a new grant to re-consent, rather than reviving the revoked row', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    const first = await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'Alert at red',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });
    await revokeConsent(pool, tenantId, first.consentGrantId);

    const second = await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'Alert at red again',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });

    expect(second.consentGrantId).not.toBe(first.consentGrantId);
    expect(
      (
        await evaluateDisclosure(
          pool,
          alertRequest(tenantId, subject.userId, contact.trustedContactId),
        )
      ).allowed,
    ).toBe(true);
  });

  it('permits only one active grant per permission tuple at a time', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    const input = {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive' as const,
      scope: 'RED' as const,
      purpose: 'Alert at red',
      granteeType: 'TRUSTED_CONTACT' as const,
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    };
    await grantConsent(pool, input);
    await expect(grantConsent(pool, input)).rejects.toThrow();
  });

  it('denies an expired grant at use time, before any sweep runs', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'Alert at red',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
      expiresAt: new Date(Date.now() + 50),
    });

    await pool.query(`UPDATE consent_grants SET expires_at = now() - interval '1 second'`);

    const decision = await evaluateDisclosure(
      pool,
      alertRequest(tenantId, subject.userId, contact.trustedContactId),
    );
    expect(decision.allowed).toBe(false);
  });

  it('sweeps expired grants into EXPIRED with history', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);
    await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'Alert at red',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
      expiresAt: new Date(Date.now() + 50),
    });
    await pool.query(`UPDATE consent_grants SET expires_at = now() - interval '1 second'`);

    expect(await expireDueGrants(pool)).toBe(1);
    const history = await listConsentEvents(pool, tenantId, subject.userId);
    expect(history.map((event) => event.eventType)).toContain('EXPIRED');
  });
});

describe('TRUSTED_CIRCLE.md §1, §6 — membership is evaluated before grants', () => {
  it('gives an accepted contact with no grants no visibility at all', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    for (const scope of [
      'support_signal',
      'checkin_answers',
      'current_requests',
      'location',
    ] as const) {
      const decision = await evaluateDisclosure(pool, {
        tenantId,
        veteranUserId: subject.userId,
        permission: 'can_view',
        scope,
        granteeType: 'TRUSTED_CONTACT',
        granteeId: contact.trustedContactId,
        purpose: 'View',
      });
      expect(decision.allowed, `${scope} must be denied`).toBe(false);
    }
  });

  it('denies an invited contact that has not accepted', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const invited = await inviteTrustedContact(pool, {
      tenantId,
      veteranUserId: subject.userId,
      relationshipLabel: 'Sister',
      inviteEmail: syntheticEmail('sister'),
    });

    await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'Alert at red',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: invited.trustedContactId,
      consentTemplateVersion: templateVersion,
    });

    const decision = await evaluateDisclosure(
      pool,
      alertRequest(tenantId, subject.userId, invited.trustedContactId),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('MEMBERSHIP_NOT_USABLE');
  });

  it.each(['SUSPENDED', 'REMOVED', 'REVOKED'] as const)(
    'denies a %s contact even while the grant is still active',
    async (status) => {
      const tenantId = syntheticTenantId();
      const subject = await veteran(tenantId);
      const contact = await acceptedContact(tenantId, subject.userId);
      await grantConsent(pool, {
        tenantId,
        veteranUserId: subject.userId,
        permission: 'can_receive',
        scope: 'RED',
        purpose: 'Alert at red',
        granteeType: 'TRUSTED_CONTACT',
        granteeId: contact.trustedContactId,
        consentTemplateVersion: templateVersion,
      });

      await setTrustedContactStatus(pool, tenantId, contact.trustedContactId, status);

      const decision = await evaluateDisclosure(
        pool,
        alertRequest(tenantId, subject.userId, contact.trustedContactId),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toBe('MEMBERSHIP_NOT_USABLE');
    },
  );

  it.each(['REMOVED', 'REVOKED'] as const)(
    'refuses to re-activate a %s contact, leaving it terminal',
    async (terminalStatus) => {
      const tenantId = syntheticTenantId();
      const subject = await veteran(tenantId);
      const contact = await acceptedContact(tenantId, subject.userId);
      await setTrustedContactStatus(pool, tenantId, contact.trustedContactId, terminalStatus);

      // TRUSTED_CIRCLE.md §2: a terminal relationship cannot be re-opened; in
      // particular it must not silently return to ACCEPTED.
      await expect(
        setTrustedContactStatus(pool, tenantId, contact.trustedContactId, 'ACCEPTED'),
      ).rejects.toThrow(TrustedContactTerminalError);

      const after = await findTrustedContact(pool, tenantId, contact.trustedContactId);
      expect(after?.status).toBe(terminalStatus);
    },
  );

  it('requires an invite channel', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    await expect(
      inviteTrustedContact(pool, {
        tenantId,
        veteranUserId: subject.userId,
        relationshipLabel: 'Nobody',
      }),
    ).rejects.toThrow();
  });
});

describe('CONSENT.md §3.5-§3.6 — system basis', () => {
  it('allows internal processing that discloses to no third party', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);

    const decision = await evaluateDisclosure(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_view',
      scope: 'support_signal',
      granteeType: 'SYSTEM',
      granteeId: 'signal-compute',
      purpose: 'Compute a support signal',
      systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
    });

    expect(decision).toMatchObject({ allowed: true, basis: 'SYSTEM_INTERNAL_PROCESSING' });
  });

  it('refuses the internal basis when the grantee is a third party', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);

    const decision = await evaluateDisclosure(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_share',
      scope: 'service_request_fulfillment',
      granteeType: 'SERVICE_PROVIDER',
      granteeId: 'adapter-1',
      purpose: 'Book a ride',
      systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('SYSTEM_BASIS_NOT_APPLICABLE');
  });

  it('cannot establish responder case-assignment basis without an assignment verifier', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);

    const decision = await evaluateDisclosure(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_view',
      scope: 'current_requests',
      granteeType: 'RESPONDER',
      granteeId: randomUUID(),
      purpose: 'Coordinate an assigned case',
      systemBasis: 'RESPONDER_CASE_ASSIGNMENT',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('ASSIGNMENT_NOT_VERIFIABLE');
  });

  it('allows responder access when an active assignment is verified', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);

    const decision = await evaluateDisclosure(
      pool,
      {
        tenantId,
        veteranUserId: subject.userId,
        permission: 'can_view',
        scope: 'current_requests',
        granteeType: 'RESPONDER',
        granteeId: randomUUID(),
        purpose: 'Coordinate an assigned case',
        systemBasis: 'RESPONDER_CASE_ASSIGNMENT',
      },
      { verifyActiveAssignment: () => Promise.resolve(true) },
    );

    expect(decision).toMatchObject({ allowed: true, basis: 'RESPONDER_CASE_ASSIGNMENT' });
  });

  it('denies when the verifier reports no active assignment', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);

    const decision = await evaluateDisclosure(
      pool,
      {
        tenantId,
        veteranUserId: subject.userId,
        permission: 'can_view',
        scope: 'current_requests',
        granteeType: 'RESPONDER',
        granteeId: randomUUID(),
        purpose: 'Coordinate an unassigned case',
        systemBasis: 'RESPONDER_CASE_ASSIGNMENT',
      },
      { verifyActiveAssignment: () => Promise.resolve(false) },
    );

    expect(decision.allowed).toBe(false);
  });
});

describe('CONSENT.md §3 — enrollment and tenancy', () => {
  it('denies when the veteran is no longer active', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);
    await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'Alert at red',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });

    await setUserStatus(pool, tenantId, subject.userId, 'SUSPENDED');

    const decision = await evaluateDisclosure(
      pool,
      alertRequest(tenantId, subject.userId, contact.trustedContactId),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('VETERAN_NOT_ENROLLED');
  });

  it('does not match a grant from another tenant', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);
    await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'Alert at red',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });

    const decision = await evaluateDisclosure(
      pool,
      alertRequest(syntheticTenantId(), subject.userId, contact.trustedContactId),
    );
    expect(decision.allowed).toBe(false);
  });
});

describe('CONSENT.md §5, §7, §8 — audit paths', () => {
  it('audits an allowed disclosure with its consent basis and disclosed field names', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);
    await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_view',
      scope: 'current_requests',
      purpose: 'View requests',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });

    await evaluateDisclosure(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_view',
      scope: 'current_requests',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      purpose: 'View requests',
      disclosedFields: ['service_request_id', 'status'],
    });

    const audits = await pool.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM audit_events
       WHERE tenant_id = $1 AND event_type = 'CONSENT_EVALUATED'`,
      [tenantId],
    );
    expect(audits.rows[0]?.action).toBe('DISCLOSURE_ALLOWED');
    expect(audits.rows[0]?.payload).toMatchObject({
      consent_basis: 'CONSENT_GRANT',
      decision: 'ALLOW',
      disclosed_fields: ['service_request_id', 'status'],
    });
  });

  it('audits a denial too', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    await evaluateDisclosure(
      pool,
      alertRequest(tenantId, subject.userId, contact.trustedContactId),
    );

    const audits = await pool.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM audit_events
       WHERE tenant_id = $1 AND event_type = 'CONSENT_EVALUATED'`,
      [tenantId],
    );
    expect(audits.rows[0]?.action).toBe('DISCLOSURE_DENIED');
    expect(audits.rows[0]?.payload).toMatchObject({ consent_basis: 'NONE', decision: 'DENY' });
  });

  it('writes a DENIED consent event even though no grant ever existed', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    await evaluateDisclosure(
      pool,
      alertRequest(tenantId, subject.userId, contact.trustedContactId),
    );

    const history = await listConsentEvents(pool, tenantId, subject.userId);
    expect(history.map((event) => event.eventType)).toContain('DENIED');
    expect(history.find((event) => event.eventType === 'DENIED')?.consentGrantId).toBeUndefined();
  });

  it('does not audit purely internal processing per evaluation', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);

    await evaluateDisclosure(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_view',
      scope: 'support_signal',
      granteeType: 'SYSTEM',
      granteeId: 'signal-compute',
      purpose: 'Compute a support signal',
      systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
    });

    const audits = await pool.query(
      `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'CONSENT_EVALUATED'`,
      [tenantId],
    );
    expect(audits.rowCount).toBe(0);
  });
});

describe('API.md §4 — requireDisclosure', () => {
  it('returns the basis when allowed', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);
    await grantConsent(pool, {
      tenantId,
      veteranUserId: subject.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'Alert at red',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: contact.trustedContactId,
      consentTemplateVersion: templateVersion,
    });

    await expect(
      requireDisclosure(pool, alertRequest(tenantId, subject.userId, contact.trustedContactId)),
    ).resolves.toBe('CONSENT_GRANT');
  });

  it('throws the released denial code without describing the consent posture', async () => {
    const tenantId = syntheticTenantId();
    const subject = await veteran(tenantId);
    const contact = await acceptedContact(tenantId, subject.userId);

    const attempt = requireDisclosure(
      pool,
      alertRequest(tenantId, subject.userId, contact.trustedContactId),
    );
    await expect(attempt).rejects.toThrow(ConsentDeniedError);
    await expect(attempt).rejects.toMatchObject({ code: 'CONSENT_DENIED', httpStatus: 403 });

    try {
      await requireDisclosure(
        pool,
        alertRequest(tenantId, subject.userId, contact.trustedContactId),
      );
    } catch (error) {
      // The refused party learns only that they are not authorized.
      expect((error as Error).message).not.toContain('RED');
      expect((error as Error).message).not.toContain(contact.trustedContactId);
    }
  });
});
