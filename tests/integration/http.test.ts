/**
 * HTTP surface and startup-sequence evidence.
 *
 * SUAS-specs API.md §2 (version selector), §6 (error body), §8 (correlation);
 * SUAS-specs ENVIRONMENT.md §5 (startup fails closed), §8 (build-info surface).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { ConfigurationError, loadConfig } from '../../src/config/index.js';
import { EXPECTED_SCHEMA_VERSION } from '../../src/db/index.js';
import { createServer } from '../../src/http/server.js';
import { buildInfo } from '../../src/provenance/build-info.js';
import { validEnv } from '../helpers/env.js';

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply' }),
    listen: false,
  });
});

afterAll(async () => {
  await app.close();
});

describe('startup sequence', () => {
  it('fails closed before serving traffic when configuration is invalid', async () => {
    await expect(
      startApp({ env: validEnv({ SUAS_SUPPORT_SIGNAL_MODE: 'production' }), listen: false }),
    ).rejects.toThrow(ConfigurationError);
  });

  it('brings up the durable-work seam and reports it as non-durable in TEST', () => {
    expect(app.jobQueue.durability).toBe('non-durable');
  });
});

describe('GET /api/v0/health', () => {
  it('reports liveness without provenance or configuration detail', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/v0/admin/build-info', () => {
  it('exposes the machine-readable provenance object', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/admin/build-info',
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.spec_version).toBe('0.1.1');
    expect(body.release_manifest).toBe('RELEASE_MANIFEST-0.1.1.md');
    expect(body.api_version).toBe('v0');
    expect(body.event_schema_version).toBe('0.1.0');
    expect(body.schema_version).toBe(EXPECTED_SCHEMA_VERSION);
    expect(body.environment).toBe('TEST');
    expect(body.production_readiness).toBe('NOT_READY');
  });

  it('carries no secret material', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/admin/build-info',
    });
    expect(response.body).not.toContain('suas:suas');
    expect(response.body).not.toContain('DATABASE_URL');
  });

  it('is not registered in PRODUCTION, where admin authorization does not yet exist', async () => {
    const config = { ...loadConfig(validEnv()), environment: 'PRODUCTION' as const };
    const server = createServer({
      config,
      buildInfo: () => buildInfo({ config, schemaVersion: 1, expectedSchemaVersion: 1, env: {} }),
    });
    const response = await server.inject({ method: 'GET', url: '/api/v0/admin/build-info' });
    expect(response.statusCode).toBe(404);
    await server.close();
  });
});

describe('API.md §6 — canonical error body', () => {
  it('returns the released error shape for an unknown route', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/not-a-route' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found.' },
    });
  });

  it('does not answer outside the /api/v0 version selector', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(404);
  });
});

describe('API.md §8 — request correlation', () => {
  it('echoes a supplied correlation id', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/health',
      headers: { 'x-request-id': 'corr-123' },
    });
    expect(response.headers['x-request-id']).toBe('corr-123');
  });

  it('generates an opaque correlation id when none is supplied', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/health' });
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('rejects a malformed correlation id rather than reflecting it', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/health',
      headers: { 'x-request-id': 'veteran name <injected>' },
    });
    expect(response.headers['x-request-id']).not.toBe('veteran name <injected>');
  });
});
