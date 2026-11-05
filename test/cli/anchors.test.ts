import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { anchorLink, buildCli, copyFixture, run, tsFixture } from './helpers';
import type { Sym } from './helpers';

interface Page {
  path: string;
  type: string;
  state: string;
  note?: string;
  anchors: { symbol: string; state: string; reason: string; line: number }[];
}

function pages(stdout: string): Page[] {
  return JSON.parse(stdout).pages as Page[];
}

/**
 * init the fixture repo, then declare a module page anchoring the named
 * public symbols — exactly the Operator's authoring flow.
 */
function setupWithPage(dir: string, symbolNames: string[], extraMarkdown = ''): Sym[] {
  const report = JSON.parse(run(['init'], dir).stdout);
  const chosen = symbolNames.map((name) => report.symbols.find((s: Sym) => s.name === name));
  if (chosen.some((s: Sym | undefined) => !s)) throw new Error(`symbol not in init report`);

  const body = chosen.map((s: Sym) => `- ${anchorLink(s)} does its thing.`).join('\n');
  writeFileSync(
    path.join(dir, 'docs', 'module.md'),
    `# src module\n\n${body}\n${extraMarkdown}\n`,
    'utf8',
  );
  // A reference page: anchor freshness is this suite's subject, and module
  // pages additionally enforce export coverage (T4) — keep the two apart.
  writeFileSync(
    path.join(dir, 'docs', 'manifest.json'),
    JSON.stringify({ pages: [{ path: 'module.md', type: 'reference' }] }, null, 2),
    'utf8',
  );
  return chosen as Sym[];
}

function writeSource(dir: string, content: string): void {
  writeFileSync(path.join(dir, 'src', 'greet.ts'), content, 'utf8');
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

/** A greet.ts variant wrapping the given greet declaration. */
function greetSrc(greet: string): string {
  return `${greet}\n\n${GREETER}\n`;
}

describe('code2doc anchor verification (T2)', () => {
  beforeAll(buildCli);

  it('fresh: matching fingerprints exit 0, every anchor listed as fresh', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    const symbols = setupWithPage(dir, ['greet', 'Greeter']);

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    const page = pages(stdout)[0];
    expect(page.state).toBe('fresh');
    expect(page.anchors).toHaveLength(2);
    for (const anchor of page.anchors) {
      expect(anchor.state).toBe('fresh');
      expect(anchor.reason).toBe('');
    }
    expect(page.anchors.map((a) => a.symbol)).toEqual(
      symbols.map((s) => `${s.file}#${s.name}`),
    );
    expect(page.anchors[0].line).toBeGreaterThan(0);
    const report = JSON.parse(stdout);
    expect(report.summary).toEqual({ broken: 0, drift: 0, missing: 0 });
  });

  it('default output is human-readable and lists stale anchors with reasons', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    setupWithPage(dir, ['greet']);
    writeSource(dir, greetSrc(GREET.replace("'hello '", "'hi '")));

    const { code, stdout } = run(['status'], dir);
    expect(code).toBe(1);
    expect(stdout).toContain('module.md');
    expect(stdout).toContain('drift');
    expect(stdout).toContain('src/greet.ts#greet');
    expect(stdout).toContain('body changed');
  });

  it('body edit flips the anchor to drift and exits 1', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    setupWithPage(dir, ['greet', 'Greeter']);
    writeSource(dir, greetSrc(GREET.replace("'hello '", "'hi '")));

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(1);
    const page = pages(stdout)[0];
    expect(page.state).toBe('drift');
    const greet = page.anchors.find((a) => a.symbol === 'src/greet.ts#greet')!;
    expect(greet.state).toBe('drift');
    expect(greet.reason).toBe('body changed');
    const greeter = page.anchors.find((a) => a.symbol === 'src/greet.ts#Greeter')!;
    expect(greeter.state).toBe('fresh');
    expect(JSON.parse(stdout).summary).toEqual({ broken: 0, drift: 1, missing: 0 });
  });

  it('changing only a string literal inside the body still signals drift', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    setupWithPage(dir, ['greet']);
    // 'hello ' -> 'hello': a single space inside a string is a real change
    writeSource(dir, greetSrc(GREET.replace("'hello '", "'hello'")));

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(1);
    const greet = pages(stdout)[0].anchors[0];
    expect(greet.state).toBe('drift');
    expect(greet.reason).toBe('body changed');
  });

  it('signature edit flips the anchor to broken and exits 2', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    setupWithPage(dir, ['greet']);
    writeSource(dir, greetSrc(GREET.replace('(name: string)', '(name: string, prefix: string)')));

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const greet = pages(stdout)[0].anchors[0];
    expect(greet.state).toBe('broken');
    expect(greet.reason).toBe('signature changed');
  });

  it('deleting the symbol flips the anchor to broken (symbol gone), exit 2', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    setupWithPage(dir, ['greet']);
    writeSource(dir, `${GREETER}\n`);

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const greet = pages(stdout)[0].anchors[0];
    expect(greet.state).toBe('broken');
    expect(greet.reason).toBe('symbol gone');
  });

  it('deleting the whole file reports every anchor in it as symbol gone', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    setupWithPage(dir, ['greet', 'Greeter']);
    rmSync(path.join(dir, 'src', 'greet.ts'));

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const page = pages(stdout)[0];
    expect(page.state).toBe('broken');
    expect(page.anchors.every((a) => a.reason === 'symbol gone')).toBe(true);
  });

  it('comment and reflow-only edits keep the anchor fresh, exit 0', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    setupWithPage(dir, ['greet']);
    // same semantics: comments, blank lines, re-indentation, row shift
    writeSource(
      dir,
      greetSrc(`// leading comment shifts every row below it

export function greet(name: string): string {
      /* enthusiastic */
      return
          'hello '   +   name;
}`),
    );

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    const page = pages(stdout)[0];
    expect(page.state).toBe('fresh');
    expect(page.anchors[0].state).toBe('fresh');
  });

  it('a page with one broken and one drift anchor reports broken (worst wins), exit 2', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    setupWithPage(dir, ['greet', 'Greeter']);
    writeSource(
      dir,
      `${GREET.replace("'hello '", "'hi '")}\n\n${GREETER.replace('Greeter', 'FriendlyGreeter')}\n`,
    );

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const page = pages(stdout)[0];
    expect(page.state).toBe('broken');
    expect(page.anchors.find((a) => a.symbol === 'src/greet.ts#greet')!.state).toBe('drift');
    expect(page.anchors.find((a) => a.symbol === 'src/greet.ts#Greeter')!.state).toBe('broken');
  });

  it('markdown links without a c2d title are ordinary links, not anchors', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    setupWithPage(dir, ['greet'], '\n[README](README.md "ordinary title") and [bare](README.md)\n');

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    expect(pages(stdout)[0].anchors).toHaveLength(1);
  });

  it('a manifest page with no file on disk is reported broken, exit 2', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    run(['init'], dir);
    writeFileSync(
      path.join(dir, 'docs', 'manifest.json'),
      JSON.stringify({ pages: [{ path: 'planned.md', type: 'overview' }] }, null, 2),
      'utf8',
    );

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const page = pages(stdout)[0];
    expect(page.state).toBe('broken');
    expect(page.note).toBe('page file missing');
    expect(page.anchors).toEqual([]);
  });

  it('discards a cache from a foreign fingerprint algorithm and rebuilds', () => {
    const dir = copyFixture(tsFixture, 'code2doc-anchor-');
    setupWithPage(dir, ['greet']);

    // Forge a stale cache: correct file hashes (so reuse would trigger)
    // but old-algorithm fingerprints and a foreign version.
    const cacheFile = path.join(dir, '.code2doc', 'cache.json');
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    cache.version = 1;
    const greet = cache.files['src/greet.ts'].symbols.find((s: { name: string }) => s.name === 'greet');
    greet.fingerprint.body = 'deaddeaddeaddead';
    writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    expect(pages(stdout)[0].state).toBe('fresh');
  });
});
