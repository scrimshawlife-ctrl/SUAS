/**
 * Minimum-necessary projection evidence.
 *
 * SUAS-specs PRIVACY.md §4, §7; CONSENT.md §5, §9, §10;
 * PROVIDER_INTEGRATIONS.md §13.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearProjectionContracts,
  FORBIDDEN_PROJECTION_FIELDS,
  ForbiddenProjectionFieldError,
  projectForProvider,
  projectionContractFor,
  ProjectionContractUnavailableError,
  PROVIDER_CAPABILITIES,
  registerProjectionContract,
} from '../../src/privacy/index.js';

afterEach(() => {
  clearProjectionContracts();
});

describe('PROVIDER_INTEGRATIONS.md §13 — released capability contracts', () => {
  it('registers the released transportation and temporary shelter projections by default', () => {
    expect(projectionContractFor('TRANSPORTATION')?.allowedFields).toEqual([
      'rider',
      'pickup',
      'dropoff',
      'productId',
      'noteForDriver',
    ]);
    expect(projectionContractFor('TEMPORARY_SHELTER')?.allowedFields).toEqual([
      'location',
      'stay',
      'adults',
      'roomQuantity',
    ]);
    for (const capability of PROVIDER_CAPABILITIES.filter(
      (value) => value !== 'TRANSPORTATION' && value !== 'TEMPORARY_SHELTER',
    )) {
      expect(projectionContractFor(capability)).toBeUndefined();
    }
  });

  it('names the released requirement in the refusal, so the gap is legible', () => {
    try {
      projectForProvider('FOOD_SUPPORT', {});
    } catch (error) {
      expect((error as Error).message).toContain('PROVIDER_INTEGRATIONS.md §13');
    }
  });
});

describe('PRIVACY.md §4.2 — forbidden categories', () => {
  it('refuses to register a contract that names a forbidden category', () => {
    expect(() =>
      registerProjectionContract({
        capability: 'TRANSPORTATION',
        allowedFields: ['pickup_address', 'case_notes'],
        releasedIn: 'test-only',
      }),
    ).toThrow(ForbiddenProjectionFieldError);
  });

  it.each([
    'case_notes',
    'checkin_answers',
    'support_signal_basis',
    'trusted_circle',
    'audit_history',
    'ssn',
  ])('lists %s among the categories an adapter never receives by default', (field) => {
    expect(FORBIDDEN_PROJECTION_FIELDS).toContain(field);
  });
});

describe('projection behavior against a test-only contract', () => {
  // Override the released contract to exercise the generic registry mechanism.
  function registerTestContract(): void {
    registerProjectionContract({
      capability: 'TRANSPORTATION',
      allowedFields: ['service_request_id', 'pickup_address', 'destination_address'],
      releasedIn: 'test-only fixture; no released contract exists in v0.1.1',
    });
  }

  it('discloses only the contracted fields', () => {
    registerTestContract();
    const projection = projectForProvider('TRANSPORTATION', {
      service_request_id: 'req-1',
      pickup_address: '1 Test St',
      destination_address: '2 Test Ave',
      veteran_display_name: 'Should Not Travel',
      preferred_language: 'en',
    });

    expect(Object.keys(projection.fields).sort()).toEqual([
      'destination_address',
      'pickup_address',
      'service_request_id',
    ]);
    expect(projection.fields).not.toHaveProperty('veteran_display_name');
    expect(projection.fields).not.toHaveProperty('preferred_language');
  });

  it('reports the disclosed field names for the Audit Event, not the values', () => {
    registerTestContract();
    const projection = projectForProvider('TRANSPORTATION', {
      service_request_id: 'req-1',
      pickup_address: '1 Test St',
    });

    expect([...projection.disclosedFieldNames].sort()).toEqual([
      'pickup_address',
      'service_request_id',
    ]);
    expect(JSON.stringify(projection.disclosedFieldNames)).not.toContain('1 Test St');
  });

  it('refuses a source carrying a forbidden category rather than silently filtering it', () => {
    registerTestContract();
    // Failing loudly matters: a caller who hands over a whole Support Case should
    // be corrected, not quietly rescued by the allow-list.
    expect(() =>
      projectForProvider('TRANSPORTATION', {
        service_request_id: 'req-1',
        case_notes: ['note'],
      }),
    ).toThrow(ForbiddenProjectionFieldError);
  });

  it('omits contracted fields the source does not supply', () => {
    registerTestContract();
    const projection = projectForProvider('TRANSPORTATION', { service_request_id: 'req-1' });
    expect(projection.disclosedFieldNames).toEqual(['service_request_id']);
  });

  it('keeps released temporary shelter available while refusing unreleased capabilities', () => {
    registerTestContract();
    expect(projectForProvider('TEMPORARY_SHELTER', {}).fields).toEqual({});
    expect(() => projectForProvider('FOOD_SUPPORT', {})).toThrow(
      ProjectionContractUnavailableError,
    );
  });
});
