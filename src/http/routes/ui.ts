/**
 * The reference surfaces, served.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §5 (required surface inventory)
 * - SUAS-specs MVP_REFERENCE.md §7.5 (admin scope clearer than the prototype)
 * - SUAS-specs API.md §2 (`/api/v0` is the canonical *API* version selector)
 * - SUAS-specs API.md §4 (session required; tenant and authority are server-derived)
 * - SUAS-specs ADMIN.md §2 / SECURITY.md §2 (privileged surfaces need admin + MFA)
 *
 * These routes are mounted under `/app`, not `/api/v0`: API.md §2 governs the
 * JSON API's version selector, and an HTML surface is not a versioned API
 * resource. The surfaces read the same domain functions the API would.
 *
 * Every handler resolves its own authorization. There is no "UI session" that
 * is weaker than an API session (AUTH.md §5).
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { assertMfaElevated, assertSuasAdmin } from '../../authz/index.js';
import type { SafetyCopyMode } from '../../config/index.js';
import { readCaseQueue } from '../../coordination/index.js';
import { searchResources } from '../../fulfillment/index.js';
import { D_012_APPROVED_SAFETY_COPY } from '../../ui/safety.js';
import {
  CATEGORY_CARDS,
  categoryForCard,
  NonOperationalCategoryError,
  renderActiveNeeds,
  renderAdminOverview,
  renderChat,
  renderEnrollment,
  renderImmediateResources,
  renderLanding,
  renderResourceCategories,
  renderResourceList,
  renderResponderDashboard,
  renderVeteranHome,
  type ResourceRowViewModel,
  type ShellViewModel,
} from '../../ui/index.js';
import { readActiveQrf } from '../../ui/read.js';
import { authenticate } from '../authenticate.js';

export interface UiRouteDependencies {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  /** D-012 safety-copy mode; controls the immediate-resources slot. */
  readonly safetyCopyMode: SafetyCopyMode;
}

const HTML = 'text/html; charset=utf-8';

function shell(title: string, overrides: Partial<ShellViewModel> = {}): ShellViewModel {
  return {
    title,
    viewport: overrides.viewport ?? 'MOBILE',
    showMobileNav: overrides.showMobileNav ?? true,
    ...(overrides.currentNav === undefined ? {} : { currentNav: overrides.currentNav }),
  };
}

export function registerUiRoutes(app: FastifyInstance, deps: UiRouteDependencies): void {
  const { pool, sessionSecret, safetyCopyMode } = deps;

  // --- Public surfaces -------------------------------------------------------
  // §5 lists these as public: a veteran must be able to see the action surface
  // before holding a session.

  app.get('/app', async (_request, reply) => {
    await reply.type(HTML).send(
      renderLanding({
        shell: shell('Shut Up and Serve', { showMobileNav: false }),
        // §7.4: mission framing with no statistic or clinical efficacy claim.
        missionLine: 'Veteran peer support, coordinated by people who served.',
      }),
    );
  });

  app.get('/app/join', async (_request, reply) => {
    await reply.type(HTML).send(
      renderEnrollment({
        shell: shell('Join the Mission', { showMobileNav: false }),
        // §7.1: the reference's "No email" promise contradicts AUTH.md.
        contactChannelRequirement:
          'We need an email address or mobile number to send your sign-in code.',
      }),
    );
  });

  // --- Veteran surfaces ------------------------------------------------------

  app.get('/app/home', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    const active = await readActiveQrf(pool, context.tenantId, context.userId);

    await reply.type(HTML).send(
      renderVeteranHome({
        shell: shell('Support', { currentNav: 'HOME' }),
        categories: CATEGORY_CARDS,
        safetyCopyMode,
        ...(active === undefined
          ? {}
          : {
              activeQrf: {
                facts: active.facts,
                // Contact paths require a consent evaluation against a known
                // counterpart. Until a request is accepted there is no
                // counterpart, so no path is asserted here (§7.2).
                authorizedVoicePath: false,
                authorizedMessagePath: false,
              },
            }),
      }),
    );
  });

  app.get('/app/immediate-resources', async (request, reply) => {
    await authenticate(pool, sessionSecret, request);
    await reply
      .type(HTML)
      .send(renderImmediateResources(shell('Immediate Resources'), safetyCopyMode));
  });

  app.get('/app/resources', async (request, reply) => {
    await authenticate(pool, sessionSecret, request);
    await reply
      .type(HTML)
      .send(renderResourceCategories({ shell: shell('Find help'), categories: CATEGORY_CARDS }));
  });

  app.get<{ Params: { label: string } }>('/app/resources/:label', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);

    const card = CATEGORY_CARDS.find(
      (entry) => entry.label.toLowerCase().replace(/ /g, '-') === request.params.label,
    );
    if (card === undefined) {
      throw new NonOperationalCategoryError(request.params.label, 'COMING_SOON');
    }

    // §6: a non-operational card renders its information state and never
    // reaches the catalog as if it were a released category.
    if (card.disposition !== 'OPERATIONAL') {
      await reply.type(HTML).send(
        renderResourceList({
          shell: shell(card.label),
          categoryLabel: card.label,
          backHref: '/app/resources',
          rows: [],
        }),
      );
      return;
    }

    const category = categoryForCard(card.label);
    const results = await searchResources(pool, context.tenantId, {
      category,
      activeOnly: true,
    });

    const rows: ResourceRowViewModel[] = results.map((result) => ({
      id: result.resource.resourceId,
      name: result.resource.serviceName,
      freshness: result.freshness,
      staleWarning: result.staleWarning,
      ...(result.resource.counties.length > 0
        ? { coverage: result.resource.counties.join(', ') }
        : {}),
      ...(result.resource.contactMethod === undefined
        ? {}
        : { contactMethod: result.resource.contactMethod }),
      ...(result.resource.contactMethodKind === undefined
        ? {}
        : { contactMethodKind: result.resource.contactMethodKind }),
      ...(result.resource.hours === undefined ? {} : { hours: result.resource.hours }),
      ...(result.resource.cost === undefined ? {} : { cost: result.resource.cost }),
    }));

    await reply.type(HTML).send(
      renderResourceList({
        shell: shell(card.label),
        categoryLabel: card.label,
        backHref: '/app/resources',
        rows,
      }),
    );
  });

  app.get('/app/chat', async (request, reply) => {
    await authenticate(pool, sessionSecret, request);

    // §5 requires a persistent Chat entry, and no released slice implements a
    // message thread store. The surface exists and states its unavailability
    // rather than rendering an empty inbox that implies messaging works.
    await reply.type(HTML).send(
      renderChat({
        shell: shell('Chat', { currentNav: 'CHAT' }),
        availability: {
          status: 'UNAVAILABLE',
          reason:
            'Messaging is not available yet. Your responder will contact you through ' +
            'the channels you have consented to.',
        },
      }),
    );
  });

  // --- Responder surfaces ----------------------------------------------------

  app.get('/app/responder', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    const queue = await readCaseQueue(
      pool,
      context.tenantId,
      { ownership: 'mine', responderUserId: context.userId },
      { limit: 20 },
    );

    await reply.type(HTML).send(
      renderResponderDashboard({
        shell: shell('Responder', { viewport: 'DESKTOP' }),
        // Availability is not a released domain fact; RESPONDER_WORKFLOWS.md
        // has no on-duty store, so this reflects nothing rather than inventing
        // a roster. Returned to specs.
        onDuty: false,
        activeNeeds: queue.cases.map((supportCase) => ({
          caseId: supportCase.caseId,
          caseStatus: supportCase.status,
          category: 'PEER_SUPPORT',
          openedLabel: 'Opened',
        })),
        alerts: [],
        quickShareCategories: CATEGORY_CARDS.filter((card) => card.disposition === 'OPERATIONAL'),
        // §9: no released definition for these, so no value is displayed.
        metrics: [
          { label: 'Responses', state: 'NOT_COMPUTABLE', reason: 'No released definition' },
          { label: 'Avg Response', state: 'NOT_COMPUTABLE', reason: 'No released definition' },
        ],
      }),
    );
  });

  app.get('/app/responder/needs', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    const queue = await readCaseQueue(
      pool,
      context.tenantId,
      { ownership: 'mine', responderUserId: context.userId },
      { limit: 20 },
    );

    await reply.type(HTML).send(
      renderActiveNeeds({
        shell: shell('Active Needs', { viewport: 'DESKTOP' }),
        needs: queue.cases.map((supportCase) => ({
          caseId: supportCase.caseId,
          caseStatus: supportCase.status,
          category: 'PEER_SUPPORT',
          openedLabel: 'Opened',
        })),
      }),
    );
  });

  // --- Admin surface ---------------------------------------------------------

  app.get('/app/admin', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    // §7.5 asks for clearer scope than the prototype; ADMIN.md §2 and
    // SECURITY.md §2 supply the actual gate.
    assertSuasAdmin(context);
    assertMfaElevated(context, 'Viewing the admin overview');

    await reply.type(HTML).send(
      renderAdminOverview({
        shell: shell('SUAS Admin', { viewport: 'DESKTOP', showMobileNav: false }),
        tenantLabel: context.tenantId,
        // Presence only. ARCHITECTURE.md forbids credential values on any
        // domain or admin surface.
        capabilities: [
          { name: 'Peer support (manual)', presence: 'CONFIGURED' },
          {
            name: 'Provider disclosure projections',
            presence: 'MISSING',
            note: 'no released contracts',
          },
          { name: 'Support signal scoring', presence: 'MISSING', note: 'D-011 pending' },
          {
            name: 'Approved safety copy',
            presence: safetyCopyMode === 'approved' ? 'CONFIGURED' : 'MISSING',
            note:
              safetyCopyMode === 'approved'
                ? `D-012 ${D_012_APPROVED_SAFETY_COPY}; SUAS_SAFETY_COPY_MODE=approved`
                : `D-012 ${D_012_APPROVED_SAFETY_COPY}; SUAS_SAFETY_COPY_MODE=${safetyCopyMode}`,
          },
        ],
        blockingDecisions: [
          'D-011 Support Signal scoring rules and thresholds',
          'D-017 to D-020 production provider adapters',
        ],
        readiness: 'SPEC-017 implementation. Not authorized for pilot or production operation.',
      }),
    );
  });
}
