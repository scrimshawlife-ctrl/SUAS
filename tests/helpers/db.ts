/**
 * Integration-test database helpers.
 *
 * SUAS-specs ENVIRONMENT.md §2: TEST is synthetic-only. All identifiers below are
 * generated UUIDs, not copied production data (TESTING.md §12).
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { testDatabaseUrl } from './env.js';

export function createTestPool(max = 6): Pool {
  return new Pool({ connectionString: testDatabaseUrl(), max });
}

/**
 * Clear kernel tables between tests.
 *
 * TRUNCATE is used deliberately: the append-only triggers on the event stores
 * reject row-level UPDATE and DELETE, which is the behavior under test.
 */
export async function resetKernelTables(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE processed_events, event_outbox, command_idempotency_records, audit_events,
             domain_events, consent_events, consent_grants, trusted_contacts,
             consent_template_versions, notification_delivery_callbacks, notifications,
             notification_preferences, provider_webhook_deliveries, service_fulfillments,
             fulfillment_attempts, referrals, resources, provider_adapter_configurations,
             service_providers, follow_ups, settlements, service_requests,
             contact_attempts, case_notes, case_assignments, support_cases,
             sessions, auth_challenges, auth_rate_limits,
             suas_admin_grants, organization_memberships, organizations, users
    RESTART IDENTITY CASCADE
  `);
}

/** Synthetic tenant scope for a test. */
export function syntheticTenantId(): string {
  return randomUUID();
}

export function syntheticAggregateId(): string {
  return randomUUID();
}
