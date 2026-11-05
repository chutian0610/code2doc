import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { anchorLink, buildCli, copyFixture, declarePages, repoRoot, run, writePage } from './helpers';
import type { Sym } from './helpers';

/**
 * The full Operator flow — init, anchored module page, Drift / Broken /
 * Missing signals, exit codes — run identically against the TS/JS fixture
 * and the Java fixture (T5: languages join at parity by sharing this
 * exact black-box structure, not by imitation).
 */

interface SourceEdits {
  /** Body-only change of the edited symbol. */
  bodyOnly: (src: string) => string;
  /** Signature change of the edited symbol. */
  signature: (src: string) => string;
  /** Removal of the edited symbol, leaving valid source behind. */
  symbolGone: (src: string) => string;
}

interface ParityFixture {
  /** Human label for the suite, e.g. 'TS/JS'. */
  label: string;
  /** Temp-dir prefix slug, e.g. 'ts'. */
  slug: string;
  fixture: string;
  /** The source file the edits rewrite, repo-relative. */
  sourceFile: string;
  /** The symbol every edit targets (a public symbol of sourceFile). */
  editedSymbol: string;
  /** init's kind per public symbol of this fixture. */
  publicKinds: Record<string, string>;
  /** init report numbers. */
  filesScanned: number;
  modulePublics: string[];
  internalCount: number;
  edits: SourceEdits;
}

const FIXTURES: ParityFixture[] = [
  {
    label: 'TS/JS',
    slug: 'ts',
    fixture: path.join(repoRoot, 'test/fixtures/sample-ts'),
    sourceFile: 'src/greet.ts',
    editedSymbol: 'greet',
    publicKinds: { greet: 'function', Greeter: 'class', usesHelper: 'function' },
    filesScanned: 2,
    modulePublics: ['greet', 'Greeter', 'usesHelper'],
    internalCount: 2,
    edits: {
      bodyOnly: (src) => src.replace("'hello '", "'hi '"),
      signature: (src) => src.replace('(name: string)', '(name: string, prefix: string)'),
      symbolGone: (src) => src.replace(
        `export function greet(name: string): string {
  return 'hello ' + name;
}

`,
        '',
      ),
    },
  },
  {
    label: 'Java',
    slug: 'java',
    fixture: path.join(repoRoot, 'test/fixtures/sample-java'),
    sourceFile: 'src/Greeter.java',
    editedSymbol: 'greet',
    publicKinds: { Greeter: 'class', greet: 'function' },
    filesScanned: 2,
    modulePublics: ['Greeter', 'greet'],
    internalCount: 3,
    edits: {
      bodyOnly: (src) => src.replace('return prefix + name;', 'return prefix + "dear " + name;'),
      signature: (src) => src.replace('greet(String name)', 'greet(String name, String surname)'),
      symbolGone: (src) => src.replace(
        `  public String greet(String name) {
    return prefix + name;
  }

`,
        '',
      ),
    },
  },
];

interface AnchorReportShape {
  symbol: string;
  state: string;
  reason: string;
}

interface PageShape {
  state: string;
  anchors: AnchorReportShape[];
  missing: string[];
}

function firstPage(stdout: string): PageShape {
  return (JSON.parse(stdout).pages as PageShape[])[0];
}

function paritySuite(fx: ParityFixture): void {
  describe(`code2doc flow at parity — ${fx.label}`, () => {
    beforeAll(buildCli);

    /** init + a module page anchoring every public symbol of src/. */
    function setupFullyAnchored(): string {
      const dir = copyFixture(fx.fixture, `code2doc-parity-${fx.slug}-`);
      const report = JSON.parse(run(['init'], dir).stdout);
      const symbols = report.symbols as Sym[];
      const body = symbols.map((s) => `- ${anchorLink(s)} does its thing.`).join('\n');
      writePage(dir, 'module.md', `# src module\n\n${body}\n`);
      declarePages(dir, [{ path: 'module.md', type: 'module', module: 'src' }]);
      return dir;
    }

    /** Rewrite the fixture source inside dir via a transform of the pristine file. */
    function editSource(dir: string, edit: (src: string) => string): void {
      const pristine = readFileSync(path.join(fx.fixture, fx.sourceFile), 'utf8');
      const next = edit(pristine);
      if (next === pristine) throw new Error(`edit is a no-op on ${fx.sourceFile}`);
      writeFileSync(path.join(dir, fx.sourceFile), next, 'utf8');
    }

    const edited = () => `${fx.sourceFile}#${fx.editedSymbol}`;

    it('init produces config, manifest, doc skeleton and a symbol cache', () => {
      const dir = copyFixture(fx.fixture, `code2doc-parity-${fx.slug}-`);
      const { code, stdout } = run(['init'], dir);
      expect(code).toBe(0);

      expect(existsSync(path.join(dir, 'code2doc.config.json'))).toBe(true);
      expect(existsSync(path.join(dir, 'docs', 'manifest.json'))).toBe(true);
      expect(existsSync(path.join(dir, 'docs', 'README.md'))).toBe(true);
      expect(existsSync(path.join(dir, '.code2doc', 'cache.json'))).toBe(true);

      const report = JSON.parse(stdout);
      expect(report.filesScanned).toBe(fx.filesScanned);
      const srcModule = report.modules.find((m: { dir: string }) => m.dir === 'src');
      expect([...srcModule.publicSymbols].sort()).toEqual([...fx.modulePublics].sort());
      expect(srcModule.internalCount).toBe(fx.internalCount);
      for (const s of report.symbols as Sym[]) {
        expect(s.kind).toBe(fx.publicKinds[s.name]);
      }
    });

    it('a module page anchoring every public symbol is fresh, exit 0', () => {
      const dir = setupFullyAnchored();

      const { code, stdout } = run(['status', '--json'], dir);
      expect(code).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.summary).toEqual({ broken: 0, drift: 0, missing: 0 });
      const page = firstPage(stdout);
      expect(page.state).toBe('fresh');
      expect(page.missing).toEqual([]);
      // every public export of src/ is anchored, and every anchor is fresh
      expect(page.anchors).toHaveLength(fx.modulePublics.length);
      for (const anchor of page.anchors) {
        expect(anchor.state).toBe('fresh');
        expect(anchor.reason).toBe('');
      }
    });

    it('a body edit flips the anchor to drift, exit 1 — the human output names the symbol', () => {
      const dir = setupFullyAnchored();
      editSource(dir, fx.edits.bodyOnly);

      const { code, stdout } = run(['status', '--json'], dir);
      expect(code).toBe(1);
      const page = firstPage(stdout);
      expect(page.state).toBe('drift');
      const anchor = page.anchors.find((a) => a.symbol === edited())!;
      expect(anchor.state).toBe('drift');
      expect(anchor.reason).toBe('body changed');

      const human = run(['status'], dir).stdout;
      expect(human).toContain(edited());
      expect(human).toContain('drift');
    });

    it('a signature edit flips the anchor to broken, exit 2', () => {
      const dir = setupFullyAnchored();
      editSource(dir, fx.edits.signature);

      const { code, stdout } = run(['status', '--json'], dir);
      expect(code).toBe(2);
      const anchor = firstPage(stdout).anchors.find((a) => a.symbol === edited())!;
      expect(anchor.state).toBe('broken');
      expect(anchor.reason).toBe('signature changed');
    });

    it('deleting the symbol reports it gone, exit 2', () => {
      const dir = setupFullyAnchored();
      editSource(dir, fx.edits.symbolGone);

      const { code, stdout } = run(['status', '--json'], dir);
      expect(code).toBe(2);
      const anchor = firstPage(stdout).anchors.find((a) => a.symbol === edited())!;
      expect(anchor.state).toBe('broken');
      expect(anchor.reason).toBe('symbol gone');
    });

    it('public exports without an anchor are reported missing, exit 2', () => {
      const dir = copyFixture(fx.fixture, `code2doc-parity-${fx.slug}-`);
      const report = JSON.parse(run(['init'], dir).stdout);
      const all = report.symbols as Sym[];
      const anchored = all.filter((s) => s.name === fx.editedSymbol);
      const owed = all
        .filter((s) => s.name !== fx.editedSymbol)
        .map((s) => `${s.file}#${s.name}`)
        .sort();

      writePage(dir, 'module.md', `# src module\n\n${anchored.map((s) => `- ${anchorLink(s)}`).join('\n')}\n`);
      declarePages(dir, [{ path: 'module.md', type: 'module', module: 'src' }]);

      const { code, stdout } = run(['status', '--json'], dir);
      expect(code).toBe(2);
      const page = firstPage(stdout);
      expect(page.missing).toEqual(owed);
      expect(page.state).toBe('broken');
    });
  });
}

for (const fx of FIXTURES) paritySuite(fx);
