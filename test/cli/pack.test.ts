import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(repoRoot, 'test/fixtures/sample-ts');
const docsFixture = path.join(repoRoot, 'test/fixtures/sample-docs');

let work: string;
let tgz: string;

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'code2doc-pack-'));
  execFileSync('npm', ['pack', '--pack-destination', work], { cwd: repoRoot, stdio: 'pipe' });
  const tgzName = readdirSync(work).find((f) => f.endsWith('.tgz'));
  expect(tgzName).toBeDefined();
  tgz = path.join(work, tgzName!);
}, 120_000);

/**
 * Tarball shape: only the runtime artifact ships — dist plus package
 * metadata, never sources or tests. What `files` declares, verified.
 */
describe('code2doc tarball contents', () => {
  it('ships dist and package metadata only', () => {
    const entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(entries).toContain('package/dist/cli.js');
    expect(entries).toContain('package/LICENSE');
    const shipped = entries.filter((e) => e.startsWith('package/'));
    expect(
      shipped.every((e) => /^package\/(dist\/|LICENSE$|README\.md$|package\.json$)/.test(e)),
    ).toBe(true);
  });
});

/**
 * Bin acceptance: the packed artifact, installed into a clean prefix,
 * exposes a working `code2doc` bin.
 */
describe('code2doc package bin', () => {
  it('runs init via an installed bin from the packed tarball', () => {
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

/**
 * npx acceptance: the packed artifact runs from a clean environment —
 * no dev deps, no pre-built cache — exactly how a remote Operator
 * would invoke it against a repo it just cloned.
 */
describe('code2doc via npx', () => {
  it('init + status run in a clean directory against a fixture repo', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'code2doc-npx-'));
    // the committed fixture: docs with anchors, no config, no cache
    cpSync(docsFixture, project, { recursive: true });
    expect(existsSync(path.join(project, '.code2doc'))).toBe(false);

    // --package with a tarball spec: npx installs the package and its
    // runtime deps into its own cache, nothing else
    const init = execFileSync(
      'npx',
      ['--yes', '--package', tgz, 'code2doc', 'init'],
      { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const report = JSON.parse(init);
    expect(report.filesScanned).toBe(2);
    // init preserved the committed manifest and built the cache
    expect(existsSync(path.join(project, '.code2doc', 'cache.json'))).toBe(true);

    const status = JSON.parse(
      execFileSync('npx', ['--yes', '--package', tgz, 'code2doc', 'status', '--json'], {
        cwd: project,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    // anchor verification (WASM grammars) works from the packed artifact too
    expect(status.summary).toEqual({ broken: 0, drift: 0, ripple: 0, missing: 0 });
    expect(status.pages).toHaveLength(5);
  }, 180_000);
});
