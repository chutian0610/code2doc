import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  anchorLink,
  buildCli,
  copyFixture,
  declarePages,
  run,
  tsFixture,
  writePage,
} from './helpers';
import type { Sym } from './helpers';

/** init's public-symbol report, restricted to one source file. */
function publicSymbols(dir: string, file: string): Sym[] {
  const report = JSON.parse(run(['init'], dir).stdout);
  return report.symbols.filter((s: Sym) => s.file === file);
}

interface Page {
  path: string;
  type: string;
  state: string;
  missing: string[];
  note?: string;
  anchors: { symbol: string; state: string }[];
}

function pages(stdout: string): Page[] {
  return JSON.parse(stdout).pages as Page[];
}

/** A module of 8 public exports plus internals that must never count. */
const WIDGETS = `export function add(a: number, b: number): number {
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}

export function mul(a: number, b: number): number {
  return a * b;
}

export function div(a: number, b: number): number {
  return a / b;
}

export function neg(a: number): number {
  return -a;
}

export function abs(a: number): number {
  return Math.abs(a);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function sum(values: number[]): number {
  return values.reduce(add, 0);
}

function table(): Record<string, true> {
  return {};
}

const memo = 0;
`;

/** Copy the fixture, add src/widgets/widgets.ts, init, and return its publics. */
function setupWidgets(): { dir: string; symbols: Sym[] } {
  const dir = copyFixture(tsFixture, 'code2doc-coverage-');
  mkdirSync(path.join(dir, 'src', 'widgets'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'widgets', 'widgets.ts'), WIDGETS, 'utf8');
  run(['init'], dir);
  const symbols = publicSymbols(dir, 'src/widgets/widgets.ts');
  if (symbols.length !== 8) throw new Error(`expected 8 public exports, got ${symbols.length}`);
  return { dir, symbols };
}

function widgetsPage(symbols: Sym[]): string {
  return `# widgets\n\n${symbols.map((s) => `- ${anchorLink(s)} works.`).join('\n')}\n`;
}

describe('code2doc module coverage — the Missing signal (T4)', () => {
  beforeAll(buildCli);

  it('a module with 8 public exports anchored 5 times reports the 3 missing by name, exit 2', () => {
    const { dir, symbols } = setupWidgets();
    declarePages(dir, [{ path: 'widgets.md', type: 'module', module: 'src/widgets' }]);
    writePage(dir, 'widgets.md', widgetsPage(symbols.slice(0, 5)));

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const page = pages(stdout)[0];
    expect(page.state).toBe('broken');
    expect(page.anchors).toHaveLength(5);
    expect([...page.missing].sort()).toEqual(
      ['abs', 'clamp', 'sum'].map((name) => `src/widgets/widgets.ts#${name}`),
    );
    expect(JSON.parse(stdout).summary).toEqual({ broken: 1, drift: 0, ripple: 0, missing: 3 });
  });

  it('the default output names the missing symbols and counts them in the summary', () => {
    const { dir, symbols } = setupWidgets();
    declarePages(dir, [{ path: 'widgets.md', type: 'module', module: 'src/widgets' }]);
    writePage(dir, 'widgets.md', widgetsPage(symbols.slice(0, 5)));

    const { code, stdout } = run(['status'], dir);
    expect(code).toBe(2);
    expect(stdout).toContain('missing src/widgets/widgets.ts#abs');
    expect(stdout).toContain('src/widgets/widgets.ts#clamp');
    expect(stdout).toContain('src/widgets/widgets.ts#sum');
    expect(stdout).toContain('3 missing symbols');
  });

  it('anchoring every public export clears missing, exit 0', () => {
    const { dir, symbols } = setupWidgets();
    declarePages(dir, [{ path: 'widgets.md', type: 'module', module: 'src/widgets' }]);
    writePage(dir, 'widgets.md', widgetsPage(symbols));

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    expect(pages(stdout)[0].missing).toEqual([]);
    expect(JSON.parse(stdout).summary).toEqual({ broken: 0, drift: 0, ripple: 0, missing: 0 });
  });

  it('overview / flow / howto / reference pages carry no coverage requirement', () => {
    const { dir, symbols } = setupWidgets();
    const anchor = anchorLink(symbols[0]); // one anchor, far from full coverage
    declarePages(dir, [
      { path: 'overview.md', type: 'overview' },
      { path: 'flow.md', type: 'flow' },
      { path: 'howto.md', type: 'howto' },
      { path: 'reference.md', type: 'reference' },
    ]);
    for (const file of ['overview.md', 'flow.md', 'howto.md', 'reference.md']) {
      writePage(dir, file, `# ${file}\n\n${anchor}\n`);
    }

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    for (const page of pages(stdout)) {
      expect(page.state).toBe('fresh');
      expect(page.missing).toEqual([]);
    }
    expect(JSON.parse(stdout).summary).toEqual({ broken: 0, drift: 0, ripple: 0, missing: 0 });
  });

  it('internal (non-exported) symbols never count as missing', () => {
    const dir = copyFixture(tsFixture, 'code2doc-coverage-');
    const all = JSON.parse(run(['init'], dir).stdout).symbols as Sym[];
    const symbols = ['greet', 'Greeter', 'usesHelper'].map((name) => {
      const found = all.find((s) => s.name === name);
      if (!found) throw new Error(`symbol not in init report: ${name}`);
      return found;
    });
    // helper and internalAnswer stay unanchored; both are internal.
    declarePages(dir, [{ path: 'module.md', type: 'module', module: 'src' }]);
    writePage(dir, 'module.md', `# src module\n\n${symbols.map((s) => `- ${anchorLink(s)}`).join('\n')}\n`);

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    expect(pages(stdout)[0].missing).toEqual([]);
  });

  it('a stale anchor still covers its symbol — drift is reported, never missing', () => {
    const { dir, symbols } = setupWidgets();
    declarePages(dir, [{ path: 'widgets.md', type: 'module', module: 'src/widgets' }]);
    writePage(dir, 'widgets.md', widgetsPage(symbols));
    // body-only edit of the anchored sum: every export stays anchored
    writeFileSync(
      path.join(dir, 'src', 'widgets', 'widgets.ts'),
      WIDGETS.replace('return values.reduce(add, 0);', 'return values.reduce(add, -0);'),
      'utf8',
    );

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(1);
    const page = pages(stdout)[0];
    expect(page.state).toBe('drift');
    expect(page.missing).toEqual([]);
    expect(JSON.parse(stdout).summary).toEqual({ broken: 0, drift: 1, ripple: 0, missing: 0 });
  });

  it('a module mapping to no indexed directory reports the page broken, not silently fresh', () => {
    const { dir, symbols } = setupWidgets();
    declarePages(dir, [{ path: 'widgets.md', type: 'module', module: 'src/widgts-typo' }]);
    writePage(dir, 'widgets.md', widgetsPage(symbols)); // full coverage of the real dir

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const page = pages(stdout)[0];
    expect(page.state).toBe('broken');
    expect(page.note).toBe('module directory not indexed: src/widgts-typo');
    expect(page.missing).toEqual([]);
    const human = run(['status'], dir).stdout;
    expect(human).toContain('module directory not indexed');
  });

  it('a module page without a source-module mapping fails the tool (exit 3)', () => {
    const dir = copyFixture(tsFixture, 'code2doc-coverage-');
    run(['init'], dir);
    declarePages(dir, [{ path: 'module.md', type: 'module' }]);
    writePage(dir, 'module.md', '# module\n');

    const { code, stdout, stderr } = run(['status', '--json'], dir);
    expect(code).toBe(3);
    expect(() => JSON.parse(stdout)).toThrow();
    expect(stderr).toContain('module.md');
    expect(stderr).toContain('module');
  });

  it('"module" on a non-module page is a manifest shape error (exit 3)', () => {
    const dir = copyFixture(tsFixture, 'code2doc-coverage-');
    run(['init'], dir);
    declarePages(dir, [{ path: 'overview.md', type: 'overview', module: 'src' }]);
    writePage(dir, 'overview.md', '# overview\n');

    const { code, stderr } = run(['status'], dir);
    expect(code).toBe(3);
    expect(stderr).toContain('overview.md');
  });
});
