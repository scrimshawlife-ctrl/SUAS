/**
 * Discovery and checksumming of on-disk migration files.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §9 "Migration and compatibility rules"
 * - SUAS-specs HANDOFF.md §5 "migration directory and schema-version tracking"
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

/** Repository-root `migrations/` directory, resolved relative to this module. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Stable checksum over normalized content, so line-ending changes are not drift. */
export function checksumOf(sql: string): string {
  const normalized = sql.replace(/\r\n/g, '\n').trimEnd();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Read every migration in `dir`, ordered by version.
 * Throws on unparseable file names or duplicate/non-contiguous versions, so a
 * malformed migration set fails closed rather than applying a partial sequence.
 */
export async function loadMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((entry) => entry.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const fileName of entries) {
    const match = FILE_PATTERN.exec(fileName);
    if (match === null) {
      throw new Error(
        `Migration file "${fileName}" does not match the required NNNN_snake_case_name.sql pattern.`,
      );
    }
    const [, versionText, name] = match as unknown as [string, string, string];
    const sql = await readFile(join(dir, fileName), 'utf8');
    migrations.push({
      version: Number.parseInt(versionText, 10),
      name,
      fileName,
      sql,
      checksum: checksumOf(sql),
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `Migration versions must start at 1 and be contiguous; expected ${String(expected).padStart(4, '0')} ` +
          `but found "${migration.fileName}".`,
      );
    }
  });

  return migrations;
}
