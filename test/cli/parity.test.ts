import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { anchorLink, buildCli, copyFixture, declarePages, repoRoot, run, writePage } from './helpers.js';
import type { Sym } from './helpers.js';

/**
 * The full Operator flow — init, anchored module page, Drift / Broken /
 * Missing signals, exit codes — run identically against the TS/JS,
 * Java and Python fixtures (T5: languages join at parity by sharing this
 * exact black-box structure, not by imitation). The ripple step runs only
 * where the language extracts call edges yet.
 */

interface SourceEdits {
  /** Body-only change of the edited symbol. */
  bodyOnly: (src: string) => string;
  /** Signature change of the edited symbol. */
  signature: (src: string) => string;
  /** Removal of the edited symbol, leaving valid source behind. */
  symbolGone: (src: string) => string;
}

/** The ripple chain a language with call edges pins (V2-3). */
interface RippleChain {
  /** The anchored caller of the ripple chain, an internal symbol. */
  chainCaller: string;
  /** The repo-relative file the chain caller lives in. */
  chainCallerFile: string;
  /** The `file#name` the chain caller calls; its body edit triggers the ripple. */
  chainCallee: string;
  /** The repo-relative file the chain callee lives in. */
  chainCalleeFile: string;
  /** Body-only change of the chain callee (the ripple trigger). */
  calleeBodyOnly: (src: string) => string;
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
  /** The ripple chain when the language extracts call edges; false where it does not yet (#35 owns Python's). */
  ripple: RippleChain | false;
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
    ripple: {
      chainCaller: 'usesHelper',
      chainCallerFile: 'src/helper.ts',
      chainCallee: 'src/helper.ts#helper',
      chainCalleeFile: 'src/helper.ts',
      calleeBodyOnly: (src) => src.replace('// internal helper, not exported', 'const done = true;'),
    },
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
    ripple: {
      chainCaller: 'casualGreet',
      chainCallerFile: 'src/Greeter.java',
      chainCallee: 'src/Helper.java#helperValue',
      chainCalleeFile: 'src/Helper.java',
      calleeBodyOnly: (src) => src.replace('return 42;', 'return 43;'),
    },
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
  {
    label: 'Python',
    slug: 'python',
    fixture: path.join(repoRoot, 'test/fixtures/sample-python'),
    sourceFile: 'src/greet.py',
    editedSymbol: 'greet',
    ripple: false,
    publicKinds: { MOTTO: 'variable', greet: 'function', Greeter: 'class' },
    filesScanned: 2,
    modulePublics: ['MOTTO', 'greet', 'Greeter'],
    internalCount: 2,
    edits: {
      bodyOnly: (src) => src.replace('return MOTTO + name', 'return MOTTO + "dear " + name'),
      signature: (src) => src.replace('def greet(name):', 'def greet(name, prefix):'),
      symbolGone: (src) => src.replace(
        `def greet(name):
    """Return the greeting for name."""
    return MOTTO + name


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
  ripples: { symbol: string; state: string; via: string; depth: number }[];
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

    /** Rewrite a fixture source inside dir via a transform of the pristine file. */
    function editSource(dir: string, edit: (src: string) => string, file: string = fx.sourceFile): void {
      const pristine = readFileSync(path.join(fx.fixture, file), 'utf8');
      const next = edit(pristine);
      if (next === pristine) throw new Error(`edit is a no-op on ${file}`);
      writeFileSync(path.join(dir, file), next, 'utf8');
    }

    /** An anchor for any symbol of the cache, internal ones included. */
    function anchorFromCache(dir: string, file: string, name: string): string {
      const cache = JSON.parse(readFileSync(path.join(dir, '.code2doc', 'cache.json'), 'utf8'));
      const record = cache.files[file].symbols.find((s: { name: string }) => s.name === name);
      const { signature, body } = record.fingerprint;
      return `[${name}](../${file} "c2d:${file}#${name}:${signature}.${body}")`;
    }

    const edited = () => `${fx.sourceFile}#${fx.editedSymbol}`;

    it('init produces config, manifest, doc skeleton and a symbol cache', () => {
      const dir = copyFixture(fx.fixture, `code2doc-parity-${fx.slug}-`);
      const { code, stdout } = run(['init'], dir);
      expect(code).toBe(0);

      expect(existsSync(path.join(dir, 'code2doc.config.json'))).toBe(true);
      expect(existsSync(path.join(dir, 'code2doc', 'manifest.json'))).toBe(true);
      expect(existsSync(path.join(dir, 'code2doc', 'README.md'))).toBe(true);
      expect(existsSync(path.join(dir, '.code2doc', 'cache.json'))).toBe(true);

      const report = JSON.parse(stdout);
      expect(report.filesScanned).toBe(fx.filesScanned);
      const srcModule = report.modules.find((m: { dir: string }) => m.dir === 'src');
      expect([...srcModule.publicSymbols].sort()).toEqual([...fx.modulePublics].sort());
      expect(srcModule.internalCount).toBe(fx.internalCount);
      for (const s of report.symbols as (Sym & { kind: string })[]) {
        expect(s.kind).toBe(fx.publicKinds[s.name]);
      }
    });

    it('a module page anchoring every public symbol is fresh, exit 0', () => {
      const dir = setupFullyAnchored();

      const { code, stdout } = run(['status', '--json'], dir);
      expect(code).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.summary).toEqual({ broken: 0, drift: 0, ripple: 0, missing: 0 });
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

    if (fx.ripple) {
      const chain = fx.ripple;
      it('a callee body edit ripples the anchored caller — same JSON shape and exit codes', () => {
        const dir = copyFixture(fx.fixture, `code2doc-parity-${fx.slug}-`);
        run(['init'], dir);
        // the chain caller is internal: its fingerprint comes from the cache, not the init report
        writePage(dir, 'chain.md', `# the chain\n\n- ${anchorFromCache(dir, chain.chainCallerFile, chain.chainCaller)} drives the flow\n`);
        declarePages(dir, [{ path: 'chain.md', type: 'flow' }]);
        expect(run(['status'], dir).code).toBe(0);

        editSource(dir, chain.calleeBodyOnly, chain.chainCalleeFile);
        const { code, stdout } = run(['status', '--json'], dir);
        expect(code).toBe(1);

        const page = firstPage(stdout);
        expect(page.state).toBe('ripple');
        const anchor = page.anchors.find((a) => a.symbol === `${chain.chainCallerFile}#${chain.chainCaller}`)!;
        expect(anchor.state).toBe('ripple');
        expect(anchor.reason).toBe('callee went stale');
        expect(anchor.ripples).toEqual([
          { symbol: chain.chainCallee, state: 'drift', via: chain.chainCallee, depth: 1 },
        ]);
      });
    }

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

/**
 * The ADR-0006 overload blind spot, end to end: an internal first
 * declaration ahead of a public one (Guice's Key.get shape). The init
 * report lists only the public declaration, so the natural authoring
 * flow writes an anchor that resolves to the internal one — status must
 * say so and hand over the payload, not a bare `signature changed`.
 */
describe('Java overload anchors (ADR-0006)', () => {
  beforeAll(buildCli);

  const OVERLOADS = `package demo;

public class Overloads {

  static String get(String kind) {
    return kind;
  }

  public String get(String kind, String suffix) {
    return kind + suffix;
  }
}
`;

  /** A pristine java fixture plus the overloads source, cache built. */
  function fixtureWithOverloads(): { dir: string; report: { symbols: Sym[] } } {
    const dir = copyFixture(path.join(repoRoot, 'test/fixtures/sample-java'), 'code2doc-overload-');
    writeFileSync(path.join(dir, 'src', 'Overloads.java'), OVERLOADS, 'utf8');
    const report = JSON.parse(run(['init'], dir).stdout);
    return { dir, report };
  }

  function declareOverloadsPage(dir: string, anchor: string): void {
    writePage(dir, 'overloads.md', `# overloads\n\n- ${anchor} returns its kind\n`);
    declarePages(dir, [{ path: 'overloads.md', type: 'reference' }]);
  }

  /** The cache record of one symbol — internal declarations live only here. */
  function cacheRecord(dir: string, file: string, name: string): Sym {
    const cache = JSON.parse(readFileSync(path.join(dir, '.code2doc', 'cache.json'), 'utf8'));
    return cache.files[file].symbols.find((s: { name: string }) => s.name === name);
  }

  function firstAnchor(stdout: string): AnchorReportShape & { note?: string } {
    return (JSON.parse(stdout).pages as PageShape[])[0].anchors[0] as AnchorReportShape & {
      note?: string;
    };
  }

  it('anchoring the public overload breaks with a note carrying the first declaration', () => {
    const { dir, report } = fixtureWithOverloads();
    const publicGet = report.symbols.find((s) => s.name === 'get')!;
    declareOverloadsPage(dir, anchorLink(publicGet));

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const anchor = firstAnchor(stdout);
    expect(anchor.state).toBe('broken');
    expect(anchor.reason).toBe('signature changed');
    const first = cacheRecord(dir, 'src/Overloads.java', 'get').fingerprint;
    expect(anchor.note).toContain(`c2d:src/Overloads.java#get:${first.signature}.${first.body}`);

    const human = run(['status'], dir).stdout;
    expect(human).toContain('fingerprint matches overload 2 of 2');
  });

  it('pasting the handed-over payload is fresh, exit 0', () => {
    const { dir } = fixtureWithOverloads();
    declareOverloadsPage(dir, anchorLink(cacheRecord(dir, 'src/Overloads.java', 'get')));

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    const anchor = firstAnchor(stdout);
    expect(anchor.state).toBe('fresh');
    expect(anchor.note).toBeUndefined();
  });

  it('an invented fingerprint stays a bare signature change, no note', () => {
    const { dir } = fixtureWithOverloads();
    declareOverloadsPage(
      dir,
      anchorLink({ file: 'src/Overloads.java', name: 'get', fingerprint: { signature: 'f'.repeat(16), body: 'e'.repeat(16) } }),
    );

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const anchor = firstAnchor(stdout);
    expect(anchor.state).toBe('broken');
    expect(anchor.reason).toBe('signature changed');
    expect(anchor.note).toBeUndefined();
  });
});
