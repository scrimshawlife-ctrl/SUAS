/**
 * Trusted Circle membership.
 *
 * Spec citations:
 * - SUAS-specs TRUSTED_CIRCLE.md §1 — membership alone grants no visibility
 * - §2 lifecycle INVITED → ACCEPTED → SUSPENDED | REMOVED | REVOKED
 * - §3 invite/accept; consent is not implied by accept
 * - §4 the relationship label is not a permission
 * - §6 membership is evaluated before grants
 * - §7 transitions are audited
 * - SUAS-specs DOMAIN_MODEL.md §4 "TrustedContact"
 *
 * This module holds the relationship only. Every permission lives on a Consent
 * Grant, and nothing here can grant visibility.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import { normalizeDestination } from '../auth/secrets.js';

export const TRUSTED_CONTACT_STATUSES = [
  'INVITED',
  'ACCEPTED',
  'SUSPENDED',
  'REMOVED',
  'REVOKED',
] as const;
export type TrustedContactStatus = (typeof TRUSTED_CONTACT_STATUSES)[number];

/**
 * Statuses in which a contact may be considered at all. TRUSTED_CIRCLE.md §2:
 * INVITED has no data visibility, and SUSPENDED evaluates as deny while
 * suspended even though grants remain.
 */
const USABLE_STATUSES: readonly TrustedContactStatus[] = ['ACCEPTED'];

/**
 * Terminal statuses. TRUSTED_CIRCLE.md §2 ends the lifecycle at REMOVED/REVOKED;
 * a relationship past either is over and must not transition again (in
 * particular, never back to ACCEPTED — that would silently restore a removed
 * contact's membership and, with any leftover grant, their access).
 * Re-establishing a relationship requires a fresh invite.
 */
const TERMINAL_STATUSES: readonly TrustedContactStatus[] = ['REMOVED', 'REVOKED'];

export interface TrustedContact {
  readonly trustedContactId: string;
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly contactUserId: string | undefined;
  readonly relationshipLabel: string;
  readonly status: TrustedContactStatus;
}

interface ContactRow {
  trusted_contact_id: string;
  tenant_id: string;
  veteran_user_id: string;
  contact_user_id: string | null;
  relationship_label: string;
  status: TrustedContactStatus;
}

const CONTACT_COLUMNS = `
  trusted_contact_id, tenant_id, veteran_user_id, contact_user_id,
  relationship_label, status
`;

function toContact(row: ContactRow): TrustedContact {
  return {
    trustedContactId: row.trusted_contact_id,
    tenantId: row.tenant_id,
    veteranUserId: row.veteran_user_id,
    contactUserId: row.contact_user_id ?? undefined,
    relationshipLabel: row.relationship_label,
    status: row.status,
  };
}

export class TrustedContactChannelRequiredError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor() {
    super(
      'A Trusted Contact invite requires an email address or a phone number ' +
        '(SUAS-specs TRUSTED_CIRCLE.md §3.1).',
    );
    this.name = 'TrustedContactChannelRequiredError';
  }
}

export class TrustedContactTerminalError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(status: TrustedContactStatus) {
    super(
      `A ${status} Trusted Contact is in a terminal state and cannot change status ` +
        `(SUAS-specs TRUSTED_CIRCLE.md §2). Re-establishing the relationship requires a new invite.`,
    );
    this.name = 'TrustedContactTerminalError';
  }
}

export interface InviteTrustedContactInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly relationshipLabel: string;
  readonly inviteEmail?: string;
  readonly invitePhone?: string;
  readonly inviteTemplateVersion?: string;
}

/**
 * Create an invite.
 *
 * TRUSTED_CIRCLE.md §3.2: the system contacts only the addresses the veteran
 * provided. Delivery itself belongs to Notifications (Slice 8); this records the
 * relationship. TRUSTED_CIRCLE.md §11: an invite must not emit
 * `TRUSTED_CONTACT_ALERTED`, so callers emit `TRUSTED_CONTACT_INVITED` only.
 */
export async function inviteTrustedContact(
  db: Queryable,
  input: InviteTrustedContactInput,
): Promise<TrustedContact> {
  const email = input.inviteEmail === undefined ? null : normalizeDestination(input.inviteEmail);
  const phone = input.invitePhone === undefined ? null : normalizeDestination(input.invitePhone);
  if (email === null && phone === null) {
    throw new TrustedContactChannelRequiredError();
  }

  const result = await db.query<ContactRow>(
    `INSERT INTO trusted_contacts
       (trusted_contact_id, tenant_id, veteran_user_id, relationship_label,
        invite_email, invite_phone, invite_template_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${CONTACT_COLUMNS}`,
    [
      randomUUID(),
      input.tenantId,
      input.veteranUserId,
      input.relationshipLabel,
      email,
      phone,
      input.inviteTemplateVersion ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Trusted contact insert returned no row.');
  return toContact(row);
}

/**
 * Accept an invite, optionally binding an enrolled User.
 *
 * TRUSTED_CIRCLE.md §3.4: acceptance does not imply consent. The veteran must
 * still issue grants, and this function issues none.
 */
export async function acceptTrustedContact(
  db: Queryable,
  tenantId: string,
  trustedContactId: string,
  contactUserId?: string,
): Promise<TrustedContact | undefined> {
  const result = await db.query<ContactRow>(
    `UPDATE trusted_contacts
       SET status = 'ACCEPTED', accepted_at = now(), updated_at = now(),
           contact_user_id = COALESCE($3, contact_user_id)
     WHERE tenant_id = $1 AND trusted_contact_id = $2 AND status = 'INVITED'
     RETURNING ${CONTACT_COLUMNS}`,
    [tenantId, trustedContactId, contactUserId ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toContact(row);
}

/**
 * Move a contact to a terminal or suspended state.
 *
 * TRUSTED_CIRCLE.md §7: each transition is audited by the caller. Grants are not
 * touched here — §6 requires membership to be evaluated before grants, so a
 * removed contact is denied regardless of leftover grants. A caller that wants
 * grants revoked as part of removal revokes them explicitly and emits
 * `CONSENT_REVOKED` per grant.
 */
export async function setTrustedContactStatus(
  db: Queryable,
  tenantId: string,
  trustedContactId: string,
  status: Exclude<TrustedContactStatus, 'INVITED'>,
): Promise<TrustedContact | undefined> {
  const terminal = status === 'REMOVED' || status === 'REVOKED';
  // The `status <> ALL(terminal)` predicate makes terminal immutability atomic:
  // a REMOVED/REVOKED row matches nothing and is never re-opened, even under a
  // concurrent transition.
  const result = await db.query<ContactRow>(
    `UPDATE trusted_contacts
       SET status = $3::suas_trusted_contact_status,
           ended_at = CASE WHEN $4::boolean THEN now() ELSE ended_at END,
           updated_at = now()
     WHERE tenant_id = $1 AND trusted_contact_id = $2
       AND status <> ALL($5::suas_trusted_contact_status[])
     RETURNING ${CONTACT_COLUMNS}`,
    [tenantId, trustedContactId, status, terminal, TERMINAL_STATUSES],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Distinguish "no such contact" (undefined, as before) from "refused
    // because the contact is already terminal".
    const existing = await findTrustedContact(db, tenantId, trustedContactId);
    if (existing !== undefined && TERMINAL_STATUSES.includes(existing.status)) {
      throw new TrustedContactTerminalError(existing.status);
    }
    return undefined;
  }
  return toContact(row);
}

export async function findTrustedContact(
  db: Queryable,
  tenantId: string,
  trustedContactId: string,
): Promise<TrustedContact | undefined> {
  const result = await db.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM trusted_contacts
     WHERE tenant_id = $1 AND trusted_contact_id = $2`,
    [tenantId, trustedContactId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toContact(row);
}

/** The veteran's circle. Responders do not receive this roster by default (§8). */
export async function listTrustedCircle(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
): Promise<TrustedContact[]> {
  const result = await db.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM trusted_contacts
     WHERE tenant_id = $1 AND veteran_user_id = $2
     ORDER BY invited_at`,
    [tenantId, veteranUserId],
  );
  return result.rows.map(toContact);
}

/**
 * Whether a contact's membership permits any use at all, before grants are even
 * considered. TRUSTED_CIRCLE.md §6: "evaluate membership first".
 */
export function membershipPermitsUse(contact: TrustedContact | undefined): boolean {
  return contact !== undefined && USABLE_STATUSES.includes(contact.status);
}
