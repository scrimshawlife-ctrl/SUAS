/**
 * HTTP surface.
 *
 * Spec citations:
 * - SUAS-specs API.md §2 (`/api/v0` is the sole canonical v0 version selector)
 * - SUAS-specs API.md §4 (authenticated session required unless documented
 *   otherwise; authorization is role + tenant + row + consent/system basis)
 * - SUAS-specs API.md §6 (canonical error body shape)
 * - SUAS-specs API.md §8 / ARCHITECTURE.md §14 (request correlation without PII)
 * - SUAS-specs ENVIRONMENT.md §8 (build-info surface without secrets or veteran PII)
 *
 * Product endpoints arrive with the slices that own them.
 */

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import type { SuasConfig } from '../config/index.js';
import { API_PREFIX } from '../release/pins.js';
import type { BuildInfo } from '../provenance/build-info.js';
import type { ChallengeDeliveryPort, MfaPort } from '../auth/index.js';
import { assertMfaElevated, assertSuasAdmin } from '../authz/index.js';
import { authenticate } from './authenticate.js';
import { registerAuthRoutes } from './routes/auth.js';

export interface ServerDependencies {
  readonly config: SuasConfig;
  /** Resolved per request so schema version reflects current state. */
  readonly buildInfo: () => BuildInfo;
  /** Persistence. Absent when the process runs without a database. */
  readonly pool?: Pool;
  readonly challengeDelivery?: ChallengeDeliveryPort;
  readonly mfa?: MfaPort;
}

/** Errors that declare a released API error code and HTTP status. API.md §6. */
function asDomainError(error: unknown): { code: string; httpStatus: number } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  // API.md §6: a malformed request body is 400, not an internal failure.
  if (error instanceof ZodError) {
    return { code: 'VALIDATION_FAILED', httpStatus: 400 };
  }

  const candidate = error as { code?: unknown; httpStatus?: unknown };
  return typeof candidate.code === 'string' && typeof candidate.httpStatus === 'number'
    ? { code: candidate.code, httpStatus: candidate.httpStatus }
    : undefined;
}

export function createServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      // ENVIRONMENT.md §6: secret material is never written to logs.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["idempotency-key"]',
        ],
        remove: true,
      },
    },
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      const supplied = Array.isArray(header) ? header[0] : header;
      // Correlation identifiers are opaque and carry no veteran PII.
      return supplied !== undefined && /^[A-Za-z0-9._-]{1,128}$/.test(supplied)
        ? supplied
        : randomUUID();
    },
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    done(null, payload);
  });

  // API.md §6 canonical error body.
  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Resource not found.' },
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Domain errors carry their own released conflict code and status
    // (API.md §6): for example IDEMPOTENCY_CONFLICT from the idempotency kernel.
    const domain = asDomainError(error);
    const status = domain?.httpStatus ?? error.statusCode ?? 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled request failure');
    }
    void reply.status(status).send({
      error: {
        code:
          domain?.code ??
          (status === 400
            ? 'VALIDATION_FAILED'
            : status >= 500
              ? 'INTERNAL_ERROR'
              : 'REQUEST_FAILED'),
        // Non-sensitive message only; internals are logged, not returned.
        message: status >= 500 ? 'Unexpected internal failure.' : error.message,
      },
    });
  });

  app.get(`${API_PREFIX}/health`, () => {
    // Liveness only. No provenance, configuration, or tenant data.
    return { status: 'ok' };
  });

  const pool = deps.pool;
  if (pool !== undefined && deps.challengeDelivery !== undefined && deps.mfa !== undefined) {
    registerAuthRoutes(app, {
      pool,
      sessionSecret: deps.config.sessionSecret,
      delivery: deps.challengeDelivery,
      mfa: deps.mfa,
    });

    // ENVIRONMENT.md §8 allows provenance on an admin/debug surface. Slice 3
    // supplies the admin authorization that Slice 1 lacked, so the route is now
    // registered in every environment class and gated on the SUAS-admin role with
    // an MFA-elevated session (AUTH.md §4; ADMIN.md §2; SECURITY.md §2).
    app.get(`${API_PREFIX}/admin/build-info`, async (request) => {
      const context = await authenticate(pool, deps.config.sessionSecret, request);
      assertSuasAdmin(context);
      assertMfaElevated(context, 'Reading build info');
      return deps.buildInfo();
    });
  }

  return app;
}
