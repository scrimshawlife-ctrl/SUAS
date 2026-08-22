/**
 * Served-surface evidence (requires PostgreSQL).
 *
 * SUAS-specs MVP_REFERENCE.md §5 (required surfaces exist), §6 (unreleased
 * categories are not served as operational), §7.5 + ADMIN.md §2 (admin scope),
 * §8 (resource data comes from the catalog, not hard-coded truth);
 * SUAS-specs API.md §4 (session required; tenant is server-derived).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createUser } from '../../src/identity/index.js';
import { createResource, setResourceActive, verifyResource } from '../../src/fulfillment/index.js';
import { createServiceRequest, openCase } from '../../src/coordination/index.js';
import { withTransaction } from '../../src/db/index.js';
import type { RecordingChallengeDelivery } from '../../src/auth/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { auditAccessibility } from '../../src/ui/index.js';
import { validEnv } from '../helpers/env.js';

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({ env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply' }), listen: false });
});

afterAll(async () => {
  await app.close();
});

function pool() {
  const value = app.pool;
  if (value === undefined) throw new Error('The test app has no database pool.');
  return value;
}

/** Enrol a user and return a live session credential plus their tenant. */
async function signIn(): Promise<{ credential: string; tenantId: string; userId: string }> {
  const tenantId = randomUUID();
  const email = syntheticEmail(`veteran-${randomUUID().slice(0, 8)}`);
  const user = await createUser(pool(), { tenantId, email, status: 'ACTIVE' });

  const issued = await app.server.inject({
    method: 'POST',
    url: '/api/v0/auth/challenges',
    payload: { tenant_id: tenantId, destination: email, method: 'EMAIL_OTP' },
  });
  expect(issued.statusCode).toBe(202);

  const delivery = app.challengeDelivery as RecordingChallengeDelivery;
  const code = delivery.lastFor(email.toLowerCase())?.secret ?? '';
  const verified = await app.server.inject({
    method: 'POST',
    url: '/api/v0/auth/challenges/commands/verify',
    payload: { tenant_id: tenantId, destination: email, code },
  });
  expect(verified.statusCode).toBe(201);

  return {
    credential: verified.json().session_credential as string,
    tenantId,
    userId: user.userId,
  };
}

function authorized(credential: string) {
  return { authorization: `Bearer ${credential}` };
}

describe('MVP_REFERENCE.md §5 — public surfaces', () => {
  it('serves the landing action surface without a session', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/app' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    for (const action of ['TAKE ACTION', 'I NEED SUPPORT', 'I WANT TO SERVE']) {
      expect(response.body, action).toContain(action);
    }
  });

  it('serves enrollment with the §7.1 contact requirement, not the reference promise', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/app/join' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Join the Mission');
    expect(response.body).toContain('sign-in code');
    // §7.1: the prototype's "No email" copy contradicts AUTH.md.
    expect(response.body).not.toContain('No email');
  });

  it('serves accessible markup on the public path', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/app' });
    expect(auditAccessibility(response.body)).toEqual([]);
  });
});

describe('API.md §4 — authenticated surfaces require a session', () => {
  it.each(['/app/home', '/app/resources', '/app/chat', '/app/responder', '/app/admin'])(
    'refuses %s without a credential',
    async (url) => {
      const response = await app.server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    },
  );

  it('serves the veteran home to a session holder', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Deploy QRF');
    expect(response.body).toContain('Immediate Resources');
    expect(auditAccessibility(response.body)).toEqual([]);
  });

  it('serves the veteran home while a QRF request is in flight', async () => {
    const { credential, tenantId, userId } = await signIn();

    // The live 500: the in-flight home drops the Deploy QRF action, which the
    // §5 required-element list demanded unconditionally.
    await withTransaction(pool(), async (tx) => {
      const opened = await openCase(tx, {
        tenantId,
        veteranUserId: userId,
        actorType: 'VETERAN',
        actorId: userId,
      });
      await createServiceRequest(tx, {
        tenantId,
        caseId: opened.supportCase.caseId,
        category: 'PEER_SUPPORT',
        createdBy: userId,
        actorType: 'VETERAN',
      });
    });

    const response = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Your QRF request');
    expect(response.body).not.toContain('Deploy QRF');
    // §7.2: a newly recorded request claims nothing beyond being recorded.
    expect(response.body).toContain('REQUESTED');
    expect(response.body).not.toContain('RESPONDER NOTIFIED');
    expect(auditAccessibility(response.body)).toEqual([]);
  });

  it('reserves the immediate-resource slot without shipping crisis copy', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/immediate-resources',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Immediate Resources');
    expect(response.body).toContain('not available in this build');
    expect(response.body).not.toMatch(/\b988\b/);
  });
});

describe('MVP_REFERENCE.md §8 — resource screens read the catalog', () => {
  it('renders a configured resource with its recorded contact method', async () => {
    const { credential, tenantId } = await signIn();
    const resource = await createResource(pool(), {
      tenantId,
      serviceName: 'Example County Food Pantry',
      category: 'FOOD',
      counties: ['Example County'],
      integrationModes: ['MANUAL_COORDINATION'],
      contactMethod: 'Walk in during posted hours',
    });

    // RESOURCES.md §7: a Resource is inactive until it carries verification
    // evidence, so the veteran-facing list shows nothing until it is verified.
    const actorId = randomUUID();
    await verifyResource(pool(), {
      tenantId,
      resourceId: resource.resourceId,
      verificationSource: 'Called the listed number during posted hours',
      actorId,
    });
    await setResourceActive(pool(), {
      tenantId,
      resourceId: resource.resourceId,
      active: true,
      actorId,
    });

    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/food',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Example County Food Pantry');
    expect(response.body).toContain('Walk in during posted hours');
    // §8: the catalog is the source, so no scheme is guessed for the veteran.
    expect(response.body).not.toContain('tel:');
  });

  it('offers a direct tel: action when the catalog records a PHONE scheme (P-13)', async () => {
    const { credential, tenantId } = await signIn();
    const resource = await createResource(pool(), {
      tenantId,
      serviceName: 'Example County Food Pantry',
      category: 'FOOD',
      counties: ['Example County'],
      integrationModes: ['MANUAL_COORDINATION'],
      contactMethod: '+1-555-555-0101',
      contactMethodKind: 'PHONE',
    });
    const actorId = randomUUID();
    await verifyResource(pool(), {
      tenantId,
      resourceId: resource.resourceId,
      verificationSource: 'Called the listed number during posted hours',
      actorId,
    });
    await setResourceActive(pool(), {
      tenantId,
      resourceId: resource.resourceId,
      active: true,
      actorId,
    });

    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/food',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    // §8 / P-13: the recorded scheme becomes a real action for the veteran.
    expect(response.body).toContain('href="tel:+1-555-555-0101"');
  });

  it('never shows an unverified resource to a veteran', async () => {
    const { credential, tenantId } = await signIn();
    await createResource(pool(), {
      tenantId,
      serviceName: 'Example Unverified Pantry',
      category: 'FOOD',
      integrationModes: ['MANUAL_COORDINATION'],
    });

    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/food',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('Example Unverified Pantry');
  });

  it('shows a truthful empty state for a category with no listings', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/transportation',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('No verified resources are configured');
  });

  it('serves an unreleased category as information only, never as a catalog', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/job-training',
      headers: authorized(credential),
    });

    // §6: visible for continuity, and carrying no operational listings.
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Job Training');
    expect(response.body).toContain('No verified resources are configured');
  });

  it('refuses a category that is not on the reference surface at all', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/benefits',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CATEGORY_NOT_OPERATIONAL');
  });
});

describe('Every link a surface renders resolves to a registered route', () => {
  /** Internal GET targets found in rendered markup, minus in-page anchors. */
  function internalLinks(markup: string): string[] {
    return [...markup.matchAll(/<a\b[^>]*\shref="(\/[^"#?]*)"/g)]
      .map((match) => match[1] ?? '')
      .filter((href) => href !== '');
  }

  it('serves every link on the veteran home and the category surface', async () => {
    const { credential } = await signIn();

    const pages = ['/app/home', '/app/resources'];
    const seen = new Set<string>();
    for (const page of pages) {
      const rendered = await app.server.inject({
        method: 'GET',
        url: page,
        headers: authorized(credential),
      });
      expect(rendered.statusCode, page).toBe(200);
      for (const href of internalLinks(rendered.body)) seen.add(href);
    }

    // The unreleased-category cards pointed at an unregistered /info path, so
    // Counseling, Activities, and Job Training were dead links from the home.
    expect(seen.size).toBeGreaterThan(0);
    for (const href of seen) {
      const response = await app.server.inject({
        method: 'GET',
        url: href,
        headers: authorized(credential),
      });
      expect(response.statusCode, `${href} is a dead link`).not.toBe(404);
    }
  });
});

describe('MVP_REFERENCE.md §7.5 / ADMIN.md §2 — the admin overview', () => {
  it('refuses a non-admin session', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/admin',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('Chat states its own unavailability', () => {
  it('does not render an empty inbox that implies messaging works', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/chat',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Messaging is not available yet');
  });
});
