import { describe, it, expect } from 'vitest';
import { changedSince, resolveEdges } from '../src/ripple.js';
import type { CacheData } from '../src/cache.js';
import type { FileRefs, SymbolRecord } from '../src/extractor/types.js';
import { noRefs } from '../src/extractor/types.js';

/**
 * V2-1: the language-agnostic half of call edges — the disambiguation
 * cascade (import resolution → same-file uniqueness → global-name
 * uniqueness → no edge, ADR-0004) and the changed-since-baseline set
 * Ripple propagates from. Edge cases here are pinned against synthetic
 * caches so each cascade step is isolated from real parsing.
 */

const SIG_A = 'a'.repeat(16);
const SIG_B = 'b'.repeat(16);
const BODY_A = 'c'.repeat(16);
const BODY_B = 'd'.repeat(16);

function sym(file: string, name: string, signature = SIG_A, body = BODY_A): SymbolRecord {
  return {
    id: `${file}#${name}@0`,
    name,
    kind: 'function',
    file,
    signature: { start: 0, end: 1, row: 0, col: 0 },
    body: { start: 1, end: 2, row: 1, col: 0 },
    visibility: 'public',
    fingerprint: { signature, body },
  };
}

function cache(files: Record<string, { symbols?: SymbolRecord[]; refs?: FileRefs }>): CacheData {
  const out: CacheData['files'] = {};
  for (const [file, entry] of Object.entries(files)) {
    out[file] = { hash: 'h', symbols: entry.symbols ?? [], refs: entry.refs ?? noRefs() };
  }
  return { version: 3, files: out };
}

/** Edge view keyed `caller → callees`, skipping empty callers. */
function edgesOf(cache: CacheData): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [caller, callees] of resolveEdges(cache)) {
    if (callees.length > 0) out[caller] = callees;
  }
  return out;
}

describe('resolveEdges — the ADR-0004 cascade', () => {
  it('resolves an imported name to the target file, by alias and across a .js specifier', () => {
    const c = cache({
      'src/greet.ts': {
        symbols: [sym('src/greet.ts', 'fn')],
        refs: {
          imports: {
            helper: { imported: 'helper', source: './helper' },
            h: { imported: 'helper', source: './helper.js' }, // ESM-style specifier for a .ts file
          },
          callers: { fn: ['helper', 'h'] },
        },
      },
      'src/helper.ts': { symbols: [sym('src/helper.ts', 'helper')] },
    });
    expect(edgesOf(c)).toEqual({ 'src/greet.ts#fn': ['src/helper.ts#helper'] });
  });

  it('never falls through when the name is claimed by an unresolvable import', () => {
    // package import, default import, and a relative path that matches no
    // indexed file: all three claim the name, so same-file/global guesses
    // are forbidden — a false edge is never tolerated (ADR-0004)
    const c = cache({
      'src/greet.ts': {
        symbols: [sym('src/greet.ts', 'fn'), sym('src/greet.ts', 'sameFilePick')],
        refs: {
          imports: {
            fromPkg: { imported: 'x', source: 'some-package' },
            def: { imported: '', source: './helper' },
            missing: { imported: 'helper', source: './no-such-file' },
          },
          callers: { fn: ['fromPkg', 'def', 'missing', 'sameFilePick'] },
        },
      },
      'src/other.ts': {
        symbols: [sym('src/other.ts', 'x'), sym('src/other.ts', 'helper')],
      },
    });
    // only the unambiguous same-file call survives
    expect(edgesOf(c)).toEqual({ 'src/greet.ts#fn': ['src/greet.ts#sameFilePick'] });
  });

  it('same-file uniqueness wins over same-named symbols elsewhere', () => {
    const c = cache({
      'src/greet.ts': {
        symbols: [sym('src/greet.ts', 'fn'), sym('src/greet.ts', 'helper')],
        refs: { imports: {}, callers: { fn: ['helper'] } },
      },
      'src/other.ts': { symbols: [sym('src/other.ts', 'helper')] },
    });
    expect(edgesOf(c)).toEqual({ 'src/greet.ts#fn': ['src/greet.ts#helper'] });
  });

  it('a globally unique name resolves when the file has none of its own', () => {
    const c = cache({
      'src/greet.ts': {
        symbols: [sym('src/greet.ts', 'fn')],
        refs: { imports: {}, callers: { fn: ['helper'] } },
      },
      'src/helper.ts': { symbols: [sym('src/helper.ts', 'helper')] },
    });
    expect(edgesOf(c)).toEqual({ 'src/greet.ts#fn': ['src/helper.ts#helper'] });
  });

  it('an ambiguous name yields no edge — same-file duplication and global collision', () => {
    const c = cache({
      'src/greet.ts': {
        symbols: [sym('src/greet.ts', 'fn'), sym('src/greet.ts', 'dup'), sym('src/greet.ts', 'dup')],
        refs: { imports: {}, callers: { fn: ['dup', 'global'] } },
      },
      'src/a.ts': { symbols: [sym('src/a.ts', 'global')] },
      'src/b.ts': { symbols: [sym('src/b.ts', 'global')] },
    });
    expect(edgesOf(c)).toEqual({});
  });

  it('a bare name never crosses languages — another language is no candidate at all', () => {
    // `javaOnly` exists, globally unique, but behind the Java extractor:
    // no edge from a TS call site, and a same-named Java symbol does not
    // make an in-language unique name ambiguous either
    const c = cache({
      'src/greet.ts': {
        symbols: [sym('src/greet.ts', 'fn'), sym('src/greet.ts', 'shared')],
        refs: { imports: {}, callers: { fn: ['javaOnly', 'shared'] } },
      },
      'src/Greet.java': {
        symbols: [sym('src/Greet.java', 'javaOnly'), sym('src/Greet.java', 'shared')],
      },
    });
    expect(edgesOf(c)).toEqual({ 'src/greet.ts#fn': ['src/greet.ts#shared'] });
  });

  it('resolves directory imports through index files and skips unknown names entirely', () => {
    const c = cache({
      'src/greet.ts': {
        symbols: [sym('src/greet.ts', 'fn')],
        refs: { imports: { helper: { imported: 'helper', source: './util' } }, callers: { fn: ['helper', 'ghost'] } },
      },
      'src/util/index.ts': { symbols: [sym('src/util/index.ts', 'helper')] },
    });
    expect(edgesOf(c)).toEqual({ 'src/greet.ts#fn': ['src/util/index.ts#helper'] });
  });
});

describe('changedSince — the cache baseline', () => {
  it('marks body change drift, signature change and deletion broken', () => {
    const prev = cache({
      'src/a.ts': {
        symbols: [sym('src/a.ts', 'bodyEdit', SIG_A, BODY_A), sym('src/a.ts', 'sigEdit', SIG_A, BODY_A), sym('src/a.ts', 'gone')],
      },
    });
    const curr = cache({
      'src/a.ts': {
        symbols: [sym('src/a.ts', 'bodyEdit', SIG_A, BODY_B), sym('src/a.ts', 'sigEdit', SIG_B, BODY_A), sym('src/a.ts', 'added')],
      },
    });
    expect(changedSince(prev, curr)).toEqual(
      new Map([
        ['src/a.ts#bodyEdit', 'drift'],
        ['src/a.ts#sigEdit', 'broken'],
        ['src/a.ts#gone', 'broken'],
      ]),
    );
  });

  it('is empty without a previous cache (fresh-clone first run is ripple-silent) and when nothing moved', () => {
    const curr = cache({ 'src/a.ts': { symbols: [sym('src/a.ts', 'fn')] } });
    expect(changedSince(undefined, curr)).toEqual(new Map());
    expect(changedSince(curr, curr)).toEqual(new Map());
  });
});
