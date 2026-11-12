import { describe, it, expect } from 'vitest';
import { changedSince, resolveEdges, ripplesUnder } from '../src/ripple.js';
import type { CacheData } from '../src/cache.js';
import type { ChangeMap, EdgeMap } from '../src/ripple.js';
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
  return { version: 4, files: out };
}

/** Edge view keyed `caller → callees`, skipping empty callers. */
function edgesOf(cache: CacheData): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [caller, callees] of resolveEdges(cache)) {
    if (callees.length > 0) out[caller] = callees;
  }
  return out;
}

/** An edge map built directly: `a → b` means a calls b. */
function edges(pairs: [string, string][]): EdgeMap {
  const map: EdgeMap = new Map();
  for (const [caller, callee] of pairs) {
    map.set(caller, [...(map.get(caller) ?? []), callee].sort());
  }
  return map;
}

/** A change map built directly: `key → state`. */
function changes(pairs: [string, 'broken' | 'drift'][]): ChangeMap {
  return new Map(pairs);
}

describe('resolveEdges — the ADR-0004 cascade', () => {
  it('resolves an imported name to the target file, by alias and across a .js specifier', () => {
    const c = cache({
      'src/greet.ts': {
        symbols: [sym('src/greet.ts', 'fn')],
        refs: {
          imports: {
            helper: { kind: 'named', imported: 'helper', source: './helper' },
            h: { kind: 'named', imported: 'helper', source: './helper.js' }, // ESM-style specifier for a .ts file
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
            fromPkg: { kind: 'named', imported: 'x', source: 'some-package' },
            def: { kind: 'default', source: './helper' },
            missing: { kind: 'named', imported: 'helper', source: './no-such-file' },
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
        refs: { imports: { helper: { kind: 'named', imported: 'helper', source: './util' } }, callers: { fn: ['helper', 'ghost'] } },
      },
      'src/util/index.ts': { symbols: [sym('src/util/index.ts', 'helper')] },
    });
    expect(edgesOf(c)).toEqual({ 'src/greet.ts#fn': ['src/util/index.ts#helper'] });
  });

  it('resolves a package-path source (Java form) by unique indexed-file suffix', () => {
    // demo/other/Base.java matches src/main/java/demo/other/Base.java —
    // the package root is whatever the repo's layout happens to be
    const c = cache({
      'src/Greeter.java': {
        symbols: [sym('src/Greeter.java', 'greet')],
        refs: { imports: { Base: { kind: 'named', imported: 'Base', source: 'demo/other/Base.java' } }, callers: { greet: ['Base'] } },
      },
      'src/main/java/demo/other/Base.java': { symbols: [sym('src/main/java/demo/other/Base.java', 'Base')] },
    });
    expect(edgesOf(c)).toEqual({ 'src/Greeter.java#greet': ['src/main/java/demo/other/Base.java#Base'] });
  });

  it('an external library (no suffix match) claims the name — never falls through to global guesses', () => {
    const c = cache({
      'src/Greeter.java': {
        symbols: [sym('src/Greeter.java', 'greet')],
        refs: { imports: { List: { kind: 'named', imported: 'List', source: 'java/util/List.java' } }, callers: { greet: ['List'] } },
      },
      'src/other/List.java': { symbols: [sym('src/other/List.java', 'List')] },
    });
    expect(edgesOf(c)).toEqual({});
  });

  it('two files matching the same package path, or the name absent from the match, yield no edge', () => {
    const c = cache({
      'src/A.java': {
        symbols: [sym('src/A.java', 'fn')],
        refs: {
          imports: {
            Base: { kind: 'named', imported: 'Base', source: 'demo/other/Base.java' }, // two matches below
            Ifc: { kind: 'named', imported: 'Ifc', source: 'demo/other/Ifc.java' },    // matched file lacks the name
          },
          callers: { fn: ['Base', 'Ifc'] },
        },
      },
      'src/main/demo/other/Base.java': { symbols: [sym('src/main/demo/other/Base.java', 'Base')] },
      'src/test/demo/other/Base.java': { symbols: [sym('src/test/demo/other/Base.java', 'Base')] },
      'src/main/demo/other/Ifc.java': { symbols: [sym('src/main/demo/other/Ifc.java', 'Unrelated')] },
    });
    expect(edgesOf(c)).toEqual({});
  });

  it('a bare package specifier is ignored even when its path happens to suffix-match a file', () => {
    // TS/JS form: `import { x } from 'pkg/sub.js'` — non-relative and
    // not a .java package path, so no suffix match, no fall-through
    const c = cache({
      'src/greet.ts': {
        symbols: [sym('src/greet.ts', 'fn')],
        refs: { imports: { x: { kind: 'named', imported: 'x', source: 'pkg/sub.js' } }, callers: { fn: ['x'] } },
      },
      'src/pkg/sub.js': { symbols: [sym('src/pkg/sub.js', 'x')] },
    });
    expect(edgesOf(c)).toEqual({});
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

describe('ripplesUnder — reverse reachability from the change set', () => {
  const A = 'src/chain.ts#a';
  const B = 'src/mid.ts#mid';
  const C = 'src/leaf.ts#leaf';

  it('propagates through any depth: the top anchor names the middle symbol, depth 2', () => {
    const under = ripplesUnder(edges([[A, B], [B, C]]), changes([[C, 'drift']]));
    expect(under.get(A)).toEqual([{ symbol: C, state: 'drift', via: B, depth: 2 }]);
    // the middle symbol is rippled too, one hop closer
    expect(under.get(B)).toEqual([{ symbol: C, state: 'drift', via: C, depth: 1 }]);
    // the changed symbol itself is not rippled by its own change
    expect(under.get(C)).toBeUndefined();
  });

  it('a broken callee propagates exactly like a drift', () => {
    const under = ripplesUnder(edges([[A, B], [B, C]]), changes([[C, 'broken']]));
    expect(under.get(A)).toEqual([{ symbol: C, state: 'broken', via: B, depth: 2 }]);
  });

  it('keeps the shortest path when several lead to the same stale callee', () => {
    // a calls b and c; b also calls c — c's change reaches a directly
    const under = ripplesUnder(edges([[A, B], [A, C], [B, C]]), changes([[C, 'drift']]));
    expect(under.get(A)).toEqual([{ symbol: C, state: 'drift', via: C, depth: 1 }]);
  });

  it('survives caller cycles without rippling a symbol by its own change', () => {
    // mutual recursion: a calls b, b calls a — b's change ripples a, depth 1
    const under = ripplesUnder(edges([[A, B], [B, A]]), changes([[B, 'drift']]));
    expect(under.get(A)).toEqual([{ symbol: B, state: 'drift', via: B, depth: 1 }]);
    expect(under.get(B)).toBeUndefined();
  });

  it('merges several changed callees per anchor, sorted by symbol', () => {
    const under = ripplesUnder(edges([[A, C], [A, B]]), changes([
      [C, 'drift'],
      [B, 'broken'],
    ]));
    // 'src/leaf…' sorts before 'src/mid…'
    expect(under.get(A)).toEqual([
      { symbol: C, state: 'drift', via: C, depth: 1 },
      { symbol: B, state: 'broken', via: B, depth: 1 },
    ]);
  });

  it('is empty with no changes or no edges', () => {
    expect(ripplesUnder(new Map(), changes([[C, 'drift']]))).toEqual(new Map());
    expect(ripplesUnder(edges([[A, B]]), new Map())).toEqual(new Map());
  });
});
