import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bin = path.join(repoRoot, 'dist/cli.js');
const fixture = path.join(repoRoot, 'test/fixtures/sample-ts');

let built = false;

/** Copy the pristine fixture into a temp dir so init can write freely. */
function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'code2doc-'));
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

function run(args: string[], cwd: string): { stdout: string; code: number } {
  if (!built) throw new Error('build first');
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number; code?: number };
    return { stdout: e.stdout ?? '', code: e.status ?? e.code ?? 1 };
  }
}

describe('code2doc CLI', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' });
    built = true;
  });

  it('init creates config, empty manifest, doc skeleton and a symbol cache', () => {
    const dir = copyFixture();
    const { code, stdout } = run(['init'], dir);
    expect(code).toBe(0);

    const report = JSON.parse(stdout);
    expect(report.configPath).toBe('code2doc.config.json');
    expect(report.manifestPath).toBe(path.join('docs', 'manifest.json'));
    expect(existsSync(path.join(dir, 'code2doc.config.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'docs', 'manifest.json'))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'docs', 'manifest.json'), 'utf8'));
    expect(manifest.pages).toEqual([]);
    // doc-tree skeleton: a README explaining the manifest-driven tree
    expect(existsSync(path.join(dir, 'docs', 'README.md'))).toBe(true);
    expect(existsSync(path.join(dir, '.code2doc', 'cache.json'))).toBe(true);

    const config = JSON.parse(readFileSync(path.join(dir, 'code2doc.config.json'), 'utf8'));
    expect(config.docRoot).toBe('docs');
    expect(config.include.length).toBeGreaterThan(0);
  });

  it('init reports discovered modules and public symbols as JSON', () => {
    const dir = copyFixture();
    const { stdout } = run(['init'], dir);
    const report = JSON.parse(stdout);

    expect(report.filesScanned).toBe(2);
    const srcModule = report.modules.find((m: { dir: string }) => m.dir === 'src');
    expect(srcModule).toBeDefined();
    expect(srcModule.files).toBe(2);
    expect(srcModule.publicSymbols).toEqual(
      expect.arrayContaining(['greet', 'Greeter', 'usesHelper']),
    );
    expect(srcModule.internalCount).toBe(2);
    const publicNames = report.symbols.map((s: { name: string }) => s.name);
    expect(publicNames).not.toContain('helper');
    expect(publicNames).not.toContain('internalAnswer');
    expect(report.symbols.every((s: { visibility: string }) => s.visibility === 'public')).toBe(true);
  });

  it('init appends the cache dir to .gitignore without clobbering it', () => {
    const dir = copyFixture();
    run(['init'], dir);
    const gitignore = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.code2doc/');
  });

  it('skips files whose language has no extractor, via the include config', () => {
    const dir = copyFixture();
    run(['init'], dir);
    // widen include past the registry: the .java fixture must be skipped
    const configFile = path.join(dir, 'code2doc.config.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.include = ['**/*.{ts,tsx,js,jsx,mjs,cjs}', '**/*.java'];
    writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

    const { stdout } = run(['init'], dir);
    const report = JSON.parse(stdout);
    expect(report.filesScanned).toBe(2);
  });

  it('status with no pages exits 0 and reports all-accurate (JSON)', () => {
    const dir = copyFixture();
    run(['init'], dir);
    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.pages).toEqual([]);
    expect(report.summary).toEqual({ broken: 0, drift: 0, missing: 0 });
  });

  it('status prints a human-readable line when --json is absent', () => {
    const dir = copyFixture();
    run(['init'], dir);
    const { code, stdout } = run(['status'], dir);
    expect(code).toBe(0);
    expect(stdout).toContain('0 pages');
    expect(stdout).toContain('accurate');
  });

  it('status rebuilds the cache from scratch, with identical content, when it is missing', () => {
    const dir = copyFixture();
    const first = JSON.parse(run(['init'], dir).stdout);
    const before = JSON.parse(readFileSync(path.join(dir, '.code2doc', 'cache.json'), 'utf8'));

    rmSync(path.join(dir, '.code2doc'), { recursive: true, force: true });
    const { code } = run(['status', '--json'], dir);
    expect(code).toBe(0);

    const after = JSON.parse(readFileSync(path.join(dir, '.code2doc', 'cache.json'), 'utf8'));
    expect(Object.keys(after.files)).toEqual(Object.keys(before.files));
    const symbolCount = (cache: { files: Record<string, { symbols: unknown[] }> }) =>
      Object.values(cache.files).reduce((n, f) => n + f.symbols.length, 0);
    expect(symbolCount(after)).toBe(symbolCount(before));
    expect(first.publicCount + first.internalCount).toBe(symbolCount(before));
  });

  it('status fails with exit 3 (not a report code) when the repo is not initialized', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code2doc-empty-'));
    const { code } = run(['status', '--json'], dir);
    expect(code).toBe(3);
  });
});
