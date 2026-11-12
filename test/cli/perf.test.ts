import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { anchorLink, buildCli, declarePages, run, writePage } from './helpers';
import type { Sym } from './helpers';

/**
 * Performance acceptance (T7): `status` on a ~10k-symbol repo completes
 * within seconds, measured at the CLI seam. The fixture is synthetic —
 * generated here, never committed — and deliberately worst-case for the
 * timed path: every public symbol of every module is anchored, so anchor
 * verification runs at full scale alongside extraction.
 *
 * Measured baseline (Apple Silicon, this suite): warm status ~0.2s,
 * fresh-clone rebuild ~0.8s. The budget below holds ~12x headroom —
 * enough for slower CI machines, tight enough to catch O(n²) drift.
 */

/** Ship-blocking ceiling: "within seconds" for a mid-sized repo. */
const STATUS_BUDGET_MS = 10_000;

/** 6 TS modules × 10 files + 4 Java modules × 10 files, 100 symbols each. */
const TS_MODULES = 6;
const JAVA_MODULES = 4;
const FILES_PER_MODULE = 10;
/** 50 exported fn + 25 internal fn + 5 class + 10 interface + 10 const. */
const TS_SYMBOLS_PER_FILE = 100;
/** 1 class + 66 public methods + 33 private methods. */
const JAVA_SYMBOLS_PER_FILE = 100;
const TOTAL_SYMBOLS =
  TS_MODULES * FILES_PER_MODULE * TS_SYMBOLS_PER_FILE +
  JAVA_MODULES * FILES_PER_MODULE * JAVA_SYMBOLS_PER_FILE; // == 10_000

function pad(n: number, width = 3): string {
  return String(n).padStart(width, '0');
}

function tsSource(file: number): string {
  const lines = [`// synthetic module file ${file}`];
  for (let k = 1; k <= 50; k++) {
    lines.push(
      `export function pub${pad(k)}_${file}(a: number, b: string): number {`,
      `  const r${file} = a * ${k} + b.length;`,
      `  return r${file} - ${k};`,
      `}`,
      '',
    );
  }
  for (let k = 1; k <= 25; k++) {
    lines.push(
      `function helper${pad(k)}_${file}(x: number): number {`,
      `  return x + ${k};`,
      `}`,
      '',
    );
  }
  for (let k = 1; k <= 5; k++) {
    lines.push(
      `export class Shape${k}_${file} {`,
      `  area(): number { return ${k}; }`,
      `}`,
      '',
    );
  }
  for (let k = 1; k <= 10; k++) {
    lines.push(
      `export interface Iface${pad(k, 2)}_${file} {`,
      `  id: number;`,
      `  label${k}: string;`,
      `}`,
      '',
    );
  }
  for (let k = 1; k <= 10; k++) {
    lines.push(`export const limit${pad(k, 2)}_${file} = ${k} * ${file};`);
  }
  return `${lines.join('\n')}\n`;
}

function javaSource(cls: string): string {
  const lines = [
    'package synthetic;',
    '',
    `// synthetic java file ${cls}`,
    '',
    `public class ${cls} {`,
  ];
  for (let k = 1; k <= 66; k++) {
    lines.push(
      `  public int pub${pad(k)}(int a, int b) {`,
      `    int r = a * ${k} + b;`,
      `    return r - ${k};`,
      `  }`,
      '',
    );
  }
  for (let k = 1; k <= 33; k++) {
    lines.push(
      `  private int helper${pad(k)}(int x) {`,
      `    return x + ${k};`,
      `  }`,
      '',
    );
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function generateFixture(root: string): void {
  for (let m = 0; m < TS_MODULES; m++) {
    const dir = path.join(root, 'src', `m${m}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_MODULE; f++) {
      writeFileSync(path.join(dir, `mod${f}.ts`), tsSource(f));
    }
  }
  for (let m = 0; m < JAVA_MODULES; m++) {
    const dir = path.join(root, 'src', `j${m}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_MODULE; f++) {
      writeFileSync(path.join(dir, `Mod${f}.java`), javaSource(`Mod${f}`));
    }
  }
}

/** One module page anchoring every public symbol — the worst-case tree. */
function writeAnchoredDocs(dir: string, symbols: Sym[], modules: string[]): void {
  writePage(dir, 'overview.md', '# Overview\n\nSynthetic perf fixture.\n');
  const pages: unknown[] = [{ path: 'overview.md', type: 'overview' }];
  for (const module of modules) {
    // module dirs live under src/ (`src/m0`); the page name is the bare dir
    const name = `${module.split('/').pop()}.md`;
    const anchored = symbols.filter((s) => s.file.startsWith(`${module}/`));
    writePage(
      dir,
      `modules/${name}`,
      [`# Module ${module}`, '', ...anchored.map((s) => `- ${anchorLink(s)}`), ''].join('\n'),
    );
    pages.push({ path: `modules/${name}`, type: 'module', module });
  }
  declarePages(dir, pages);
}

const MODULES = [
  ...Array.from({ length: TS_MODULES }, (_, m) => `src/m${m}`),
  ...Array.from({ length: JAVA_MODULES }, (_, m) => `src/j${m}`),
];

let dir: string;
let symbolCount: number;

/** Wall-clock ms of one CLI invocation (node startup included: the seam is the process). */
function timedRun(args: string[]): { code: number; stdout: string; ms: number } {
  const start = performance.now();
  const result = run(args, dir);
  return { ...result, ms: performance.now() - start };
}

function expectAllFresh(stdout: string): void {
  const report = JSON.parse(stdout);
  expect(report.summary).toEqual({ broken: 0, drift: 0, ripple: 0, missing: 0 });
}

describe('code2doc performance acceptance (T7)', () => {
  beforeAll(() => {
    buildCli();
    dir = path.join(tmpdir(), `code2doc-perf-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    generateFixture(dir);

    const init = run(['init'], dir);
    if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
    const report = JSON.parse(init.stdout);
    symbolCount = report.publicCount + report.internalCount;
    writeAnchoredDocs(dir, report.symbols as Sym[], MODULES);
  }, 120_000);

  it('the synthetic fixture pins the ~10k-symbol scale', () => {
    // guards the fixture itself: a generator regression must not silently
    // shrink the benchmark below the acceptance scale
    expect(symbolCount).toBe(TOTAL_SYMBOLS);
  });

  it('status on the ~10k-symbol fixture verifies every anchor within seconds', () => {
    const { code, stdout, ms } = timedRun(['status', '--json']);
    expect(code).toBe(0);
    expectAllFresh(stdout);
    expect(ms).toBeLessThan(STATUS_BUDGET_MS);
  }, 60_000);

  it('a fresh clone (no cache) rebuilds transparently within the same budget', () => {
    // fresh clone = committed docs and code, no ignored .code2doc/
    rmSync(path.join(dir, '.code2doc'), { recursive: true, force: true });
    expect(existsSync(path.join(dir, '.code2doc'))).toBe(false);

    const { code, stdout, ms } = timedRun(['status', '--json']);
    expect(code).toBe(0);
    expectAllFresh(stdout);
    expect(ms).toBeLessThan(STATUS_BUDGET_MS);
    // the rebuild happened transparently: the cache is back
    expect(existsSync(path.join(dir, '.code2doc', 'cache.json'))).toBe(true);
  }, 60_000);
});
