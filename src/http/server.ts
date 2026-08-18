/**
 * HTTP surface.
 *
 * Spec citations:
 * - SUAS-specs API.md §2 (`/api/v0` is the sole canonical v0 version selector)
 * - SUAS-specs API.md §6 (canonical error body shape)
 * - SUAS-specs API.md §8 / ARCHITECTURE.md §14 (request correlation without PII)
 * - SUAS-specs ENVIRONMENT.md §8 (build-info surface without secrets or veteran PII)
 *
 * Slice 1 exposes liveness and build provenance only. Product endpoints arrive
 * with the slices that own them.
 */

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { SuasConfig } from '../config/index.js';
import { API_PREFIX } from '../release/pins.js';
import type { BuildInfo } from '../provenance/build-info.js';

export interface ServerDependencies {
  readonly config: SuasConfig;
  /** Resolved per request so schema version reflects current state. */
  readonly buildInfo: () => BuildInfo;
}

/**
 * Build-info is an admin/debug surface (ENVIRONMENT.md §8). Admin authorization
 * does not exist until SPEC017_PLAN.md Slice 3, so the route is registered only
 * in the synthetic environment classes and stays unavailable in PRODUCTION rather
 * than being exposed unauthenticated.
 */
function buildInfoRouteAllowed(config: SuasConfig): boolean {
  return config.environment !== 'PRODUCTION';
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
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled request failure');
    }
    void reply.status(status).send({
      error: {
        code:
          status === 400
            ? 'VALIDATION_FAILED'
            : status >= 500
              ? 'INTERNAL_ERROR'
              : 'REQUEST_FAILED',
        // Non-sensitive message only; internals are logged, not returned.
        message: status >= 500 ? 'Unexpected internal failure.' : error.message,
      },
    });
  });

  app.get(`${API_PREFIX}/health`, () => {
    // Liveness only. No provenance, configuration, or tenant data.
    return { status: 'ok' };
  });

  if (buildInfoRouteAllowed(deps.config)) {
    app.get(`${API_PREFIX}/admin/build-info`, () => deps.buildInfo());
  }

  return app;
}
