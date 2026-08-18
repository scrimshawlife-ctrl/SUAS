/**
 * Migration planning evidence (no database required).
 *
 * SUAS-specs ENVIRONMENT.md §9 "Migration and compatibility rules".
 */

import { describe, expect, it } from 'vitest';
import { checksumOf, loadMigrationFiles, planMigrations } from '../../src/db/index.js';
import type { AppliedMigration } from '../../src/db/index.js';

function applied(version: number, name: string, checksum: string): AppliedMigration {
  return { version, name, checksum, appliedAt: new Date('2026-08-18T00:00:00Z') };
}

describe('on-disk migration set', () => {
  it('loads contiguous, well-named migrations', async () => {
    const files = await loadMigrationFiles();
    expect(files.length).toBeGreaterThan(0);
    files.forEach((file, index) => {
      expect(file.version).toBe(index + 1);
      expect(file.fileName).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    });
  });

  it('produces a stable checksum that ignores line-ending changes', () => {
    expect(checksumOf('SELECT 1;\n')).toBe(checksumOf('SELECT 1;\r\n'));
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });
});

describe('planMigrations', () => {
  const file = {
    version: 1,
    name: 'baseline',
    fileName: '0001_baseline.sql',
    sql: 'SELECT 1;',
    checksum: checksumOf('SELECT 1;'),
  };

  it('reports an unapplied migration as pending', () => {
    const plan = planMigrations([file], []);
    expect(plan.pending).toHaveLength(1);
    expect(plan.drifted).toHaveLength(0);
    expect(plan.orphaned).toHaveLength(0);
  });

  it('reports nothing when history matches the files', () => {
    const plan = planMigrations([file], [applied(1, 'baseline', file.checksum)]);
    expect(plan.pending).toHaveLength(0);
    expect(plan.drifted).toHaveLength(0);
    expect(plan.orphaned).toHaveLength(0);
  });

  it('detects an applied migration that was edited afterwards', () => {
    const plan = planMigrations([file], [applied(1, 'baseline', checksumOf('SELECT 2;'))]);
    expect(plan.drifted).toEqual([{ version: 1, name: 'baseline' }]);
  });

  it('detects a database ahead of the build', () => {
    const plan = planMigrations(
      [file],
      [applied(1, 'baseline', file.checksum), applied(2, 'from_the_future', 'deadbeef')],
    );
    expect(plan.orphaned).toHaveLength(1);
    expect(plan.orphaned[0]?.version).toBe(2);
  });
});
