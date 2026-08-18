/**
 * Consent template versions.
 *
 * Spec citations:
 * - SUAS-specs CONSENT.md §6 — grants reference `consent_template_version`;
 *   template text is published by SUAS-admin; exact copy is `NOT_COMPUTABLE`
 *   until written; "Do not ship grants against unpublished templates."
 * - SUAS-specs ADMIN.md §2 — consent templates are a SUAS-admin publication
 *   surface, with MFA and audit.
 *
 * This module ships no template copy. Bodies are supplied by an administrator at
 * runtime, because no released text exists to ship.
 */

import type { Queryable } from '../db/transaction.js';

export type ConsentTemplateStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';

export interface ConsentTemplateVersion {
  readonly versionKey: string;
  readonly templateKey: string;
  readonly version: number;
  readonly status: ConsentTemplateStatus;
  readonly body: string | undefined;
}

export class ConsentTemplateNotPublishedError extends Error {
  readonly code = 'CONSENT_TEMPLATE_UNAVAILABLE';
  readonly httpStatus = 422;

  constructor(versionKey: string) {
    super(
      `Consent template version "${versionKey}" is not published. A grant cannot reference an ` +
        `unpublished template (SUAS-specs CONSENT.md §6).`,
    );
    this.name = 'ConsentTemplateNotPublishedError';
  }
}

interface TemplateRow {
  version_key: string;
  template_key: string;
  version: number;
  status: ConsentTemplateStatus;
  body: string | null;
}

const TEMPLATE_COLUMNS = 'version_key, template_key, version, status, body';

function toTemplate(row: TemplateRow): ConsentTemplateVersion {
  return {
    versionKey: row.version_key,
    templateKey: row.template_key,
    version: row.version,
    status: row.status,
    body: row.body ?? undefined,
  };
}

/** Compose the textual version key. DATA_MODEL.md §1 allows a textual version key. */
export function consentTemplateVersionKey(templateKey: string, version: number): string {
  return `${templateKey}@${version}`;
}

export async function createConsentTemplateVersion(
  db: Queryable,
  input: { templateKey: string; version: number; body?: string },
): Promise<ConsentTemplateVersion> {
  const versionKey = consentTemplateVersionKey(input.templateKey, input.version);
  const result = await db.query<TemplateRow>(
    `INSERT INTO consent_template_versions (version_key, template_key, version, body)
     VALUES ($1, $2, $3, $4)
     RETURNING ${TEMPLATE_COLUMNS}`,
    [versionKey, input.templateKey, input.version, input.body ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Consent template insert returned no row.');
  return toTemplate(row);
}

/**
 * Publish a template version. Callers append the Audit Event, since the acting
 * administrator's identity and request context belong to them (ADMIN.md §2).
 */
export async function publishConsentTemplateVersion(
  db: Queryable,
  versionKey: string,
  publishedBy: string | undefined,
): Promise<ConsentTemplateVersion | undefined> {
  const result = await db.query<TemplateRow>(
    `UPDATE consent_template_versions
       SET status = 'PUBLISHED', published_at = now(), published_by = $2
     WHERE version_key = $1 AND status = 'DRAFT'
     RETURNING ${TEMPLATE_COLUMNS}`,
    [versionKey, publishedBy ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toTemplate(row);
}

export async function findConsentTemplateVersion(
  db: Queryable,
  versionKey: string,
): Promise<ConsentTemplateVersion | undefined> {
  const result = await db.query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM consent_template_versions WHERE version_key = $1`,
    [versionKey],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toTemplate(row);
}

/** Throw unless the version exists and is published. CONSENT.md §6. */
export async function assertTemplatePublished(db: Queryable, versionKey: string): Promise<void> {
  const template = await findConsentTemplateVersion(db, versionKey);
  if (template === undefined || template.status !== 'PUBLISHED') {
    throw new ConsentTemplateNotPublishedError(versionKey);
  }
}
