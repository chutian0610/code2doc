import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { anchorLink, buildCli, copyFixture, declarePages, run, tsFixture, writePage } from './helpers.js';
import type { Sym } from './helpers.js';

/** init the fixture, then declare a reference page anchoring `greet` — the authoring flow. */
function setupWithAnchor(dir: string): Sym {
  const report = JSON.parse(run(['init'], dir).stdout);
  const greet = report.symbols.find((s: Sym) => s.name === 'greet');
  if (!greet) throw new Error('greet not in init report');
  writePage(dir, 'module.md', `# claims\n\n- ${anchorLink(greet)} does its thing.\n`);
  declarePages(dir, [{ path: 'module.md', type: 'reference' }]);
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

/** same name, changed signature: Broken by the vocabulary, never refresh's to fix */
const GREET_RESIGNED = `export function greet(name: string, punct: string): string {
  return 'hello ' + name + punct;
}
${GREETER}`;

describe('code2doc refresh', () => {
  beforeAll(buildCli);

  it('refreshes a drifted anchor back to fresh, claim text untouched', () => {
    const dir = copyFixture(tsFixture, 'code2doc-refresh-');
    setupWithAnchor(dir);
    // body edit, claim still holds: exactly the Drift case
    writeFileSync(
      path.join(dir, 'src', 'greet.ts'),
      `${GREET.replace("'hello '", "'hi '")}\n\n${GREETER}\n`,
      'utf8',
    );
    expect(run(['status', '--json'], dir).code).toBe(1);

    const result = run(['refresh'], dir);
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

    const result = run(['refresh'], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('all anchors already current');
    expect(readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8')).toBe(before);
  });

  it('leaves unresolvable anchors untouched and fails the run (exit 2)', () => {
    const dir = copyFixture(tsFixture, 'code2doc-refresh-');
    setupWithAnchor(dir);
    const before = readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8');
    writeFileSync(path.join(dir, 'src', 'greet.ts'), `${GREETER}\n`, 'utf8'); // greet gone

    const result = run(['refresh'], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('src/greet.ts#greet — symbol gone');
    // a vanished symbol is a rewrite, never a refresh: page stays as written
    expect(readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8')).toBe(before);
    expect(run(['status', '--json'], dir).code).toBe(2);
  });

  it('a signature change is unresolved too — refresh never masks Broken (ADR-0007)', () => {
    const dir = copyFixture(tsFixture, 'code2doc-refresh-');
    setupWithAnchor(dir);
    const before = readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8');
    writeFileSync(path.join(dir, 'src', 'greet.ts'), `${GREET_RESIGNED}\n`, 'utf8');

    const result = run(['refresh'], dir);
    expect(result.code).toBe(2); // the Broken report code: only a claim rewrite resolves it
    expect(result.stderr).toContain('signature changed');
    expect(readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8')).toBe(before);
    expect(run(['status', '--json'], dir).code).toBe(2); // still Broken afterwards
  });

  it('a page with both Drift and Broken re-signs the drift and still fails on the Broken one', () => {
    const dir = copyFixture(tsFixture, 'code2doc-refresh-');
    const report = JSON.parse(run(['init'], dir).stdout);
    const symbols = report.symbols as Sym[];
    const greet = symbols.find((s: Sym) => s.name === 'greet')!;
    const usesHelper = symbols.find((s: Sym) => s.name === 'usesHelper')!;
    writePage(
      dir,
      'module.md',
      `# claims\n\n- ${anchorLink(greet)} does its thing.\n- ${anchorLink(usesHelper)} lends a hand.\n`,
    );
    declarePages(dir, [{ path: 'module.md', type: 'reference' }]);
    // drift greet (body-only), vanish usesHelper (Broken) — one page, both classes
    writeFileSync(
      path.join(dir, 'src', 'greet.ts'),
      `${GREET.replace("'hello '", "'hi '")}\n\n${GREETER}\n`,
      'utf8',
    );
    writeFileSync(path.join(dir, 'src', 'helper.ts'), 'const leftover = 1;\n', 'utf8');
    expect(run(['status', '--json'], dir).code).toBe(2); // Broken blocks the run

    const result = run(['refresh'], dir);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('module.md: 1 anchor(s) refreshed'); // the reviewed-drift half
    expect(result.stderr).toContain('usesHelper — symbol gone'); // the Broken half, untouched

    const page = readFileSync(path.join(dir, 'code2doc', 'module.md'), 'utf8');
    expect(page).not.toContain('hello '); // greet re-signed
    expect(page).toContain('lends a hand.'); // usesHelper claim as written
    const after = JSON.parse(run(['status', '--json'], dir).stdout);
    expect(run(['status', '--json'], dir).code).toBe(2); // still Broken afterwards
    expect(after.summary.drift).toBe(0); // the drift half was resolved
  });

  it('a declared page with no file is unresolved at the page level', () => {
    const dir = copyFixture(tsFixture, 'code2doc-refresh-');
    run(['init'], dir);
    declarePages(dir, [{ path: 'ghost.md', type: 'reference' }]);

    const result = run(['refresh'], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ghost.md — page file missing');

    const report = JSON.parse(run(['refresh', '--json'], dir).stdout);
    expect(report.refreshed).toEqual([]);
    // page-level findings have no symbol: the page path must not masquerade as one
    expect(report.unresolved).toEqual([{ page: 'ghost.md', line: 0, reason: 'page file missing' }]);
  });

  it('--json prints what it touched and what it refused', () => {
    const dir = copyFixture(tsFixture, 'code2doc-refresh-');
    setupWithAnchor(dir);
    writeFileSync(
      path.join(dir, 'src', 'greet.ts'),
      `${GREET.replace("'hello '", "'hi '")}\n\n${GREETER}\n`,
      'utf8',
    );

    const ok = JSON.parse(run(['refresh', '--json'], dir).stdout);
    expect(ok.refreshed).toEqual([{ page: 'module.md', line: 3, symbol: 'src/greet.ts#greet' }]);
    expect(ok.unresolved).toEqual([]);

    writeFileSync(path.join(dir, 'src', 'greet.ts'), `${GREET_RESIGNED}\n`, 'utf8');
    const refused = JSON.parse(run(['refresh', '--json'], dir).stdout);
    expect(refused.refreshed).toEqual([]);
    expect(refused.unresolved).toEqual([
      { page: 'module.md', line: 3, symbol: 'src/greet.ts#greet', reason: 'signature changed' },
    ]);
  });

  it('fails with exit 3 when the repo is not initialized', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code2doc-empty-'));
    const { code } = run(['refresh', '--json'], dir);
    expect(code).toBe(3);
  });
});
