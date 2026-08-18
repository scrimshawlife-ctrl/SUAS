/**
 * Repository hygiene evidence.
 *
 * SUAS-specs ENVIRONMENT.md §7 (`.env.example` names with safe placeholders only;
 * no committed `.env`, credentials, real contact details, or production data);
 * SUAS-specs HANDOFF.md §5 (hygiene expected from the first implementation PR);
 * SUAS-specs AGENTS.md rule 17 (never commit secrets).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG_VARIABLE_NAMES } from '../../src/config/index.js';
import { scanForNonSyntheticContactData } from '../../src/testing/fixture-boundary.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Tracked files plus untracked files git would accept. Scanning only tracked
 * files would let new work pass the hygiene gate before it is ever staged.
 */
function repositoryFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.trim() !== '');
}

describe('ENVIRONMENT.md §7 — repository files', () => {
  it('provides a .env.example', () => {
    expect(existsSync(new URL('../../.env.example', import.meta.url))).toBe(true);
  });

  it('documents every configuration variable the build reads', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const documented = new Set(
      example
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => line.split('=')[0]?.trim())
        .filter((name): name is string => name !== undefined),
    );

    const missing = CONFIG_VARIABLE_NAMES.filter((name) => !documented.has(name));
    expect(missing, `.env.example is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('carries no secret values in .env.example', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    // The session secret slot must ship empty rather than with usable material.
    expect(example).toMatch(/^SUAS_SESSION_SECRET=\s*$/m);
  });

  it('does not track a .env file or key material', () => {
    const offenders = repositoryFiles().filter(
      (file) =>
        file === '.env' ||
        (file.startsWith('.env.') && file !== '.env.example') ||
        /\.(pem|key|p12|pfx)$/.test(file),
    );
    expect(offenders).toEqual([]);
  });
});

describe('TESTING.md §12 — fixtures are synthetic', () => {
  it('contains no routable contact data in tracked source, fixture, or doc files', () => {
    const scannable = repositoryFiles().filter(
      (file) => /\.(ts|js|sql|json|md|yml|yaml)$/.test(file) && file !== 'package-lock.json',
    );

    const findings: string[] = [];
    for (const file of scannable) {
      // The boundary module and its tests deliberately contain counter-examples.
      if (
        file === 'src/testing/fixture-boundary.ts' ||
        file === 'tests/unit/fixture-boundary.test.ts'
      ) {
        continue;
      }
      const contents = readFileSync(new URL(file, `file://${repoRoot}`), 'utf8');
      for (const finding of scanForNonSyntheticContactData(contents)) {
        findings.push(`${file}: ${finding.kind} ${finding.value} — ${finding.reason}`);
      }
    }

    expect(findings, findings.join('\n')).toEqual([]);
  });
});
