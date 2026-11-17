import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { anchorLink, buildCli, copyFixture, repoRoot, run, tsFixture } from './helpers';
import type { Sym } from './helpers';

const script = path.join(repoRoot, 'scripts', 'refresh-anchors.mjs');

/** Run the refresh script in a documented repo, like the helpers' `run` but for the script. */
function refresh(dir: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? e.code ?? 1 };
  }
}

/** init the fixture, then declare a reference page anchoring `greet` — the authoring flow. */
function setupWithAnchor(dir: string): Sym {
  const report = JSON.parse(run(['init'], dir).stdout);
  const greet = report.symbols.find((s: Sym) => s.name === 'greet');
  if (!greet) throw new Error('greet not in init report');
  writeFileSync(
    path.join(dir, 'code2doc', 'module.md'),
    `# claims\n\n- ${anchorLink(greet)} does its thing.\n`,
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'code2doc', 'manifest.json'),
    JSON.stringify({ pages: [{ path: 'module.md', type: 'reference' }] }, null, 2),
    'utf8',
  );
  return greet;
}

const GREET = `export function greet(name: string): string {
  return 'hello ' + name;
}`;

const GREETER = `export class Greeter {
  greeting: string;
  constructor(g: string) {
    this.greeting = g;
  }
  greet(): string {
    return this.greeting;
  }
}`;

describe('refresh-anchors script', () => {
  beforeAll(buildCli);

  it('refreshes a drifted anchor back to fresh, claim text untouched', () => {
    const dir = copyFixture(tsFixture, 'code2doc-refresh-');
    setupWithAnchor(dir);
    // body edit, claim still holds: exactly the script's case
    writeFileSync(
      path.join(dir, 'src', 'greet.ts'),
      `${GREET.replace("'hello '", "'hi '")}\n\n${GREETER}\n`,
      'utf8',
    );
    expect(run(['status', '--json'], dir).code).toBe(1);

    const result = refresh(dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('module.md: 1 anchor(s) refreshed');

    const page = readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8');
    expect(page).toContain('does its thing.'); // the claim as written
    expect(page).not.toContain('hello '); // …with the new hashes in its anchor
    expect(run(['status', '--json'], dir).code).toBe(0);
  });

  it('is a no-op when every anchor is current', () => {
    const dir = copyFixture(tsFixture, 'code2doc-refresh-');
    setupWithAnchor(dir);
    const before = readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8');

    const result = refresh(dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('all anchors already current');
    expect(readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8')).toBe(before);
  });

  it('leaves unresolvable anchors untouched and fails the run', () => {
    const dir = copyFixture(tsFixture, 'code2doc-refresh-');
    setupWithAnchor(dir);
    const before = readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8');
    writeFileSync(path.join(dir, 'src', 'greet.ts'), `${GREETER}\n`, 'utf8'); // greet gone

    const result = refresh(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('src/greet.ts#greet — symbol gone');
    // a vanished symbol is a rewrite, never a refresh: page stays as written
    expect(readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8')).toBe(before);
    expect(run(['status', '--json'], dir).code).toBe(2);
  });
});
