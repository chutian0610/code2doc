import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(repoRoot, 'test/fixtures/sample-ts');

/**
 * Bin acceptance: the packed artifact, installed into a clean prefix,
 * exposes a working `code2doc` bin.
 */
describe('code2doc package bin', () => {
  it('runs init via an installed bin from the packed tarball', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'code2doc-pack-'));
    execFileSync('npm', ['pack', '--pack-destination', work], { cwd: repoRoot, stdio: 'pipe' });
    const tgzName = readdirSync(work).find((f) => f.endsWith('.tgz'));
    expect(tgzName).toBeDefined();
    const tgz = path.join(work, tgzName!);

    const prefix = path.join(work, 'prefix');
    execFileSync('npm', ['install', '--prefix', prefix, tgz], { stdio: 'pipe' });

    const project = path.join(work, 'project');
    cpSync(fixture, project, { recursive: true });

    const bin = path.join(prefix, 'node_modules', '.bin', 'code2doc');
    const stdout = execFileSync(bin, ['init'], { cwd: project, encoding: 'utf8' });
    const report = JSON.parse(stdout);
    expect(report.filesScanned).toBe(2);
    expect(report.publicCount).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
