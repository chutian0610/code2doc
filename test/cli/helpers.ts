import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const bin = path.join(repoRoot, 'dist/cli.js');
export const tsFixture = path.join(repoRoot, 'test/fixtures/sample-ts');
export const docsFixture = path.join(repoRoot, 'test/fixtures/sample-docs');

let built = false;

/** Build the CLI once per suite; every other helper needs dist/cli.js. */
export function buildCli(): void {
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' });
  built = true;
}

/** Run the built CLI in a fixture dir, capturing stdout/stderr and exit code. */
export function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; code: number } {
  if (!built) throw new Error('build first (call buildCli in beforeAll)');
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // init on a large repo prints a symbol report in the megabytes
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? e.code ?? 1 };
  }
}

/** Copy a pristine fixture into a temp dir so init can write freely. */
export function copyFixture(fixture: string, prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

export interface Sym {
  name: string;
  file: string;
  fingerprint: { signature: string; body: string };
}

/** The anchor an Operator writes from an init report symbol. */
export function anchorLink(sym: Sym): string {
  const { signature, body } = sym.fingerprint;
  return `[${sym.name}](../${sym.file} "c2d:${sym.file}#${sym.name}:${signature}.${body}")`;
}

/** Declare the manifest the Operator would plan. */
export function declarePages(dir: string, entries: unknown[]): void {
  writeFileSync(
    path.join(dir, 'docs', 'manifest.json'),
    JSON.stringify({ pages: entries }, null, 2),
    'utf8',
  );
}

/** Write a page under docs/ as the Operator would. */
export function writePage(dir: string, file: string, markdown: string): void {
  const abs = path.join(dir, 'docs', file);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, markdown, 'utf8');
}
