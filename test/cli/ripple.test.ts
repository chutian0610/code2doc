import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { anchorLink, buildCli, declarePages, run, writePage } from './helpers';
import type { Sym } from './helpers';

/**
 * V2-1: the first end-to-end Ripple, driven as the Operator drives it —
 * init, anchored pages, a green status (the cache baseline), then a move
 * under an unchanged anchor. Edges are resolved against the *previous*
 * cache (the graph as of the last status), so a deleted callee still
 * ripples its caller; the fresh-clone first run has no baseline and is
 * ripple-silent by construction.
 */

/** `a` imports and calls `helper`: the one-hop chain under test. */
const CHAIN_TS = `import { helper } from './helper';
export function a(): string {
  return helper();
}
`;
const HELPER_FRESH = `export function helper(): string {
  return 'hi';
}
`;
/** body-only edit of helper */
const HELPER_DRIFT = `export function helper(): string {
  return 'hello';
}
`;
/** helper gone (file kept, nothing public left behind) */
const HELPER_GONE = `const leftover = 1;
`;
/** helper untouched, an unrelated public symbol added */
const HELPER_ADDED = HELPER_FRESH + `export function extra(): number {
  return 1;
}
`;

function chainRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'code2doc-ripple-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src/chain.ts'), CHAIN_TS, 'utf8');
  writeFileSync(path.join(dir, 'src/helper.ts'), HELPER_FRESH, 'utf8');
  return dir;
}

interface Pages {
  dir: string;
  a: Sym;
  helper: Sym;
}

/** init + a module page anchoring both publics + a flow page anchoring only `a`. */
function setup(): Pages {
  const dir = chainRepo();
  const report = JSON.parse(run(['init'], dir).stdout);
  const symbols = report.symbols as Sym[];
  const a = symbols.find((s) => s.name === 'a')!;
  const helper = symbols.find((s) => s.name === 'helper')!;
  writePage(dir, 'modules/chain.md', `# src module\n\n- ${anchorLink(a)} calls\n- ${anchorLink(helper)} answers\n`);
  writePage(dir, 'flows/chain.md', `# the chain\n\n- ${anchorLink(a)} is the entry\n`);
  declarePages(dir, [
    { path: 'modules/chain.md', type: 'module', module: 'src' },
    { path: 'flows/chain.md', type: 'flow' },
  ]);
  return { dir, a, helper };
}

/** The green status that establishes the cache baseline. */
function greenBaseline(pages: Pages): void {
  const { code } = run(['status'], pages.dir);
  expect(code).toBe(0);
}

function editHelper(dir: string, next: string): void {
  writeFileSync(path.join(dir, 'src/helper.ts'), next, 'utf8');
}

interface AnchorShape {
  symbol: string;
  state: string;
  reason: string;
  ripples: { symbol: string; state: string; via: string; depth: number }[];
}
interface ReportShape {
  pages: { path: string; state: string; anchors: AnchorShape[] }[];
  summary: { broken: number; drift: number; ripple: number; missing: number };
}

const page = (r: ReportShape, p: string) => r.pages.find((x) => x.path === p)!;
const anchor = (r: ReportShape, p: string, symbol: string) =>
  page(r, p).anchors.find((x) => x.symbol === symbol)!;

describe('code2doc ripple (V2-1)', () => {
  beforeAll(buildCli);

  it('a body edit under an unchanged anchor ripples it, exit 1 — the report names the callee', () => {
    const pages = setup();
    greenBaseline(pages);
    editHelper(pages.dir, HELPER_DRIFT);

    const { code, stdout } = run(['status', '--json'], pages.dir);
    expect(code).toBe(1); // ripple-only tier, shared with drift

    const report = JSON.parse(stdout) as ReportShape;
    // the flow page anchors only `a`: its state is ripple, nothing worse
    expect(page(report, 'flows/chain.md').state).toBe('ripple');
    expect(report.summary).toEqual({ broken: 0, drift: 1, ripple: 1, missing: 0 });

    const a = anchor(report, 'flows/chain.md', 'src/chain.ts#a');
    expect(a.state).toBe('ripple');
    expect(a.reason).toBe('callee went stale');
    expect(a.ripples).toEqual([
      { symbol: 'src/helper.ts#helper', state: 'drift', via: 'src/helper.ts#helper', depth: 1 },
    ]);
    // the module page sees the direct drift on helper, which outranks a's ripple
    expect(anchor(report, 'modules/chain.md', 'src/helper.ts#helper').state).toBe('drift');
  });

  it('the human table has a ripple row and the drill-down names symbol and state', () => {
    const pages = setup();
    greenBaseline(pages);
    editHelper(pages.dir, HELPER_DRIFT);

    const { code, stdout } = run(['status'], pages.dir);
    expect(code).toBe(1);
    expect(stdout).toContain('ripple');
    expect(stdout).toContain('docs/flows/chain.md');
    expect(stdout).toContain('src/chain.ts#a — callee went stale');
    expect(stdout).toContain('src/helper.ts#helper drift');
    expect(stdout).toContain('1 ripple');
  });

  it('a deleted callee ripples the caller broken; any direct broken still drives exit 2', () => {
    const pages = setup();
    greenBaseline(pages);
    editHelper(pages.dir, HELPER_GONE);

    const { code, stdout } = run(['status', '--json'], pages.dir);
    expect(code).toBe(2); // the module page's direct anchor on helper is broken

    const report = JSON.parse(stdout) as ReportShape;
    // edges come from the previous cache, so the caller still names the deleted callee
    const a = anchor(report, 'flows/chain.md', 'src/chain.ts#a');
    expect(a.state).toBe('ripple');
    expect(a.ripples).toEqual([
      { symbol: 'src/helper.ts#helper', state: 'broken', via: 'src/helper.ts#helper', depth: 1 },
    ]);
    expect(anchor(report, 'modules/chain.md', 'src/helper.ts#helper').state).toBe('broken');
    expect(page(report, 'modules/chain.md').state).toBe('broken');
  });

  it('ripple-only trees exit 1 with the four-tier ladder in the table', () => {
    // a flow page with nothing but a rippled anchor: no direct signal anywhere
    const dir = chainRepo();
    const report = JSON.parse(run(['init'], dir).stdout);
    const a = (report.symbols as Sym[]).find((s) => s.name === 'a')!;
    writePage(dir, 'flows/chain.md', `# the chain\n\n- ${anchorLink(a)} is the entry\n`);
    declarePages(dir, [{ path: 'flows/chain.md', type: 'flow' }]);
    expect(run(['status'], dir).code).toBe(0);
    editHelper(dir, HELPER_DRIFT);

    const { code, stdout } = run(['status'], dir);
    expect(code).toBe(1);
    expect(stdout).toMatch(/ripple\s+flow\s+docs\/flows\/chain\.md/);
  });

  it('the fresh-clone first run is ripple-silent: direct signals only, no baseline', () => {
    const pages = setup();
    rmSync(path.join(pages.dir, '.code2doc'), { recursive: true, force: true });
    editHelper(pages.dir, HELPER_DRIFT);

    const { code, stdout } = run(['status', '--json'], pages.dir);
    expect(code).toBe(1); // drift-only, as in v1
    const report = JSON.parse(stdout) as ReportShape;
    expect(report.summary).toEqual({ broken: 0, drift: 1, ripple: 0, missing: 0 });
    expect(anchor(report, 'flows/chain.md', 'src/chain.ts#a').state).toBe('fresh');
    expect(anchor(report, 'flows/chain.md', 'src/chain.ts#a').ripples).toEqual([]);
  });

  it('missing never propagates: an unrelated added public lights its own page, not the caller', () => {
    const pages = setup();
    greenBaseline(pages);
    editHelper(pages.dir, HELPER_ADDED);

    const { code, stdout } = run(['status', '--json'], pages.dir);
    expect(code).toBe(2); // the module page now misses a public export — v1 semantics

    const report = JSON.parse(stdout) as ReportShape;
    expect(report.summary).toEqual({ broken: 1, drift: 0, ripple: 0, missing: 1 });
    // helper itself did not move, so the caller stays fresh
    expect(anchor(report, 'flows/chain.md', 'src/chain.ts#a').state).toBe('fresh');
    expect(anchor(report, 'flows/chain.md', 'src/chain.ts#a').ripples).toEqual([]);
  });

  it('a foreign-version cache rebuilds instead of poisoning the baseline', () => {
    const pages = setup();
    greenBaseline(pages);
    // forge a v3-era cache, as a checkout from before the binding rework would carry
    const cacheFile = path.join(pages.dir, '.code2doc', 'cache.json');
    const stale = JSON.parse(readFileSync(cacheFile, 'utf8'));
    stale.version = 3;
    writeFileSync(cacheFile, JSON.stringify(stale), 'utf8');
    editHelper(pages.dir, HELPER_DRIFT);

    const { code, stdout } = run(['status', '--json'], pages.dir);
    expect(code).toBe(1); // drift-only: the forged baseline yields no ripples
    const report = JSON.parse(stdout) as ReportShape;
    expect(report.summary).toEqual({ broken: 0, drift: 1, ripple: 0, missing: 0 });

    const rebuilt = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(rebuilt.version).toBe(4);
  });
});

/**
 * V2-2: the closure. Ripples propagate through any depth with `via` and
 * `depth`; a shared helper's change lights every page once, however
 * wide the fan-out under it.
 */
describe('code2doc ripple closure (V2-2)', () => {
  beforeAll(buildCli);

  /** a → mid (import) → leaf (import): the three-deep chain. */
  function deepRepo(): { dir: string; a: Sym } {
    const dir = mkdtempSync(path.join(tmpdir(), 'code2doc-closure-'));
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/chain.ts'),
      "import { mid } from './mid';\nexport function a(): string {\n  return mid();\n}\n", 'utf8');
    writeFileSync(path.join(dir, 'src/mid.ts'),
      "import { leaf } from './leaf';\nexport function mid(): string {\n  return leaf();\n}\n", 'utf8');
    writeFileSync(path.join(dir, 'src/leaf.ts'),
      "export function leaf(): string {\n  return 'x';\n}\n", 'utf8');
    const report = JSON.parse(run(['init'], dir).stdout);
    const a = (report.symbols as Sym[]).find((s) => s.name === 'a')!;
    writePage(dir, 'flows/chain.md', `# the chain\n\n- ${anchorLink(a)} is the entry\n`);
    declarePages(dir, [{ path: 'flows/chain.md', type: 'flow' }]);
    return { dir, a };
  }

  const editLeaf = (dir: string, next: string) =>
    writeFileSync(path.join(dir, 'src/leaf.ts'), next, 'utf8');
  const LEAF_DRIFT = "export function leaf(): string {\n  return 'y';\n}\n";
  const LEAF_GONE = "const leftover = 1;\n";

  it('a body edit two hops down ripples the top anchor: via = the middle symbol, depth 2', () => {
    const { dir } = deepRepo();
    expect(run(['status'], dir).code).toBe(0);
    editLeaf(dir, LEAF_DRIFT);

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as ReportShape;
    const a = anchor(report, 'flows/chain.md', 'src/chain.ts#a');
    expect(a.state).toBe('ripple');
    expect(a.ripples).toEqual([
      { symbol: 'src/leaf.ts#leaf', state: 'drift', via: 'src/mid.ts#mid', depth: 2 },
    ]);
  });

  it('the human drill-down names via and hops at depth 2 (a fresh run, so the baseline stands)', () => {
    const { dir } = deepRepo();
    expect(run(['status'], dir).code).toBe(0);
    editLeaf(dir, LEAF_DRIFT);

    const human = run(['status'], dir).stdout;
    expect(human).toContain('ripple');
    expect(human).toContain('(via src/mid.ts#mid, 2 hops)');
  });

  it('a deletion two hops down propagates broken through the closure', () => {
    const { dir } = deepRepo();
    expect(run(['status'], dir).code).toBe(0);
    editLeaf(dir, LEAF_GONE);

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(1); // no direct anchor on leaf: ripple-only, tier 1
    const a = anchor(JSON.parse(stdout) as ReportShape, 'flows/chain.md', 'src/chain.ts#a');
    expect(a.ripples).toEqual([
      { symbol: 'src/leaf.ts#leaf', state: 'broken', via: 'src/mid.ts#mid', depth: 2 },
    ]);
  });

  /** The shared helper after its body edit, fanning out to every caller. */
  const HELPER_HELLO = "export function helper(): string {\n  return 'hello';\n}\n";
  const editFanoutHelper = (dir: string) =>
    writeFileSync(path.join(dir, 'src/helper.ts'), HELPER_HELLO, 'utf8');

  /** three modules calling one shared helper: the fan-out fixture. */
  function fanoutRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'code2doc-fanout-'));
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/helper.ts'),
      "export function helper(): string {\n  return 'hi';\n}\n", 'utf8');
    const names = ['one', 'two', 'three'];
    for (const name of names) {
      writeFileSync(path.join(dir, `src/${name}.ts`),
        `import { helper } from './helper';\nexport function uses${name}(): string {\n  return helper();\n}\n`, 'utf8');
    }
    const report = JSON.parse(run(['init'], dir).stdout);
    const symbols = report.symbols as Sym[];
    const links = symbols
      .filter((s) => s.name.startsWith('uses'))
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((s) => `- ${anchorLink(s)} leans on the helper`)
      .join('\n');
    writePage(dir, 'flows/fanout.md', `# the fan-out\n\n${links}\n`);
    declarePages(dir, [{ path: 'flows/fanout.md', type: 'flow' }]);
    return dir;
  }

  it('a shared helper change ripples every anchor; the human table stays one line per page', () => {
    const dir = fanoutRepo();
    expect(run(['status'], dir).code).toBe(0);
    editFanoutHelper(dir);

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as ReportShape;
    expect(page(report, 'flows/fanout.md').state).toBe('ripple');
    expect(report.summary).toEqual({ broken: 0, drift: 0, ripple: 1, missing: 0 });
    // --json keeps the full per-anchor list, one ripple each
    for (const name of ['one', 'two', 'three']) {
      const a = anchor(report, 'flows/fanout.md', `src/${name}.ts#uses${name}`);
      expect(a.ripples).toEqual([
        { symbol: 'src/helper.ts#helper', state: 'drift', via: 'src/helper.ts#helper', depth: 1 },
      ]);
    }
  });

  it('the human fan-out output is page-aggregated however many anchors ripple', () => {
    const dir = fanoutRepo();
    expect(run(['status'], dir).code).toBe(0);
    editFanoutHelper(dir);

    const human = run(['status'], dir).stdout;
    // one table row for the page…
    expect(human.match(/ripple\s+flow\s+docs\/flows\/fanout\.md/g)).toHaveLength(1);
    // …drill-down per anchor, one ripple line each
    for (const name of ['one', 'two', 'three']) {
      expect(human).toContain(`src/${name}.ts#uses${name} — callee went stale`);
      expect(human).toContain(`src/helper.ts#helper drift (via src/helper.ts#helper, 1 hop)`);
    }
    expect(human).toContain('1 ripple');
  });
});
